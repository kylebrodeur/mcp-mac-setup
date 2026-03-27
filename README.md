# mcp-mac-setup

> Fix VS Code MCP server stdio launches on macOS when Node / pnpm is managed via **nvm** or **fnm**.

[![npm](https://img.shields.io/npm/v/@kylebrodeur/mcp-mac-setup)](https://www.npmjs.com/package/@kylebrodeur/mcp-mac-setup)
[![license](https://img.shields.io/github/license/kylebrodeur/mcp-mac-setup)](LICENSE)

---

## The Problem

When you launch VS Code from a GUI (Dock, Spotlight, Finder), it starts as a process whose **environment is inherited from `launchd`** — not from your interactive shell. That means none of the PATH modifications that live in `~/.zshrc`, `~/.bash_profile`, or similar files are applied.

Tools like **nvm** and **fnm** work by injecting themselves into your shell session at login:

```sh
# typical ~/.zshrc entry for nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

This writes the active Node version's `bin/` directory (e.g. `~/.nvm/versions/node/v22.19.0/bin`) onto `PATH`. When VS Code opens a regular terminal it sources your rc file and everything works. But when VS Code spawns an **MCP server as a child stdio process** it does **not** source any shell config — the binary is just `exec()`'d directly.

The result: `pnpm` (and even `node`) are not found, and every stdio MCP server fails to start with a cryptic `spawn pnpm ENOENT` or `command not found` error.

### Why this is a hard problem to solve in general

- macOS intentionally keeps GUI-launched application environments minimal for security and reproducibility reasons.
- VS Code [does not source shell profiles](https://code.visualstudio.com/docs/terminal/profiles) when spawning non-terminal child processes (only the integrated *terminal* does this via a shell login trick).
- npm-managed global tools (like `pnpm dlx`) rely on a `PATH`-resident binary, so there is no stable "default" location to hard-code.
- The absolute path of the `pnpm` binary changes every time you switch Node versions with nvm/fnm (e.g. `~/.nvm/versions/node/v20.x.x/bin/pnpm` → `~/.nvm/versions/node/v22.x.x/bin/pnpm`).

This is a well-documented pain point across the community:

- [microsoft/vscode#70248](https://github.com/microsoft/vscode/issues/70248) — "Terminal: shell integration should source shell profile"
- Dozens of GitHub issues across MCP server repos where users report `spawn pnpm ENOENT` on macOS with nvm
- The VS Code docs for [MCP servers](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) note that you may need to ensure runtimes are on PATH, but don't provide a concrete fix for version-manager users

### The shim approach

Because the path is version-specific and changes over time, a one-time hardcode is not enough. The right fix is a **script that reads your current nvm/fnm state, resolves the real absolute path, and writes it directly into `mcp.json`** — then you re-run it whenever you switch Node versions.

`mcp-mac-setup` does exactly this:

1. Detects your Node version manager (fnm, nvm, or `PNPM_HOME` fallback).
2. Resolves the absolute path to the active `pnpm` binary and its `bin/` directory.
3. Rewrites every `stdio` server entry in `~/.../Code/User/mcp.json` so that:
   - `command` is the absolute path to `pnpm`
   - `env.PATH` is a hardcoded string containing the active `bin/` directory first

---

## Quick Start

```sh
pnpm dlx @kylebrodeur/mcp-mac-setup
```

Then reload VS Code:

```
Cmd+Shift+P → Developer: Reload Window
```

All stdio MCP servers in your user-level `mcp.json` are updated. HTTP/SSE servers are left untouched.

---

## Installation & Usage

### One-shot (no install)

```sh
# fix all stdio servers
pnpm dlx @kylebrodeur/mcp-mac-setup

# fix a single server
pnpm dlx @kylebrodeur/mcp-mac-setup --server playwright
```

### Global install

```sh
pnpm add -g @kylebrodeur/mcp-mac-setup

# then run any time you switch Node versions
mcp-mac-setup
```

### From source

```sh
git clone https://github.com/kylebrodeur/mcp-mac-setup.git
cd mcp-mac-setup
node scripts/resolve-pnpm.js
```

---

## CLI Options

| Flag | Description |
|------|-------------|
| _(none)_ | Update all stdio servers in the user-level `mcp.json` |
| `--server <name>` | Update a single named server only |
| `--target <path>` | Write to a custom file instead of the default `mcp.json` |
| `--workspace <path>` | Also read server definitions from a workspace `mcp.json` |
| `--install-task` | Install a VS Code `tasks.json` entry into the current project |
| `--task-dir <path>` | Combined with `--install-task`: target a specific `.vscode/` directory |

---

## VS Code Task

Instead of running the CLI manually, you can install a VS Code task into any project:

```sh
# adds a task to your current project's .vscode/tasks.json
pnpm dlx @kylebrodeur/mcp-mac-setup --install-task
```

Then run it with `Cmd+Shift+P → Tasks: Run Task → Fix MCP pnpm path`.

The task will also be offered for projects that clone this repo directly (see `.vscode/tasks.json`).

---

## When to Re-run

Re-run `mcp-mac-setup` after:

- Upgrading your Node version with `nvm use` / `fnm use`
- Reinstalling pnpm (e.g. via `corepack enable pnpm`)
- Any change that moves the `pnpm` binary to a new absolute path

---

## How It Works

```
~/.nvm/versions/node/v22.19.0/bin/
├── node       ← resolved by reading ~/.nvm/alias/default
└── pnpm       ← written into mcp.json as the absolute command

       ┌─────────────────────────────────────┐
       │  ~/.../Code/User/mcp.json (before)  │
       │  "command": "pnpm"                  │  ← not found in GUI PATH
       └─────────────────────────────────────┘
                         │ mcp-mac-setup
                         ▼
       ┌──────────────────────────────────────────────────────────┐
       │  ~/.../Code/User/mcp.json (after)                        │
       │  "command": "/Users/you/.nvm/versions/node/v22.19.0/     │
       │              bin/pnpm"                                    │
       │  "env": { "PATH": "/Users/you/.nvm/…/bin:~/Library/pnpm:│
       │            /usr/local/bin:/usr/bin:/bin" }                │
       └──────────────────────────────────────────────────────────┘
```

Detection priority:
1. **fnm** — checks `~/.local/share/fnm/aliases/default/bin/`
2. **nvm** — reads `~/.nvm/alias/default` to get the active version
3. **PNPM_HOME** / `which pnpm` — last-resort fallback (warns if used)

---

## Requirements

- macOS (Linux is supported but the PATH problem is less common there)
- Node ≥ 18
- nvm or fnm managing your Node installation (fallback works for other setups)
- VS Code with MCP server support ([GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) or [Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat))

---

## Contributing

Issues and PRs welcome at [github.com/kylebrodeur/mcp-mac-setup](https://github.com/kylebrodeur/mcp-mac-setup).

---

## License

[MIT](LICENSE)
