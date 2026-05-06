/**
 * Standard paths for pi-chefs. Every other module resolves through here so we
 * have one place to override layout (e.g. for tests) and one place to document
 * what lives where.
 *
 * Layout:
 *   $PI_CHEFS_HOME (default: ~/.pi/chefs/)
 *     ├── registry/           # YAML registry entries, one per chef
 *     ├── personas/           # Markdown persona files referenced from registry
 *     ├── memory/<chef>/      # Per-chef scratch dir, mounted into the session
 *     └── runtime/            # PID files + spawn metadata for `pi-chefs status`
 *
 * The repo also ships a `registry/` and `personas/` directory at its root
 * containing reference chefs (chef-data, etc.). On `pi-chefs spawn <name>`
 * we look in this order:
 *   1. $PI_CHEFS_HOME/registry/<name>.yaml   (user-installed)
 *   2. <repo>/registry/<name>.yaml           (bundled reference chefs)
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function chefsHome(): string {
  return process.env.PI_CHEFS_HOME ?? join(homedir(), ".pi", "chefs");
}

export function userRegistryDir(): string {
  return join(chefsHome(), "registry");
}

export function userPersonasDir(): string {
  return join(chefsHome(), "personas");
}

export function memoryDir(chefName: string): string {
  return join(chefsHome(), "memory", chefName);
}

export function runtimeDir(): string {
  return join(chefsHome(), "runtime");
}

export function pidFile(chefName: string): string {
  return join(runtimeDir(), `${chefName}.pid`);
}

export function spawnMetaFile(chefName: string): string {
  return join(runtimeDir(), `${chefName}.json`);
}

/**
 * Resolve the repo root. Works whether pi-chefs is run from a clone, from a
 * pnpm install, or from the bundled bin script.
 */
export function repoRoot(): string {
  // src/paths.ts → ../  is the repo root.
  return resolve(fileURLToPath(import.meta.url), "..", "..");
}

export function bundledRegistryDir(): string {
  return join(repoRoot(), "registry");
}

export function bundledPersonasDir(): string {
  return join(repoRoot(), "personas");
}

/**
 * Search order for registry files: user-installed first, then bundled.
 */
export function registrySearchPaths(): string[] {
  return [userRegistryDir(), bundledRegistryDir()];
}

export function personaSearchPaths(): string[] {
  return [userPersonasDir(), bundledPersonasDir()];
}
