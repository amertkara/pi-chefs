<p align="center">
  <img src="assets/logo.svg" alt="pi-chefs logo" width="160" height="160" />
</p>

# pi-chefs

A framework for spawning **long-running expert Pi sessions** (chefs) that other Pi sessions can consult. Each chef has a narrow domain — `chef-rails` knows Ruby/Rails patterns, `chef-data` knows SQL and analytics, `chef-history` knows your team's recent decisions — and accumulates context over time within that domain. When a caller agent needs domain expertise, it doesn't run the relevant skill itself; it sends a question to the chef, the chef does the work in its own context, and replies with a distilled answer.

Built on [pi-postman](https://github.com/amertkara/pi-postman) for transport.

## Why

Two pain points motivate this:

1. **Skill bloat.** Pi accumulates dozens of skills and tools per session. The agent picks the wrong one as often as the right one. When `chef-data` exists, you can *remove* the data-related skills from the caller's allowlist — the only way the caller can answer a data question is to ask the chef. Forcing function for context discipline.

2. **Context preservation.** When agent A asks a chef for "the top 5 customers by spend last week," the chef may use 30k tokens producing the answer. Agent A only sees the 200-token reply. Cross-session expertise without cross-session context cost.

## Architecture

Two layers, kept separate:

- **[pi-postman](https://github.com/amertkara/pi-postman)** = transport (mailbox primitive, message delivery, live notifications).
- **pi-chefs** = persona + lifecycle layer on top. This repo.

```
┌─────────────────────┐                              ┌─────────────────────┐
│  Caller Pi tab      │                              │  chef-foo Pi tab    │
│ (your main work)    │                              │ (long-running)      │
│                     │  consult chef=chef-foo       │                     │
│ skills: minimal     │  ───────────────────────>    │ skills: foo-toolkit │
│ tools:  bash, read  │                              │ tools:  bash, read  │
│                     │                              │                     │
│ + pi-chefs ext      │  <───────────────────────    │ + pi-postman        │
│   (consult, list)   │       reply (summary)        │   (auto-react=on)   │
│                     │                              │ + pi-chefs ext      │
│                     │                              │   (chef_info)       │
└─────────────────────┘                              └─────────────────────┘
                              ▲       ▲
                              │       │
                       ┌──────┴───────┴──────┐
                       │ ~/.agent-mail/      │  (AMQ maildir)
                       └─────────────────────┘
```

The caller calls `consult chef="chef-foo" subject="..." question="..."`. Internally:

1. `pi-chefs` mints a thread id like `chefs/chef-foo/<uuid>`.
2. Sends a postman message to the chef with that thread.
3. Watches the caller's own inbox for a reply on the same thread.
4. Returns the reply body as the tool result.

The chef sees an inbound postman event (auto-react fires), reads the question, does its work, and replies via `postman_reply`. Standard postman flow.

## What's in this repo

| Path | Purpose |
|---|---|
| `bin/pi-chefs.mjs` | CLI: `init`, `list`, `status`, `spawn`, `stop`, `install-skill` |
| `extension/pi-chefs.ts` | Pi extension. Caller-mode registers `consult` + `consult_list`. Chef-mode registers `chef_info`. |
| `src/wizard.ts` | Interactive setup wizard that creates a new chef registry entry + persona stub |
| `src/registry.ts` | Loads + validates YAML registry entries |
| `src/consult.ts` | Send-then-watch primitive that powers the `consult` tool |
| `src/paths.ts` | Standard paths under `~/.pi/chefs/` |
| `skills/pi-chefs/` | Caller-side skill teaching Pi when to use `consult` |

This repo intentionally ships *no* pre-defined chefs. The wizard creates them from your machine's actual installed skills.

## Install

### Prereqs

- Node 22+ (for `--experimental-strip-types`)
- [pi-postman](https://www.npmjs.com/package/pi-postman) installed and skill wired up
- AMQ installed (`brew install avivsinai/tap/amq`) and `amq coop init` done
- Pi installed and on `$PATH`

### 1. Install both packages

```bash
# Pick the package manager you have on $PATH:
npm  install -g pi-postman pi-chefs           # npm 11+
pnpm add     -g pi-postman pi-chefs           # pnpm
yarn global add pi-postman pi-chefs           # yarn
```

> If pnpm refuses with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` (its default release-age cooldown), pass `--config.minimumReleaseAge=0`.

### 2. Install the skills

Each package ships a skill that teaches Pi *when* and *how* to use its tools. Symlink them into Pi's skill dir:

```bash
pi-postman install-skill
pi-chefs install-skill
```

Reverse with `pi-postman uninstall-skill` / `pi-chefs uninstall-skill` if you ever want to.

### 3. Wire the extensions into Pi

Load both extensions in any Pi session that should be able to consult chefs:

```bash
pi \
  --extension "$(pi-postman extension-path)" \
  --extension "$(pi-chefs extension-path)"
```

Or alias permanently in `~/.zshrc` / `~/.bashrc`:

```bash
alias pi='pi --extension "$(pi-postman extension-path)" --extension "$(pi-chefs extension-path)"'
```

When the extensions load, the footer shows `chefs: <N> available` and `postman: <handle>`.

### Updating

```bash
npm  install -g pi-postman@latest pi-chefs@latest
pnpm add     -g pi-postman@latest pi-chefs@latest --config.minimumReleaseAge=0
```

Skill symlinks resolve through the package manager's store path, so they auto-pick up the new version. No need to re-run `install-skill`.

### `PI_POSTMAN_PATH` (only needed for development)

When you `pi-chefs spawn` a chef, the launcher needs to find pi-postman's extension to wire into the chef session. The npm-installed default works automatically. If you've cloned pi-postman locally for development, override:

```bash
export PI_POSTMAN_PATH=/absolute/path/to/pi-postman/extension/pi-postman.ts
```

## Quickstart: create your first chef

### 1. Run the wizard

```bash
pi-chefs init
```

The wizard walks you through:

- **Name + handle** (any `[a-z0-9_-]` string, e.g. `chef-rails`, `chef-frontend`, `chef-history`).
- **Description + domain** — what's this chef for? what's in scope, what isn't?
- **Allowed skills** — detected from your `~/.pi/agent/skills/` and offered as a numbered list.
- **Tool allowlist** — defaults to a minimal `bash, read` so the chef stays read-only.
- **Working directory + timeout**.

Output: a YAML registry entry at `~/.pi/chefs/registry/<name>.yaml` and a persona stub at `~/.pi/chefs/personas/<name>.md`. **Edit the persona file** to make this chef yours: tighten the domain, add concrete examples, define the personality you want.

### 2. Spawn it

```bash
pi-chefs spawn <name>
```

This:
- Loads the registry + persona.
- Sets `AM_ME=<handle>`, `PI_POSTMAN_AUTO_REACT=1`, `PI_CHEFS_ROLE=chef`.
- Restricts skills + tools per the registry allowlist.
- Injects the persona as a system-prompt prefix.
- Opens a Pi session in the chef's `cwd`.

You're now sitting in the chef's session. Footer: `chef: <name>`. Postman footer: `postman: <handle> · auto`.

To preview without launching:

```bash
pi-chefs spawn <name> --dry-run
```

### 3. From another terminal, run a caller Pi session

```bash
pi \
  --extension "$(pi-postman extension-path)" \
  --extension "$(pi-chefs extension-path)"
```

### 4. Ask the chef something

In the caller, ask Pi:

> List available chefs.

Pi calls `consult_list`. Then:

> Consult chef-rails: I'm seeing N+1 query warnings on User#orders. What's the conventional fix?

Pi previews the consult. You approve. The `consult` tool blocks; you see status updates as the chef works (in the chef's tab). When the chef replies, the answer appears as the tool result in the caller. Done.

### 5. Manage chefs

```bash
pi-chefs list                # all registered chefs + running status
pi-chefs status <name>       # detailed status for one chef
pi-chefs stop <name>         # SIGTERM the chef session
```

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_CHEFS_HOME` | `~/.pi/chefs/` | Root for user-installed registries, personas, and runtime PIDs |
| `PI_CHEFS_ROLE` | `caller` | Set to `chef` inside chef sessions (managed by `pi-chefs spawn`) |
| `PI_CHEFS_NAME` | — | Chef name; set automatically by `spawn`, used by `chef_info` |
| `PI_CHEFS_HANDLE` | — | Chef handle; set automatically by `spawn` |
| `PI_CHEFS_MEMORY_DIR` | `<home>/memory/<name>/` | Per-chef scratch dir, mounted into chef sessions |
| `PI_POSTMAN_PATH` | auto-resolved | Where `pi-chefs spawn` finds pi-postman |
| `PI_CHEFS_PI_BIN` | `pi` | Launcher binary for chef sessions. Can include args (e.g. `PI_CHEFS_PI_BIN="my-pi-wrapper run"`), or an absolute path to a `pi` binary. |

## Tools

### Caller-side

| Tool | What it does |
|---|---|
| `consult_list` | List all registered chefs, their handles, and one-line domain summaries. Call before `consult`. |
| `consult` | Send a question to a chef and block until the reply arrives (default 300s timeout). Reply body is returned as the tool result. Always preview + approve before calling. |

### Chef-side

| Tool | What it does |
|---|---|
| `chef_info` | Show the chef's own registry entry + persona path. Useful for self-reflection during a consultation. |

## Status

v0.3.4 — works end to end across two Pi tabs (caller + chef). The launcher composes Pi's actual flags: `--append-system-prompt` (persona injection), `--skill <name>` (repeated, per registry `skills_allowed`), `--tools <a,b,c>` (per registry `tools_allowed`), `--extension <path>` (pi-postman + pi-chefs).

## Develop locally

```bash
git clone git@github.com:amertkara/pi-chefs.git ~/src/github.com/amertkara/pi-chefs
cd ~/src/github.com/amertkara/pi-chefs
pnpm install
pnpm typecheck
ln -sf "$PWD/bin/pi-chefs.mjs" "$HOME/.local/bin/pi-chefs"
ln -sf "$PWD/skills/pi-chefs" ~/.pi/agent/skills/pi-chefs
pi-chefs help
```

## Related

- [pi-postman](https://github.com/amertkara/pi-postman) — transport layer this repo builds on
- [agent-message-queue](https://github.com/avivsinai/agent-message-queue) — the underlying queue
- [Pi RFC #2715](https://github.com/badlogic/pi-mono/issues/2715) — proposes a similar pattern over agent-event-bus

## License

MIT

## Author

[Mert Kara](https://github.com/amertkara)
