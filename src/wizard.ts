/**
 * `pi-chefs init` wizard. Walks the user through creating a new chef registry
 * entry + persona stub interactively, with sensible defaults and live
 * detection of skills already installed on this machine.
 *
 * The wizard never touches the bundled `registry/` or `personas/` dirs; it
 * always writes to the user's `$PI_CHEFS_HOME` (default `~/.pi/chefs/`).
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface, type Interface as Readline } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stringify as yamlStringify } from "yaml";
import { callerConfigFile, userPersonasDir, userRegistryDir } from "./paths.ts";
import { createChef, CreateChefAlreadyExistsError } from "./create-chef.ts";

const HANDLE_RE = /^[a-z0-9_-]+$/;
// Pi's built-in core tools — always available regardless of extension setup.
const DEFAULT_BUILTIN_TOOLS = ["bash", "read", "write", "edit", "find", "grep", "ls"];
// Recommended tool allowlist for a freshly-spawned chef.
const RECOMMENDED_TOOLS = ["bash", "read"];

interface WizardAnswers {
  name: string;
  handle: string;
  description: string;
  domain: string;
  skills_allowed: string[];
  tools_allowed: string[];
  cwd: string;
  timeout_seconds: number;
}

function detectInstalledSkills(): string[] {
  const skillsDir = join(homedir(), ".pi", "agent", "skills");
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

async function ask(rl: Readline, prompt: string, fallback?: string): Promise<string> {
  const suffix = fallback === undefined ? "" : ` [${fallback}]`;
  const raw = await rl.question(`${prompt}${suffix}: `);
  const trimmed = raw.trim();
  if (trimmed) return trimmed;
  if (fallback !== undefined) return fallback;
  return "";
}

async function askMultiline(rl: Readline, prompt: string): Promise<string> {
  console.log(`${prompt} (multi-line; end with an empty line):`);
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("  ");
    if (line.trim() === "") break;
    lines.push(line);
  }
  return lines.join("\n");
}

async function askYesNo(rl: Readline, prompt: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = (await rl.question(`${prompt} [${hint}]: `)).trim().toLowerCase();
  if (!raw) return defaultYes;
  return raw === "y" || raw === "yes";
}

function pickByIndex(input: string, options: string[]): string[] {
  // Accept "1,3,5" style input; map to options. Out-of-range entries are
  // silently dropped so the user doesn't have to retype.
  return input
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= options.length)
    .map((n) => options[n - 1]!);
}

function buildPersonaStub(answers: WizardAnswers): string {
  return `# You are ${answers.name}.

You are a long-running expert Pi session. Other agents consult you when they need expertise in your domain.

## Your domain

${answers.domain.trim()}

## How you receive questions

Other agents send you questions via pi-postman. The pi-postman extension is loaded with \`PI_POSTMAN_AUTO_REACT=1\`, so when a message arrives in your inbox a turn kicks off and you see the arrival prompt. Your default behavior on arrival:

1. Call \`postman_read id="<id>"\` to load the question.
2. Investigate using your allowed skills and tools.
3. Distill the answer to **what the asker actually needs to act on**, not the full investigation chain.
4. Reply with \`postman_reply id="<original-id>" kind="answer" body="..."\` after previewing the body to your operator and getting approval.

## What "distilled" means here

The caller doesn't have your context. They sent a question and are blocked waiting for your reply. They get exactly what you put in the body — no transcript of your investigation, no tool calls, no "I tried X then Y." Your reply should be a self-contained answer that the asker can act on directly.

If the question is ambiguous, ask one focused clarifying question rather than guessing. The asker will reply on the same thread.

## What you don't do

- You don't recursively consult other chefs in v1. If a question is out of scope, reply saying so and suggest the right chef.
- You don't take destructive actions outside your domain.
- You don't carry context from one consultation into another in unrelated ways. Each consultation is its own thread.

## Memory

You have a per-chef memory dir at \`$PI_CHEFS_MEMORY_DIR\` (mounted as a regular dir you can \`read\` and \`bash\` against). Use it to persist things you've learned that will help future consultations: gotchas, definitions you've had to clarify before, common follow-ups. Each memory file should have a clear name and a short summary — not transcripts.

## Tone

Direct. Specific. Cite names. Keep replies short unless the question genuinely needs depth.

---
*This is a generated stub. Edit it to make this chef yours: tighten the domain description, add concrete examples of in-scope vs out-of-scope questions, and define the personality you want.*
`;
}

function summarize(answers: WizardAnswers): string {
  return [
    "Configuration:",
    `  name:           ${answers.name}`,
    `  handle:         ${answers.handle}`,
    `  description:    ${answers.description}`,
    `  domain:         ${answers.domain.split("\n")[0]?.slice(0, 60) ?? ""}${answers.domain.split("\n").length > 1 ? " ..." : ""}`,
    `  skills_allowed: ${answers.skills_allowed.join(", ") || "(none)"}`,
    `  tools_allowed:  ${answers.tools_allowed.join(", ")}`,
    `  cwd:            ${answers.cwd}`,
    `  timeout:        ${answers.timeout_seconds}s`,
  ].join("\n");
}

export async function runWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    console.log("👨‍🍳 pi-chefs setup wizard");
    console.log("");
    console.log("This will create a new chef registry entry and persona stub.");
    console.log("Files are written to your user dir, not the bundled package.");
    console.log("Press Ctrl-C at any time to cancel.");
    console.log("");

    // ── name + handle ────────────────────────────────────────────────
    let name = "";
    while (!name) {
      const raw = await ask(rl, "Chef name (lowercase, [a-z0-9_-], e.g. chef-rails)");
      if (!HANDLE_RE.test(raw)) {
        console.log(`  ✗ "${raw}" must match ${HANDLE_RE}`);
        continue;
      }
      name = raw;
    }

    let handle = "";
    while (!handle) {
      const raw = await ask(rl, "AMQ handle (must match [a-z0-9_-])", name);
      if (!HANDLE_RE.test(raw)) {
        console.log(`  ✗ "${raw}" must match ${HANDLE_RE}`);
        continue;
      }
      handle = raw;
    }

    // ── description + domain ─────────────────────────────────────────
    const description = await ask(rl, "One-line description (shown in `pi-chefs list`)");
    const domain = await askMultiline(
      rl,
      "Domain — what's this chef for? what's in scope, what isn't?",
    );

    // ── skills ───────────────────────────────────────────────────────
    const installedSkills = detectInstalledSkills();
    let skills_allowed: string[];
    if (installedSkills.length === 0) {
      console.log("");
      console.log("No skills detected in ~/.pi/agent/skills/.");
      const raw = await ask(rl, "Allowed skills (comma-separated, blank for none)", "");
      skills_allowed = raw ? raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [];
    } else {
      console.log("");
      console.log("Detected skills in ~/.pi/agent/skills/:");
      installedSkills.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
      const raw = await ask(
        rl,
        "Pick allowed skills (comma-separated numbers; blank for none)",
        "",
      );
      skills_allowed = pickByIndex(raw, installedSkills);
    }

    // ── tools ────────────────────────────────────────────────────────
    console.log("");
    console.log(`Built-in tools available: ${DEFAULT_BUILTIN_TOOLS.join(", ")}`);
    console.log(`Recommended for chefs:    ${RECOMMENDED_TOOLS.join(", ")}`);
    const toolsRaw = await ask(
      rl,
      "Tool allowlist (comma-separated)",
      RECOMMENDED_TOOLS.join(","),
    );
    const tools_allowed = toolsRaw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);

    // ── cwd + timeout ────────────────────────────────────────────────
    const cwdRaw = await ask(rl, "Working directory for the chef session", "~");
    const cwd = cwdRaw;

    let timeout_seconds = 300;
    const timeoutRaw = await ask(rl, "Consult timeout in seconds", "300");
    const parsed = Number.parseInt(timeoutRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) timeout_seconds = parsed;

    const answers: WizardAnswers = {
      name,
      handle,
      description,
      domain,
      skills_allowed,
      tools_allowed,
      cwd,
      timeout_seconds,
    };

    console.log("");
    console.log(summarize(answers));
    console.log("");

    const registryPath = join(userRegistryDir(), `${name}.yaml`);
    const personaPath = join(userPersonasDir(), `${name}.md`);

    let force = false;
    if (existsSync(registryPath)) {
      const overwrite = await askYesNo(
        rl,
        `Registry entry already exists at ${registryPath}. Overwrite?`,
        false,
      );
      if (!overwrite) {
        console.log("Aborted.");
        return;
      }
      force = true;
    }

    const confirm = await askYesNo(
      rl,
      `Write registry to ${registryPath} and persona stub to ${personaPath}?`,
      true,
    );
    if (!confirm) {
      console.log("Aborted.");
      return;
    }

    try {
      const result = createChef({
        name: answers.name,
        handle: answers.handle,
        description: answers.description,
        domain: answers.domain || `(no domain specified yet — edit ${registryPath})`,
        skills_allowed: answers.skills_allowed,
        tools_allowed: answers.tools_allowed,
        cwd: answers.cwd,
        timeout_seconds: answers.timeout_seconds,
        force,
      });
      console.log("");
      console.log(`✓ Wrote ${result.registry_path}`);
      console.log(`✓ Wrote ${result.persona_path}`);
      console.log("");
      console.log("Edit the persona file to define how this chef behaves.");
      console.log("");
      console.log("Next:");
      console.log(`  pi-chefs spawn ${name}`);
    } catch (err) {
      if (err instanceof CreateChefAlreadyExistsError) {
        console.error(`\nAborted: ${err.message}`);
      } else {
        console.error(`\nFailed: ${(err as Error).message}`);
      }
      return;
    }
  } finally {
    rl.close();
  }
}

/**
 * `pi-chefs init-caller` wizard. Walks the user through generating the
 * caller-side discipline config at $PI_CHEFS_HOME/caller.yaml. Same shape
 * as `runWizard()` but for the caller's allowlist instead of a chef.
 */
export async function runCallerWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    console.log("🏛️  pi-chefs caller-config wizard");
    console.log("");
    console.log("This will create the caller-side config that controls which skills");
    console.log("and tools your `pi-chefs caller` Pi sessions are allowed to load.");
    console.log("The point of being restrictive: when the caller doesn't have a");
    console.log("domain skill, it's forced to route domain questions through chefs.");
    console.log("");

    const installedSkills = detectInstalledSkills();
    let skills_allowed: string[];
    if (installedSkills.length === 0) {
      console.log("No skills detected in ~/.pi/agent/skills/.");
      const raw = await ask(rl, "Allowed caller skills (comma-separated, blank = pi-chefs only)", "");
      skills_allowed = raw
        ? raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        : ["pi-chefs", "pi-postman"];
    } else {
      console.log("Detected skills in ~/.pi/agent/skills/:");
      installedSkills.forEach((s, i) => console.log(`  [${i + 1}] ${s}`));
      console.log("");
      console.log("For best discipline, allow only pi-chefs + pi-postman + truly cross-cutting");
      console.log("skills (e.g. world-trees if you always need it). Domain-specific skills");
      console.log("(data-portal, gworkspace, etc.) should belong to a chef instead.");
      const piChefsIdx = installedSkills.indexOf("pi-chefs") + 1;
      const piPostmanIdx = installedSkills.indexOf("pi-postman") + 1;
      const defaultPicks = [piChefsIdx, piPostmanIdx].filter((n) => n > 0).join(",");
      const raw = await ask(
        rl,
        `Pick allowed skills (comma-separated numbers)`,
        defaultPicks,
      );
      skills_allowed = pickByIndex(raw, installedSkills);
      if (skills_allowed.length === 0) {
        // Fall back to baseline rather than producing an unusable caller.
        skills_allowed = ["pi-chefs", "pi-postman"];
      }
    }

    console.log("");
    console.log("Pi's default tool set is: read, bash, edit, write, grep, find, ls");
    const toolsRaw = await ask(
      rl,
      "Tool allowlist (comma-separated, blank = use Pi default)",
      "",
    );
    const tools_allowed = toolsRaw
      ? toolsRaw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
      : [];

    console.log("");
    const extensionsRaw = await ask(
      rl,
      "Extra extensions (absolute paths, comma-separated, blank for none)",
      "",
    );
    const extensions_extra = extensionsRaw
      ? extensionsRaw.split(/[,\s]+/).map((e) => e.trim()).filter(Boolean)
      : [];

    console.log("");
    console.log("Configuration:");
    console.log(`  skills_allowed:    ${skills_allowed.join(", ")}`);
    console.log(`  tools_allowed:     ${tools_allowed.join(", ") || "(Pi default)"}`);
    console.log(`  extensions_extra:  ${extensions_extra.join(", ") || "(none)"}`);
    console.log("");

    const path = callerConfigFile();
    if (existsSync(path)) {
      const overwrite = await askYesNo(rl, `Caller config already exists at ${path}. Overwrite?`, false);
      if (!overwrite) {
        console.log("Aborted.");
        return;
      }
    }
    const confirm = await askYesNo(rl, `Write caller config to ${path}?`, true);
    if (!confirm) {
      console.log("Aborted.");
      return;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      yamlStringify({ skills_allowed, tools_allowed, extensions_extra }),
    );
    console.log("");
    console.log(`✓ Wrote ${path}`);
    console.log("");
    console.log("Next:");
    console.log("  pi-chefs caller             # launch a discipline-enabled Pi session");
  } finally {
    rl.close();
  }
}
