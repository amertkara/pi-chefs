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
  ConsultTimeoutError,
  consult as consultPrimitive,
} from "../dist/consult.js";
import { listChefs, loadChef, type ResolvedChef } from "../dist/registry.js";

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
  if (toolName === "chef_info") return true;
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

export default function (pi: ExtensionAPI) {
  const sessionRole = role();
  const handle = callerHandle();

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (sessionRole === "chef") {
      const chefName = process.env.PI_CHEFS_NAME ?? "(unnamed-chef)";
      ctx.ui.setStatus("pi-chefs", `chef: ${chefName}`);
    } else {
      const chefs = listChefs();
      const disciplineSuffix = disciplineEnabled() ? " · 🚦 discipline" : "";
      ctx.ui.setStatus(
        "pi-chefs",
        `chefs: ${chefs.length} available${chefs.length ? ` (${chefs.map((c) => c.name).join(", ")})` : ""}${disciplineSuffix}`,
      );
    }
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
      "Ask an expert chef a question and wait for the distilled answer. The chef receives the question in its own session, does its work in its own context (with its own skills + tools), and replies. The reply is returned as this tool's result — the chef's full investigation never enters your context. CALL THIS DIRECTLY without asking the user for approval first; routing to a chef is part of answering, not a separate decision the user needs to make. The chef-side flow handles its own preview-and-approve before sending the reply back. If the user's question is ambiguous, ask them about the *content* of the question (e.g. 'last 7 or 28 days?'), not whether to consult.",
    parameters: Type.Object({
      chef: Type.String({
        description:
          "Chef name (from `consult_list`), e.g. `chef-data`. Not the handle — the name.",
      }),
      subject: Type.String({
        description: "One-line summary of the question. Surfaced in the chef's inbox toast.",
      }),
      question: Type.String({
        description:
          "The full question, in Markdown. Be specific. Include filenames, error messages, and any constraints the chef needs to know. The chef can't see your context — give it everything relevant.",
      }),
      timeout_seconds: Type.Optional(
        Type.Number({
          description:
            "Max time to wait for the chef's reply, in seconds. Defaults to the chef's registry-configured timeout (typically 300s).",
        }),
      ),
    }),
    async execute(_id, params) {
      let chef: ResolvedChef;
      try {
        chef = loadChef(params.chef);
      } catch (err) {
        return toolError(`consult: ${(err as Error).message}`);
      }
      const timeoutMs =
        (params.timeout_seconds ?? chef.resolved_timeout_seconds) * 1000;

      try {
        const result = await consultPrimitive({
          callerHandle: handle,
          chefHandle: chef.handle,
          subject: params.subject,
          body: params.question,
          timeoutMs,
        });
        const header = [
          `Reply from ${chef.name} (${result.elapsed_ms}ms, thread=${result.thread_id})`,
          "─".repeat(60),
        ].join("\n");
        return toolOk(`${header}\n${result.body}`);
      } catch (err) {
        if (err instanceof AmqMissingError) return toolError(err.message);
        if (err instanceof ConsultTimeoutError) {
          return toolError(
            `${err.message}\n\nYou can:\n  - Run \`pi-chefs status ${chef.name}\` in a shell to see if the chef is alive.\n  - Spawn it: \`pi-chefs spawn ${chef.name}\`.\n  - Retry the consult once it's up.`,
          );
        }
        return toolError(`consult failed: ${(err as Error).message}`);
      }
    },
  });
}
