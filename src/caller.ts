/**
 * Caller-side config: the discipline lever applied to a Pi session that
 * *consults* chefs (as opposed to a chef session that *answers* consults).
 *
 * The config lives at $PI_CHEFS_HOME/caller.yaml and looks like:
 *
 *   skills_allowed: [pi-chefs, pi-postman, world-trees]
 *   tools_allowed:  [bash, read, edit, write, grep, find, ls]
 *   extensions_extra: []   # additional --extension paths beyond pi-postman + pi-chefs
 *
 * `skills_allowed` follows the same name-vs-path semantics as a chef's
 * `skills_allowed` (bare names resolve under ~/.pi/agent/skills/).
 *
 * If the file doesn't exist, callers get a sensible minimum: pi-chefs +
 * pi-postman skills, the default Pi tool set, no extra extensions. That keeps
 * the caller honest \u2014 it has no domain skills, so any domain question forces
 * a `consult_list` lookup.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { callerConfigFile } from "./paths.ts";

export interface CallerConfig {
  skills_allowed: string[];
  tools_allowed: string[];
  extensions_extra: string[];
}

export const DEFAULT_CALLER_CONFIG: CallerConfig = {
  // Default deliberately minimal: only the two skills the framework itself
  // ships. Any other skill (data-portal, gworkspace, etc.) is intentionally
  // *not* loaded so the caller can't answer domain questions directly and is
  // forced to consult a chef.
  skills_allowed: ["pi-chefs", "pi-postman"],
  tools_allowed: [],   // empty = let Pi use its default tool set
  extensions_extra: [],
};

export function loadCallerConfig(): CallerConfig {
  const path = callerConfigFile();
  if (!existsSync(path)) return { ...DEFAULT_CALLER_CONFIG };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`pi-chefs: ${path}: invalid YAML: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`pi-chefs: ${path}: caller config must be a YAML object.`);
  }
  const o = raw as Record<string, unknown>;

  function arrOf<T>(key: string, fallback: T[], filter: (x: unknown) => x is T): T[] {
    const v = o[key];
    if (v === undefined) return fallback;
    if (!Array.isArray(v)) {
      throw new Error(`pi-chefs: ${path}: \`${key}\` must be an array.`);
    }
    return v.filter(filter);
  }
  const isString = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

  return {
    skills_allowed: arrOf("skills_allowed", DEFAULT_CALLER_CONFIG.skills_allowed, isString),
    tools_allowed: arrOf("tools_allowed", DEFAULT_CALLER_CONFIG.tools_allowed, isString),
    extensions_extra: arrOf("extensions_extra", DEFAULT_CALLER_CONFIG.extensions_extra, isString),
  };
}
