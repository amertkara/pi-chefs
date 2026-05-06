/**
 * pi-chefs — Pi extension that lets a caller agent consult expert chefs.
 *
 * Companion to pi-postman. Where pi-postman is fire-and-forget transport,
 * pi-chefs adds request/response semantics: the caller sends a question to a
 * named chef and *waits* for the reply on the same thread before returning a
 * tool result. This means the caller doesn't have to manage threads, inbox
 * polling, or correlation by hand — it just calls `consult` and gets the
 * distilled answer back.
 *
 * Two roles for this extension:
 *
 * 1. **Caller-side.** Registers the `consult` tool. The caller agent
 *    discovers available chefs via `consult_list` and asks one of them via
 *    `consult`. The chef's reply is returned as the tool result so it lands
 *    in the caller's context as a single distilled summary.
 *
 * 2. **Chef-side.** When the extension is loaded inside a chef session
 *    (detected via PI_CHEFS_ROLE=chef), it surfaces `chef_info` so the chef
 *    can reflect on its own persona/domain, and it relies on pi-postman
 *    (with PI_POSTMAN_AUTO_REACT=1) for inbound message reaction. It does
 *    NOT register `consult` — chefs shouldn't recursively consult each other
 *    in v1.
 *
 * Configuration via env:
 *   PI_CHEFS_ROLE      — "caller" (default) or "chef"
 *   PI_CHEFS_HOME      — override default ~/.pi/chefs/ root
 *   PI_CHEFS_NAME      — chef-side only: name of this chef (used to load
 *                         registry/persona for `chef_info`)
 *   PI_CHEFS_HANDLE    — chef-side only: handle this chef uses (used for
 *                         consistency checks against pi-postman's handle)
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
// Extension is loaded by Pi (via jiti) which handles TS itself, but the same
// source modules are also imported by the Node-executed CLI. Both go through
// the compiled dist/ output (with .d.ts alongside) so we have one source of
// truth and don't have to rely on jiti to walk into our own src/.
import {
  AmqMissingError,
  consultSend,
  watchConsultReplies,
  type ConsultReplyEvent,
  type ConsultReplyWatcherCloser,
} from "../dist/consult.js";
import { listChefs, loadChef, type ResolvedChef } from "../dist/registry.js";
import {
  CreateChefAlreadyExistsError,
  CreateChefValidationError,
  createChef,
  detectInstalledSkills,
} from "../dist/create-chef.js";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function role(): "caller" | "chef" {
  const raw = process.env.PI_CHEFS_ROLE?.trim().toLowerCase();
  return raw === "chef" ? "chef" : "caller";
}

/**
 * Discipline mode: when PI_CHEFS_DISCIPLINE is set to a truthy value, the
 * extension blocks any tool call NOT in the allowlist below. Default off —
 * the extension is invisible unless explicitly enabled.
 *
 * The allowlist is hardcoded for v1 (read-only inspection + framework tools).
 * If users need a custom allowlist later, we'll read from caller.yaml.
 */
function disciplineEnabled(): boolean {
  const raw = process.env.PI_CHEFS_DISCIPLINE;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

// Tools allowed even when discipline is on.
//   - Read-only file inspection (read, grep, find, ls).
//   - Pi's bash tool (because consult-prep often involves "check what's in
//     this file" — if you want bash blocked too, add PI_CHEFS_DISCIPLINE_STRICT).
//   - All postman_* tools (transport for consults).
//   - All consult_* tools and chef_info (this extension's own surface).
const DISCIPLINE_ALLOWED_BUILTINS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
]);
function isDisciplineAllowedTool(toolName: string): boolean {
  if (DISCIPLINE_ALLOWED_BUILTINS.has(toolName)) return true;
  if (toolName.startsWith("postman_")) return true;
  if (toolName.startsWith("consult")) return true;
  // All chef_* are framework tools (chef_info, chef_create, chef_spawn).
  // They're how Pi materializes and inspects chefs from inside a session;
  // blocking them defeats the agent-driven creation flow.
  if (toolName.startsWith("chef_")) return true;
  return false;
}

function callerHandle(): string {
  // Reuse pi-postman's handle resolution: PI_POSTMAN_HANDLE > AM_ME > pi-<cwd>.
  const explicit = process.env.PI_POSTMAN_HANDLE ?? process.env.AM_ME;
  if (explicit && /^[a-z0-9_-]+$/.test(explicit)) return explicit;
  // Fall back to a cwd-derived handle. Mirrors pi-postman's deriveHandle
  // logic but kept independent so pi-chefs doesn't import from pi-postman.
  const base = (process.cwd().split("/").pop() ?? "pi")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "pi";
  return base.startsWith("pi-") ? base : `pi-${base}`;
}

function toolOk(text: string): AgentToolResult<undefined> {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

function toolError(text: string): AgentToolResult<undefined> {
  // No isError field in this AgentToolResult shape — errors are signaled via
  // the text body. Prefix with 'Error:' so the model recognizes failure.
  return {
    content: [{ type: "text" as const, text: text.startsWith("Error:") ? text : `Error: ${text}` }],
    details: undefined,
  };
}

function describeChef(chef: ResolvedChef): string {
  const desc = chef.description ?? chef.domain.split("\n")[0];
  return `• ${chef.name} (handle: ${chef.handle}) — ${desc?.trim()}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────────────

// Resolve AMQ root the same way the consult primitive does. Used to scan
// chef inboxes at session_start for unread mail.
function amqRoot(): string {
  return process.env.AM_ROOT ?? process.env.AMQ_GLOBAL_ROOT ?? join(homedir(), ".agent-mail");
}
function inboxNewDir(h: string): string {
  return join(amqRoot(), "agents", h, "inbox", "new");
}

export default function (pi: ExtensionAPI) {
  const sessionRole = role();
  const handle = callerHandle();

  // Caller-mode: long-running fs.watch that injects each consult reply into
  // the agent's session as a user message. The agent reacts to the injection
  // (sees subject + body), correlates by thread id, and responds to the user.
  // Cleaned up at session_shutdown.
  let replyWatcher: ConsultReplyWatcherCloser | undefined;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (sessionRole === "chef") {
      const chefName = process.env.PI_CHEFS_NAME ?? "(unnamed-chef)";
      ctx.ui.setStatus("pi-chefs", `chef: ${chefName}`);

      // On chef startup: drain any unread mail. pi-postman's watcher seeds
      // its `seen` set at session_start to avoid notifying on historical
      // mail — correct for callers, wrong for chefs (unread mail IS work).
      // Inject a user message listing what's pending so the agent calls
      // postman_inbox and addresses each one.
      try {
        const unread = readdirSync(inboxNewDir(handle))
          .filter((f) => f.endsWith(".md"))
          .sort();
        if (unread.length > 0) {
          const promptLines = [
            `📬 You have ${unread.length} unread message${unread.length === 1 ? "" : "s"} in your inbox from before this session started.`,
            "",
            "Call `postman_inbox` to list them, then `postman_read id=\"<id>\"` for each. After you've understood the question, do whatever investigation it needs and reply via `postman_reply`.",
          ];
          try {
            const result = pi.sendUserMessage(promptLines.join("\n"), {
              deliverAs: "followUp",
            }) as unknown as Promise<void> | void;
            if (result && typeof (result as Promise<void>).then === "function") {
              (result as Promise<void>).catch(() => {});
            }
          } catch {
            // sendUserMessage not available in this Pi build — fall back to a toast.
            ctx.ui.notify(
              `pi-chefs: ${unread.length} unread message(s) in inbox. Run \`postman_inbox\` to drain.`,
              "info",
            );
          }
        }
      } catch {
        // No inbox dir yet — fine, nothing to drain.
      }
      return;
    }

    // Caller-mode footer + reply watcher.
    const chefs = listChefs();
    const disciplineSuffix = disciplineEnabled() ? " · 🚦 discipline" : "";
    ctx.ui.setStatus(
      "pi-chefs",
      `chefs: ${chefs.length} available${chefs.length ? ` (${chefs.map((c) => c.name).join(", ")})` : ""}${disciplineSuffix}`,
    );

    // Start the consult-reply watcher. Each reply that lands on a thread
    // starting with `chefs/` gets injected into the session as a user message.
    replyWatcher = watchConsultReplies({
      callerHandle: handle,
      onReply: (event: ConsultReplyEvent) => {
        const lines = [
          `📬 Reply from ${event.chef_handle} to your consult:`,
          `  thread:  ${event.thread_id}`,
          `  subject: ${event.subject}`,
          "",
          event.body,
        ];
        try {
          const result = pi.sendUserMessage(lines.join("\n"), {
            deliverAs: "followUp",
          }) as unknown as Promise<void> | void;
          if (result && typeof (result as Promise<void>).then === "function") {
            (result as Promise<void>).catch((err: Error) => {
              ctx.ui.notify(
                `pi-chefs: failed to inject consult reply: ${err.message}`,
                "warning",
              );
            });
          }
          ctx.ui.notify(
            `✅ Reply from ${event.chef_handle}: ${event.subject}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(
            `pi-chefs: failed to inject consult reply: ${(err as Error).message}`,
            "warning",
          );
        }
      },
      onError: (err: Error) => {
        ctx.ui.notify(`pi-chefs reply watcher error: ${err.message}`, "warning");
      },
    });
  });

  // ──────────── discipline guard (caller-mode only, opt-in) ────────────
  //
  // When PI_CHEFS_DISCIPLINE is set, intercept every outbound tool call. If
  // the tool isn't in the allowlist, block it and explain why. The agent gets
  // a tool result like:
  //   "Discipline mode is on. <tool> is restricted. Use consult_list ..."
  // ...which it sees as a normal tool failure and re-plans accordingly.
  //
  // No skill removal, no relaunch, no special launcher. Set the env var in
  // any tab where you want chefs to handle the heavy lifting; unset it
  // (or never set it) for normal full-power Pi.
  if (sessionRole === "caller" && disciplineEnabled()) {
    pi.on("tool_call", (event) => {
      const toolName = event.toolName;
      if (isDisciplineAllowedTool(toolName)) return;
      return {
        block: true,
        reason:
          `Discipline mode is on (PI_CHEFS_DISCIPLINE=1). The \`${toolName}\` tool is ` +
          `restricted in this session because it likely belongs to a domain a chef ` +
          `should handle. Call \`consult_list\` first to see if a chef covers this ` +
          `domain; if yes, send the question via \`consult\`. If no chef covers it ` +
          `and you genuinely need this tool, ask the user to unset PI_CHEFS_DISCIPLINE ` +
          `or to spawn a chef whose domain includes \`${toolName}\`.`,
      };
    });
  }

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    if (replyWatcher) replyWatcher.close();
    if (ctx.hasUI) ctx.ui.setStatus("pi-chefs", undefined);
  });

  // ──────────── chef-side tools ────────────

  if (sessionRole === "chef") {
    pi.registerTool({
      name: "chef_info",
      label: "Chef: Self-info",
      description:
        "Show this chef's own registry entry — name, handle, domain, allowed skills/tools, persona excerpt. Use to remind yourself of your scope when a question arrives.",
      parameters: Type.Object({}),
      async execute() {
        const name = process.env.PI_CHEFS_NAME;
        if (!name) {
          return toolError(
            "chef_info: PI_CHEFS_NAME not set. This session was started outside `pi-chefs spawn` and has no registry entry.",
          );
        }
        try {
          const chef = loadChef(name);
          const lines = [
            `name:           ${chef.name}`,
            `handle:         ${chef.handle}`,
            `cwd:            ${chef.resolved_cwd}`,
            `skills_allowed: ${chef.skills_allowed.join(", ") || "(none)"}`,
            `tools_allowed:  ${chef.tools_allowed.join(", ") || "(none)"}`,
            `timeout:        ${chef.resolved_timeout_seconds}s`,
            "",
            "domain:",
            chef.domain.trim(),
            "",
            `persona file: ${chef.persona_path}`,
          ];
          return toolOk(lines.join("\n"));
        } catch (err) {
          return toolError(`chef_info failed: ${(err as Error).message}`);
        }
      },
    });
    return;
  }

  // ──────────── caller-side tools ────────────

  pi.registerTool({
    name: "consult_list",
    label: "Chefs: List",
    description:
      "List available chefs (long-running expert Pi sessions you can consult). Returns each chef's name, handle, and one-line domain summary. Call this before `consult` so you know which chef to ask.",
    parameters: Type.Object({}),
    async execute() {
      const chefs = listChefs();
      if (chefs.length === 0) {
        return toolOk(
          "No chefs registered. Add a YAML entry under ~/.pi/chefs/registry/ or use one of the bundled chefs in this repo's registry/ dir.",
        );
      }
      const lines = chefs.map(describeChef);
      return toolOk(`${chefs.length} chef(s) available:\n\n${lines.join("\n")}`);
    },
  });

  pi.registerTool({
    name: "consult",
    label: "Chefs: Consult",
    description:
      "Send a question to an expert chef. **Returns immediately** with a thread id; the chef's reply arrives asynchronously as a user message injected into your session (you'll see '📬 Reply from <chef>...' in the next turn). CALL THIS DIRECTLY without asking the user for approval first; routing to a chef is part of answering, not a separate decision. After calling consult, you can either wait for the reply (the user can ask 'any reply yet?') or proceed with other work — when the reply lands, a new turn is automatically triggered with the chef's answer. The chef does its work in its own context with its own skills + tools, and never sends its full investigation back — only the distilled answer.",
    parameters: Type.Object({
      chef: Type.String({
        description:
          "Chef name (from `consult_list`), e.g. `data-chef`. Not the handle — the name.",
      }),
      subject: Type.String({
        description: "One-line summary of the question. Surfaced in the chef's inbox toast.",
      }),
      question: Type.String({
        description:
          "The full question, in Markdown. Be specific. Include filenames, error messages, and any constraints the chef needs to know. The chef can't see your context — give it everything relevant.",
      }),
    }),
    async execute(_id, params) {
      let chef: ResolvedChef;
      try {
        chef = loadChef(params.chef);
      } catch (err) {
        return toolError(`consult: ${(err as Error).message}`);
      }

      try {
        const sent = await consultSend({
          callerHandle: handle,
          chefHandle: chef.handle,
          subject: params.subject,
          body: params.question,
        });
        const lines = [
          `✉️  Sent to ${chef.name} (handle: ${chef.handle}).`,
          `   thread:     ${sent.thread_id}`,
          `   message_id: ${sent.message_id}`,
          `   sent_at:    ${sent.sent_at.toISOString()}`,
          "",
          `The chef's reply will be injected into this session as a user message when it arrives — you'll see a '📬 Reply from ${chef.handle}...' prompt and a new turn will kick off automatically. No need to poll or wait synchronously.`,
        ];
        return toolOk(lines.join("\n"));
      } catch (err) {
        if (err instanceof AmqMissingError) return toolError(err.message);
        return toolError(`consult failed: ${(err as Error).message}`);
      }
    },
  });

  // ──────────── chef_create: agent-driven chef materialization ────────────
  pi.registerTool({
    name: "chef_create",
    label: "Chefs: Create",
    description:
      "Create a new chef registry entry and persona file. Use this when no existing chef covers a domain the user wants — negotiate name + domain + persona with the user, then call this tool to materialize it. After creation, run `chef_spawn` to launch it. Detects skills already installed under ~/.pi/agent/skills/ and surfaces them so you can suggest which to allow. PREVIEW the proposed chef config (especially name + description + domain) to the user before calling this tool. Refuses to overwrite by default; pass force: true if the user explicitly approves replacing an existing chef.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Chef name, lowercase, [a-z0-9_-]+. Becomes the registry filename. Convention: <domain>-chef or chef-<domain> (e.g. observe-chef, chef-rails).",
      }),
      handle: Type.Optional(
        Type.String({
          description: "AMQ handle. Defaults to the name. Must match [a-z0-9_-]+.",
        }),
      ),
      description: Type.String({
        description:
          "One-line summary surfaced in `consult_list` and `pi-chefs list`. E.g. 'Observability expert: logs, metrics, traces, errors.'",
      }),
      domain: Type.String({
        description:
          "Multi-line description of what's in scope and what isn't. The chef's persona reads this. Be specific. Include: 'Use me for X, Y, Z. Don't ask me about A or B — those belong to <other-chef>.'",
      }),
      persona: Type.Optional(
        Type.String({
          description:
            "Optional full persona Markdown. If omitted, a stub is auto-generated from the domain. Override only if the user wants something custom; the stub usually suffices.",
        }),
      ),
      skills_allowed: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Skill names from ~/.pi/agent/skills/ (e.g. ['data-portal', 'pi-postman']) or absolute paths. Empty array is fine — most chefs rely on Pi's auto-loaded extensions, not skills. Skills_allowed is enforced via Pi's --no-skills + --skill <abs-path> at spawn time.",
        }),
      ),
      tools_allowed: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Tool allowlist. Advisory in v0.6+; not enforced at spawn time (chef gets all extension + builtin tools). Retained for grep-ability. Pass [] or omit.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Chef session cwd. Defaults to ~. Use ~/path or absolute path.",
        }),
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Consult timeout in seconds. Defaults to 300.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite an existing chef with the same name. Default false. Only set after the user explicitly approves replacement.",
        }),
      ),
    }),
    async execute(_id, params) {
      try {
        const result = createChef({
          name: params.name,
          handle: params.handle,
          description: params.description,
          domain: params.domain,
          persona: params.persona,
          skills_allowed: params.skills_allowed,
          tools_allowed: params.tools_allowed,
          cwd: params.cwd,
          timeout_seconds: params.timeout_seconds,
          force: params.force,
        });
        const lines = [
          `✅ Chef "${params.name}" ${result.overwrote ? "replaced" : "created"}.`,
          `   registry: ${result.registry_path}`,
          `   persona:  ${result.persona_path}`,
          "",
          `Spawn it with: chef_spawn name="${params.name}"`,
          `Or from a shell: pi-chefs spawn ${params.name}`,
          "",
          `Detected skills available on this machine (${detectInstalledSkills().length}): ${detectInstalledSkills().join(", ") || "(none)"}`,
        ];
        return toolOk(lines.join("\n"));
      } catch (err) {
        if (err instanceof CreateChefValidationError) {
          return toolError(err.message);
        }
        if (err instanceof CreateChefAlreadyExistsError) {
          return toolError(
            `${err.message}\n\nIf the user wants to replace it, call chef_create again with force: true.`,
          );
        }
        return toolError(`chef_create failed: ${(err as Error).message}`);
      }
    },
  });

  // ──────────── chef_spawn: agent-driven chef launch ────────────
  //
  // We can't actually spawn a Pi session from inside another Pi session
  // (no AppleScript/tmux orchestration in v1; that risks fragility across
  // user setups). Instead we print the exact command for the user to run.
  // The user copy-pastes once. Future: if Pi adds a 'launch sibling tab'
  // primitive, switch to that.
  pi.registerTool({
    name: "chef_spawn",
    label: "Chefs: Spawn",
    description:
      "Show the user the command to spawn a chef in a new terminal tab. The chef must already exist (run chef_create first if not). Returns the exact `pi-chefs spawn <name>` command line, including any PI_CHEFS_PI_BIN env override the user has set. The user copy-pastes once and the chef boots; pi-chefs cannot launch a sibling Pi session from inside this one.",
    parameters: Type.Object({
      name: Type.String({
        description: "Chef name (must already exist in the registry).",
      }),
    }),
    async execute(_id, params) {
      let chef: ResolvedChef;
      try {
        chef = loadChef(params.name);
      } catch (err) {
        return toolError(`chef_spawn: ${(err as Error).message}`);
      }
      const piBin = process.env.PI_CHEFS_PI_BIN;
      const prefix = piBin ? `PI_CHEFS_PI_BIN="${piBin}" ` : "";
      const lines = [
        `Run this in a new terminal tab to spawn ${chef.name}:`,
        "",
        `  ${prefix}pi-chefs spawn ${chef.name}`,
        "",
        `Once it's running, you can immediately consult it with:`,
        `  consult chef="${chef.name}" subject="..." question="..."`,
        "",
        `(The chef sits at handle "${chef.handle}" with cwd ${chef.resolved_cwd}.)`,
      ];
      return toolOk(lines.join("\n"));
    },
  });
}
