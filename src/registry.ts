/**
 * Registry: load and validate the YAML files that describe each chef.
 *
 * A registry entry looks like:
 *
 *   name: chef-rails
 *   handle: chef-rails
 *   domain: |
 *     Ruby/Rails/ActiveRecord conventions and idioms. Ask me about
 *     idiomatic patterns, gotchas, typed associations, etc.
 *   persona_file: chef-rails.md
 *   skills_allowed: []
 *   tools_allowed: [bash, read]
 *   cwd: ~/projects/my-app              # optional; defaults to $HOME
 *   timeout_seconds: 300                # optional; default 300 (consult timeout)
 *   description: Ruby/Rails patterns expert.   # optional; surfaced in `pi-chefs list`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  bundledPersonasDir,
  personaSearchPaths,
  registrySearchPaths,
  userPersonasDir,
} from "./paths.ts";

export interface ChefRegistryEntry {
  name: string;
  handle: string;
  domain: string;
  persona_file: string;
  skills_allowed: string[];
  tools_allowed: string[];
  cwd?: string;
  timeout_seconds?: number;
  description?: string;
}

export interface ResolvedChef extends ChefRegistryEntry {
  /** Absolute path to the YAML file we loaded the entry from. */
  registry_path: string;
  /** Absolute path to the resolved persona file. */
  persona_path: string;
  /** Resolved cwd (`~` expanded, defaults to $HOME). */
  resolved_cwd: string;
  /** Resolved consult timeout in seconds. */
  resolved_timeout_seconds: number;
}

const HANDLE_RE = /^[a-z0-9_-]+$/;
const DEFAULT_TIMEOUT_SECONDS = 300;

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * Locate a chef's registry file by name across the user + bundled search
 * paths. Throws with a clear message if not found.
 */
function locateRegistryFile(name: string): string {
  for (const dir of registrySearchPaths()) {
    const candidate = join(dir, `${name}.yaml`);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // not found in this dir; try the next.
    }
  }
  throw new Error(
    `pi-chefs: no registry entry found for "${name}". Searched: ${registrySearchPaths().join(", ")}`,
  );
}

function locatePersonaFile(personaFile: string): string {
  // Allow absolute paths verbatim.
  if (personaFile.startsWith("/")) return personaFile;
  if (personaFile.startsWith("~")) return expandHome(personaFile);

  for (const dir of personaSearchPaths()) {
    const candidate = join(dir, personaFile);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // not in this dir; try the next.
    }
  }
  throw new Error(
    `pi-chefs: persona file "${personaFile}" not found. Searched: ${personaSearchPaths().join(", ")}`,
  );
}

/**
 * Parse + validate a YAML registry entry. Returns the validated object,
 * throws with a precise message on any schema violation.
 */
function validateEntry(raw: unknown, sourcePath: string): ChefRegistryEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`pi-chefs: ${sourcePath}: registry entry must be a YAML object.`);
  }
  const o = raw as Record<string, unknown>;
  function requireString(key: string): string {
    const v = o[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`pi-chefs: ${sourcePath}: missing or invalid \`${key}\` (expected non-empty string).`);
    }
    return v.trim();
  }
  function requireStringArray(key: string): string[] {
    const v = o[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new Error(
        `pi-chefs: ${sourcePath}: missing or invalid \`${key}\` (expected array of strings).`,
      );
    }
    return v.map((x) => x.trim()).filter(Boolean);
  }

  const name = requireString("name");
  const handle = requireString("handle");
  if (!HANDLE_RE.test(handle)) {
    throw new Error(
      `pi-chefs: ${sourcePath}: handle "${handle}" must match ${HANDLE_RE} (AMQ requirement).`,
    );
  }
  return {
    name,
    handle,
    domain: requireString("domain"),
    persona_file: requireString("persona_file"),
    skills_allowed: requireStringArray("skills_allowed"),
    tools_allowed: requireStringArray("tools_allowed"),
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    timeout_seconds:
      typeof o.timeout_seconds === "number" && Number.isFinite(o.timeout_seconds)
        ? o.timeout_seconds
        : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
  };
}

export function loadChef(name: string): ResolvedChef {
  const path = locateRegistryFile(name);
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`pi-chefs: ${path}: invalid YAML: ${(err as Error).message}`);
  }
  const entry = validateEntry(parsed, path);
  if (entry.name !== name) {
    throw new Error(
      `pi-chefs: ${path}: \`name\` field "${entry.name}" does not match filename "${name}.yaml".`,
    );
  }
  const personaPath = locatePersonaFile(entry.persona_file);
  const resolvedCwd = entry.cwd ? resolve(expandHome(entry.cwd)) : homedir();
  return {
    ...entry,
    registry_path: path,
    persona_path: personaPath,
    resolved_cwd: resolvedCwd,
    resolved_timeout_seconds: entry.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

/**
 * List all chefs visible across registries (user + bundled, deduped by name —
 * user wins). Used by `pi-chefs list` and the `consult` tool's autodiscovery.
 */
export function listChefs(): ResolvedChef[] {
  const seen = new Set<string>();
  const found: ResolvedChef[] = [];
  for (const dir of registrySearchPaths()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const name = entry.replace(/\.ya?ml$/, "");
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        found.push(loadChef(name));
      } catch (err) {
        // Don't silently hide broken entries — surface as stderr so the user
        // notices, but keep listing the rest.
        console.error(`pi-chefs: skipping ${entry}: ${(err as Error).message}`);
      }
    }
  }
  return found;
}

/**
 * Read the persona's full text. Used at spawn time to compose the system
 * prompt, and at consult time to surface "what does this chef know" to the
 * caller.
 */
export function readPersona(chef: ResolvedChef): string {
  return readFileSync(chef.persona_path, "utf8");
}

// Re-export for convenience.
export { bundledPersonasDir, userPersonasDir };
