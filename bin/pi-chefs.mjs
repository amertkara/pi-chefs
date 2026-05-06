#!/usr/bin/env node
/**
 * pi-chefs CLI.
 *
 * Subcommands:
 *   pi-chefs init                  Interactive wizard: create a new chef
 *   pi-chefs list                  List registered chefs
 *   pi-chefs status [<name>]       Show running status (all chefs, or one)
 *   pi-chefs spawn <name>          Launch the chef as a long-running Pi session
 *   pi-chefs spawn --dry-run <n>   Print resolved config without launching
 *   pi-chefs stop <name>           Stop a running chef (SIGTERM)
 *   pi-chefs install-skill         Symlink the bundled skill into ~/.pi/agent/skills/pi-chefs/
 *   pi-chefs uninstall-skill       Remove the skill symlink
 *   pi-chefs extension-path        Print the absolute path to the extension TS file
 *   pi-chefs help                  Show this help
 *
 * `spawn` does the work the framework promises:
 *   - Resolve the chef's registry entry
 *   - Set AM_ME=<handle>, PI_POSTMAN_HANDLE=<handle>, PI_POSTMAN_AUTO_REACT=1
 *   - Set PI_CHEFS_ROLE=chef, PI_CHEFS_NAME=<name>, PI_CHEFS_HANDLE=<handle>
 *   - Wire pi-postman + pi-chefs extensions
 *   - Inject the persona file as system-prompt augmentation (--system-append
 *     or equivalent, depending on Pi version)
 *   - Apply the skill+tool allowlist (Pi --skills, --tools flags)
 *   - cd into the chef's resolved cwd
 *   - Spawn `pi` as a foreground process (the user sees the chef tab)
 *   - Write a PID file so `pi-chefs status` and `pi-chefs stop` can find it
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(HERE, "..");
const SRC_REGISTRY = join(REPO_ROOT, "src", "registry.ts");
const SRC_PATHS = join(REPO_ROOT, "src", "paths.ts");
// Resolve the pi-postman extension path. Order:
//   1. PI_POSTMAN_PATH env (manual override, useful for dev).
//   2. Sibling node_modules dir (npm-global install: lib/node_modules/pi-postman).
//   3. Sibling repo dir (dev clone: ../pi-postman next to ../pi-chefs).
function resolvePostmanPath() {
  if (process.env.PI_POSTMAN_PATH) return process.env.PI_POSTMAN_PATH;
  const candidates = [
    pathResolve(REPO_ROOT, "..", "pi-postman", "extension", "pi-postman.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
const POSTMAN_DEFAULT = resolvePostmanPath();
const PI_CHEFS_EXT = join(REPO_ROOT, "extension", "pi-chefs.ts");
const PI_SKILLS_DIR = join(homedir(), ".pi", "agent", "skills");
const SKILL_SOURCE = join(REPO_ROOT, "skills", "pi-chefs");
const SKILL_LINK = join(PI_SKILLS_DIR, "pi-chefs");

// ──────────────────────────────────────────────────────────────────────────────
// Reuse the TS modules from a Node entrypoint via --experimental-strip-types.
// We re-exec ourselves under the right flag if missing so users can run this
// without remembering the flag.
// ──────────────────────────────────────────────────────────────────────────────

if (!process.execArgv.some((a) => a.includes("strip-types"))) {
  const result = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", import.meta.filename, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  result.on("exit", (code) => process.exit(code ?? 0));
} else {
  await main();
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;
  switch (subcommand) {
    case "init":
      await cmdInit();
      break;
    case "list":
      await cmdList();
      break;
    case "status":
      await cmdStatus(rest[0]);
      break;
    case "spawn":
      await cmdSpawn(rest);
      break;
    case "stop":
      await cmdStop(rest[0]);
      break;
    case "install-skill":
      cmdInstallSkill();
      break;
    case "uninstall-skill":
      cmdUninstallSkill();
      break;
    case "extension-path":
      console.log(PI_CHEFS_EXT);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`pi-chefs: unknown subcommand "${subcommand}"\n`);
      printHelp();
      process.exit(2);
  }
}

function printHelp() {
  console.log(`pi-chefs — long-running expert Pi sessions

Usage:
  pi-chefs init                       Interactive wizard: create a new chef
  pi-chefs list                       List registered chefs
  pi-chefs status [<name>]            Show running status
  pi-chefs spawn <name> [--dry-run]   Launch a chef
  pi-chefs stop <name>                Stop a running chef
  pi-chefs install-skill              Symlink the skill into ~/.pi/agent/skills/pi-chefs/
  pi-chefs uninstall-skill            Remove the skill symlink
  pi-chefs extension-path             Print the absolute path to the extension file
  pi-chefs help                       Show this help

Env:
  PI_CHEFS_HOME      Override default ~/.pi/chefs/ root
  PI_POSTMAN_PATH    Path to pi-postman extension (default: ../pi-postman)
`);
}

async function cmdInit() {
  const { runWizard } = await import(join(REPO_ROOT, "src", "wizard.ts"));
  await runWizard();
}

async function cmdList() {
  const { listChefs } = await import(SRC_REGISTRY);
  const { runtimeDir } = await import(SRC_PATHS);
  const chefs = listChefs();
  if (chefs.length === 0) {
    console.log("No chefs registered.");
    console.log(`Add YAML entries to ~/.pi/chefs/registry/ or use this repo's bundled registry.`);
    return;
  }
  for (const chef of chefs) {
    const status = pidIsAlive(chef.name) ? "running" : "stopped";
    // Description may be multi-line in the YAML; collapse to one line for the
    // table display.
    const oneLineDesc = (chef.description ?? chef.domain ?? "")
      .split("\n")[0]
      .trim();
    const line = `${chef.name.padEnd(25)} ${chef.handle.padEnd(20)} ${status.padEnd(10)} ${oneLineDesc}`;
    console.log(line);
  }
  void runtimeDir;
}

async function cmdStatus(name) {
  const { listChefs, loadChef } = await import(SRC_REGISTRY);
  const { spawnMetaFile } = await import(SRC_PATHS);
  const targets = name ? [loadChef(name)] : listChefs();
  for (const chef of targets) {
    const alive = pidIsAlive(chef.name);
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(spawnMetaFile(chef.name), "utf8"));
    } catch {
      // not running, no meta file
    }
    console.log(`${chef.name}:`);
    console.log(`  status:  ${alive ? "running" : "stopped"}`);
    console.log(`  handle:  ${chef.handle}`);
    console.log(`  cwd:     ${chef.resolved_cwd}`);
    if (alive && meta.pid) console.log(`  pid:     ${meta.pid}`);
    if (meta.spawned_at) console.log(`  spawned: ${meta.spawned_at}`);
    console.log("");
  }
}

async function cmdSpawn(args) {
  const dryRun = args.includes("--dry-run");
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("pi-chefs spawn: chef name required");
    process.exit(2);
  }
  const { loadChef, readPersona } = await import(SRC_REGISTRY);
  const { memoryDir, runtimeDir, pidFile, spawnMetaFile } = await import(SRC_PATHS);

  const chef = loadChef(name);
  const persona = readPersona(chef);

  // Sanity-check pi-postman is reachable.
  if (!existsSync(POSTMAN_DEFAULT)) {
    console.error(`pi-chefs: pi-postman extension not found at ${POSTMAN_DEFAULT}`);
    console.error(`Set PI_POSTMAN_PATH to the absolute path of pi-postman/extension/pi-postman.ts.`);
    process.exit(1);
  }

  // Make sure runtime + memory dirs exist.
  mkdirSync(runtimeDir(), { recursive: true });
  mkdirSync(memoryDir(chef.name), { recursive: true });

  const env = {
    ...process.env,
    AM_ME: chef.handle,
    PI_POSTMAN_HANDLE: chef.handle,
    PI_POSTMAN_AUTO_REACT: "1",
    PI_CHEFS_ROLE: "chef",
    PI_CHEFS_NAME: chef.name,
    PI_CHEFS_HANDLE: chef.handle,
    PI_CHEFS_MEMORY_DIR: memoryDir(chef.name),
  };

  const piArgs = [
    "--extension",
    POSTMAN_DEFAULT,
    "--extension",
    PI_CHEFS_EXT,
    "--system-append",
    persona,
  ];
  // Skill / tool allowlists. Pi accepts --skills and --tools repeatable flags;
  // if the running Pi version doesn't recognize them they'll be ignored
  // gracefully (with a warning, but the session still starts). We include
  // them to make the discipline lever explicit.
  for (const skill of chef.skills_allowed) {
    piArgs.push("--skill", skill);
  }
  for (const tool of chef.tools_allowed) {
    piArgs.push("--tool-allow", tool);
  }

  if (dryRun) {
    console.log("pi-chefs spawn --dry-run: resolved config");
    console.log("");
    console.log(`  name:           ${chef.name}`);
    console.log(`  handle:         ${chef.handle}`);
    console.log(`  cwd:            ${chef.resolved_cwd}`);
    console.log(`  registry:       ${chef.registry_path}`);
    console.log(`  persona:        ${chef.persona_path}`);
    console.log(`  memory:         ${memoryDir(chef.name)}`);
    console.log(`  timeout:        ${chef.resolved_timeout_seconds}s`);
    console.log(`  skills_allowed: ${chef.skills_allowed.join(", ") || "(none)"}`);
    console.log(`  tools_allowed:  ${chef.tools_allowed.join(", ") || "(none)"}`);
    console.log("");
    console.log(`  command:        pi ${piArgs.map(quote).join(" ")}`);
    console.log("");
    console.log(`  env additions:`);
    for (const [k, v] of Object.entries(env)) {
      if (process.env[k] !== v) console.log(`    ${k}=${v}`);
    }
    return;
  }

  if (pidIsAlive(chef.name)) {
    console.error(`pi-chefs: chef "${chef.name}" already running (see \`pi-chefs status ${chef.name}\`).`);
    process.exit(1);
  }

  console.log(`Spawning ${chef.name} (handle: ${chef.handle}, cwd: ${chef.resolved_cwd}) ...`);
  const child = spawn("pi", piArgs, {
    cwd: chef.resolved_cwd,
    env,
    stdio: "inherit",
  });

  // Record PID + metadata.
  writeFileSync(pidFile(chef.name), String(child.pid));
  writeFileSync(
    spawnMetaFile(chef.name),
    JSON.stringify(
      {
        pid: child.pid,
        name: chef.name,
        handle: chef.handle,
        cwd: chef.resolved_cwd,
        spawned_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  child.on("exit", (code, signal) => {
    try {
      unlinkSync(pidFile(chef.name));
    } catch {}
    try {
      unlinkSync(spawnMetaFile(chef.name));
    } catch {}
    process.exit(code ?? (signal ? 1 : 0));
  });
}

async function cmdStop(name) {
  if (!name) {
    console.error("pi-chefs stop: chef name required");
    process.exit(2);
  }
  const { pidFile, spawnMetaFile } = await import(SRC_PATHS);
  let pid;
  try {
    pid = parseInt(readFileSync(pidFile(name), "utf8").trim(), 10);
  } catch {
    console.error(`pi-chefs: chef "${name}" not running (no pid file).`);
    process.exit(1);
  }
  if (!pid || Number.isNaN(pid)) {
    console.error(`pi-chefs: invalid pid file for "${name}".`);
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped ${name} (pid ${pid}).`);
  } catch (err) {
    console.error(`pi-chefs: failed to stop ${name}: ${err.message}`);
    process.exit(1);
  }
  try {
    unlinkSync(pidFile(name));
  } catch {}
  try {
    unlinkSync(spawnMetaFile(name));
  } catch {}
}

function pidIsAlive(name) {
  try {
    const { pidFile } = require_paths_sync();
    const pid = parseInt(readFileSync(pidFile(name), "utf8").trim(), 10);
    if (!pid || Number.isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Synchronous shim for paths used inside pidIsAlive — top-level await would be
// expensive on every call. We just inline the path resolution.
function require_paths_sync() {
  const home = process.env.PI_CHEFS_HOME ?? join(process.env.HOME ?? "", ".pi", "chefs");
  return {
    pidFile: (n) => join(home, "runtime", `${n}.pid`),
    spawnMetaFile: (n) => join(home, "runtime", `${n}.json`),
  };
}

function quote(s) {
  if (/^[a-zA-Z0-9_\-./@:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill install / uninstall
//
// Pi loads skills it finds in ~/.pi/agent/skills/<name>/. We symlink the
// bundled skill dir there so the user doesn't have to copy files around or
// remember a path. Symlinking (not copying) means the user always gets the
// version that ships with whatever pi-chefs npm version is installed.
// ──────────────────────────────────────────────────────────────────────────────

function cmdInstallSkill() {
  if (!existsSync(SKILL_SOURCE)) {
    console.error(`pi-chefs: skill source not found at ${SKILL_SOURCE}.`);
    console.error(`This usually means the package is corrupted. Try \`npm install -g pi-chefs\` again.`);
    process.exit(1);
  }
  mkdirSync(PI_SKILLS_DIR, { recursive: true });

  if (existsSync(SKILL_LINK) || isSymlink(SKILL_LINK)) {
    if (isSymlink(SKILL_LINK)) {
      const current = readlinkSync(SKILL_LINK);
      const resolved = pathResolve(SKILL_LINK, "..", current);
      if (resolved === SKILL_SOURCE) {
        console.log(`pi-chefs: skill already installed at ${SKILL_LINK}.`);
        return;
      }
      console.log(`pi-chefs: replacing existing symlink at ${SKILL_LINK} (was → ${current}).`);
      unlinkSync(SKILL_LINK);
    } else {
      console.error(
        `pi-chefs: ${SKILL_LINK} exists and is not a symlink. Move/delete it first if you want to install.`,
      );
      process.exit(1);
    }
  }

  symlinkSync(SKILL_SOURCE, SKILL_LINK, "dir");
  console.log(`pi-chefs: skill installed.`);
  console.log(`  ${SKILL_LINK} → ${SKILL_SOURCE}`);
  console.log("");
  console.log(`Next: wire the extension into Pi:`);
  console.log(`  pi --extension "$(pi-chefs extension-path)"`);
}

function cmdUninstallSkill() {
  if (!existsSync(SKILL_LINK) && !isSymlink(SKILL_LINK)) {
    console.log(`pi-chefs: skill not installed (${SKILL_LINK} does not exist).`);
    return;
  }
  if (!isSymlink(SKILL_LINK)) {
    console.error(
      `pi-chefs: refusing to remove ${SKILL_LINK} — it's not a symlink (someone made it a real directory).`,
    );
    process.exit(1);
  }
  const current = readlinkSync(SKILL_LINK);
  const resolved = pathResolve(SKILL_LINK, "..", current);
  if (resolved !== SKILL_SOURCE) {
    console.error(
      `pi-chefs: refusing to remove ${SKILL_LINK} — it points to ${resolved}, not this package's skill (${SKILL_SOURCE}).`,
    );
    process.exit(1);
  }
  unlinkSync(SKILL_LINK);
  console.log(`pi-chefs: skill uninstalled.`);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
