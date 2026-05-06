/**
 * createChef: shared file-writing logic for both the interactive CLI wizard
 * (`pi-chefs init`) and the agent-callable `chef_create` tool. One source of
 * truth for: validation, registry YAML shape, persona stub generation,
 * overwrite handling, and ~/.pi/chefs/* directory materialization.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { userPersonasDir, userRegistryDir } from "./paths.ts";

export const CHEF_HANDLE_RE = /^[a-z0-9_-]+$/;
export const DEFAULT_TIMEOUT_SECONDS = 300;

export interface CreateChefInput {
  /** Chef name. Must match [a-z0-9_-]+. Used as the registry filename. */
  name: string;
  /** AMQ handle. Defaults to name. Must match [a-z0-9_-]+. */
  handle?: string;
  /** One-line summary surfaced in `pi-chefs list` and `consult_list`. */
  description: string;
  /** Multi-line domain description: what's in scope, what isn't. */
  domain: string;
  /** Optional full persona markdown. If omitted, a stub is synthesized. */
  persona?: string;
  /** Skill allowlist for the chef. Bare names resolve to ~/.pi/agent/skills/<name>/. */
  skills_allowed?: string[];
  /** Tool allowlist (advisory in v0.6+; not enforced at spawn time). */
  tools_allowed?: string[];
  /** Working directory for the chef session. Defaults to $HOME. */
  cwd?: string;
  /** Consult timeout in seconds. Defaults to 300. */
  timeout_seconds?: number;
  /** If true, overwrite an existing registry entry with the same name. */
  force?: boolean;
}

export interface CreateChefResult {
  registry_path: string;
  persona_path: string;
  overwrote: boolean;
}

export interface ValidationError {
  field: string;
  message: string;
}

export class CreateChefValidationError extends Error {
  errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(
      `pi-chefs: chef definition has ${errors.length} validation error(s):\n` +
        errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n"),
    );
    this.name = "CreateChefValidationError";
    this.errors = errors;
  }
}

export class CreateChefAlreadyExistsError extends Error {
  registryPath: string;
  constructor(registryPath: string) {
    super(
      `pi-chefs: a chef registry already exists at ${registryPath}. ` +
        `Pass force: true to overwrite, or pick a different name.`,
    );
    this.name = "CreateChefAlreadyExistsError";
    this.registryPath = registryPath;
  }
}

function validate(input: CreateChefInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!input.name || typeof input.name !== "string") {
    errors.push({ field: "name", message: "required, must be a non-empty string" });
  } else if (!CHEF_HANDLE_RE.test(input.name)) {
    errors.push({ field: "name", message: `must match ${CHEF_HANDLE_RE}` });
  }

  const handle = input.handle ?? input.name;
  if (handle && !CHEF_HANDLE_RE.test(handle)) {
    errors.push({ field: "handle", message: `must match ${CHEF_HANDLE_RE}` });
  }

  if (!input.description || typeof input.description !== "string" || input.description.trim() === "") {
    errors.push({ field: "description", message: "required, non-empty one-line summary" });
  }

  if (!input.domain || typeof input.domain !== "string" || input.domain.trim() === "") {
    errors.push({ field: "domain", message: "required, what's in scope vs. out" });
  }

  if (input.skills_allowed && !Array.isArray(input.skills_allowed)) {
    errors.push({ field: "skills_allowed", message: "must be an array of strings" });
  }
  if (input.tools_allowed && !Array.isArray(input.tools_allowed)) {
    errors.push({ field: "tools_allowed", message: "must be an array of strings" });
  }
  if (
    input.timeout_seconds !== undefined &&
    (typeof input.timeout_seconds !== "number" || input.timeout_seconds <= 0 || !Number.isFinite(input.timeout_seconds))
  ) {
    errors.push({ field: "timeout_seconds", message: "must be a positive number" });
  }

  return errors;
}

/**
 * Default persona stub generator. Mirrors the CLI wizard's text but lives
 * here so the `chef_create` tool gets the same starting persona.
 */
export function buildPersonaStub(input: CreateChefInput): string {
  const handle = input.handle ?? input.name;
  return `# You are ${input.name}.

You are a long-running expert Pi session. Other agents consult you when they need expertise in your domain.

## Your domain

${input.domain.trim()}

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
*This stub was generated for chef \`${handle}\`. Edit it freely to refine the chef's voice and scope.*
`;
}

export function detectInstalledSkills(): string[] {
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

/**
 * Create a chef. Writes the YAML registry entry and persona markdown to
 * $PI_CHEFS_HOME (default ~/.pi/chefs/). Throws on validation failure or
 * existing-name collision (unless force is true).
 */
export function createChef(input: CreateChefInput): CreateChefResult {
  const errors = validate(input);
  if (errors.length > 0) throw new CreateChefValidationError(errors);

  const handle = input.handle ?? input.name;
  const registryPath = join(userRegistryDir(), `${input.name}.yaml`);
  const personaPath = join(userPersonasDir(), `${input.name}.md`);

  const overwrote = existsSync(registryPath);
  if (overwrote && !input.force) {
    throw new CreateChefAlreadyExistsError(registryPath);
  }

  mkdirSync(userRegistryDir(), { recursive: true });
  mkdirSync(userPersonasDir(), { recursive: true });

  const yaml = yamlStringify({
    name: input.name,
    handle,
    description: input.description.trim(),
    domain: input.domain.trim(),
    persona_file: `${input.name}.md`,
    skills_allowed: input.skills_allowed ?? [],
    tools_allowed: input.tools_allowed ?? [],
    cwd: input.cwd ?? "~",
    timeout_seconds: input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  });
  writeFileSync(registryPath, yaml);

  const persona = input.persona ?? buildPersonaStub(input);
  writeFileSync(personaPath, persona);

  return { registry_path: registryPath, persona_path: personaPath, overwrote };
}
