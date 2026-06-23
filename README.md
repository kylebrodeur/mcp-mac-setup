# mcp-mac-setup

> Fix stdio MCP server launches when Node is managed via **nvm** or **fnm** — works with VS Code, Cursor, Claude Code, Claude Desktop, and any host reading the standard `{"mcpServers": { ... }}` JSON config.

[![npm](https://img.shields.io/npm/v/@kylebrodeur/mcp-mac-setup)](https://www.npmjs.com/package/@kylebrodeur/mcp-mac-setup)
[![license](https://img.shields.io/github/license/kylebrodeur/mcp-mac-setup)](LICENSE)

---

## The Problem

GUI-launched applications (VS Code, Cursor, Claude Desktop, etc.) inherit their environment from `launchd`, not from your interactive shell. That means `~/.zshrc` / `~/.bash_profile` are never sourced, and any tool installed under a Node version manager (nvm, fnm) is missing from `PATH`.

When one of those apps tries to spawn an MCP server, it `exec()`s the command directly — and gets back `spawn pnpm ENOENT`, `command not found`, or — if you "fixed" it with an absolute path — silent breakage after you upgrade Node and the absolute path stops existing.

### Why this is hard to solve in general

- macOS intentionally keeps GUI app environments minimal for reproducibility.
- VS Code's [MCP server docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) note the requirement but don't provide a fix for version-manager users.
- The absolute path of `pnpm` / `node` / `npx` changes every time you switch Node versions (`~/.nvm/versions/node/v20.x.x/bin/pnpm` → `~/.nvm/versions/node/v22.x.x/bin/pnpm`).
- One-time hardcoding goes stale. You need a script that re-resolves the real path each time you switch.

`mcp-mac-setup` does this:

1. Detects your Node version manager (fnm, nvm, or PNPM_HOME / `which` fallback).
2. Resolves the **absolute** paths to the active `node`, `npx`, `pnpm`, `npm` binaries.
3. Rewrites every `stdio` MCP server entry in the target config so that:
   - `command` is the absolute path to the right binary for that server
   - `env.PATH` is hardcoded with the active `bin/` first
   - `env.PNPM_HOME` / `env.NVM_DIR` / `env.NVM_BIN` are set when relevant

---

## Hosts Supported

Any host that reads `{"mcpServers": { ... }}` JSON. Includes:

| Host | User-level config | Workspace / project config |
|---|---|---|
| VS Code | `~/Library/Application Support/Code/User/mcp.json` | `.vscode/mcp.json` |
| Cursor | (via project root) | `./.mcp.json` |
| Claude Code | `~/.claude.json` | `./.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | (none — user-level only) |

Pass `--target <path>` to target a specific file.

---

## Quick Start

```sh
# rewrite every stdio server in the user-level mcp.json with absolute paths
pnpm dlx @kylebrodeur/mcp-mac-setup --binary auto

# verify everything matches the current Node version (CI-friendly)
pnpm dlx @kylebrodeur/mcp-mac-setup --check

# then reload the host
#   VS Code:        Cmd+Shift+P → Developer: Reload Window
#   Claude Code:    restart MCP servers
#   Cursor:         restart MCP servers
```

---

## Why `--binary auto`?

Different MCP servers use different launchers:

```jsonc
{
  "mcpServers": {
    "playwright":  { "command": "pnpm",   "args": ["dlx", "@playwright/mcp"] },
    "codegraph":   { "command": "npx",    "args": ["-y", "@colbymchenry/codegraph", "serve", "--mcp"] },
    "custom-shim": { "command": "node",   "args": ["./bin/my-mcp-server.js"] }
  }
}
```

`--binary auto` rewrites each server's `command` to the matching absolute path under the resolved Node bin directory, based on what the server actually uses. `--binary pnpm` (the v1.0 default) still works and forces every server through `pnpm`.

---

## CLI Options

| Flag | Description |
|---|---|
| `--binary <mode>` | `auto` (per-server) \| `pnpm` (legacy default) \| `node` \| `npx` \| `npm` \| `all` |
| `--server <name>` | Update a single named server only |
| `--target <path>` | Write to `<path>` instead of the user-level mcp.json |
| `--workspace <path>` | Read workspace `.vscode/mcp.json` from `<path>` |
| `--prefer <v>` | Detection preference: `auto` \| `fnm` \| `nvm` |
| `--check` | Exit 0 if config matches current runtime; 1 if rewrite is needed |
| `--install-task` | Write a `.vscode/tasks.json` entry into the project |
| `--task-dir <path>` | With `--install-task`: target `<path>/.vscode` |

### Examples

```sh
# Fix everything in the user-level VS Code mcp.json
pnpm dlx @kylebrodeur/mcp-mac-setup --binary auto

# Fix a single server in a project-root .mcp.json
pnpm dlx @kylebrodeur/mcp-mac-setup --binary auto --server codegraph --target ./.mcp.json

# Force every server through pnpm (v1.0 behavior)
pnpm dlx @kylebrodeur/mcp-mac-setup --binary pnpm

# CI guard: fail the build if the config is stale
pnpm dlx @kylebrodeur/mcp-mac-setup --binary auto --check

# Use fnm even if both nvm and fnm are installed
pnpm dlx @kylebrodeur/mcp-mac-setup --binary auto --prefer fnm
```

---

## When to Re-run

Re-run `mcp-mac-setup` after:

- Upgrading your Node version (`nvm use` / `fnm use`)
- Switching Node version managers
- Adding or removing MCP servers that depend on `node`/`npx`/`pnpm`/`npm`
- Any change that moves the Node-managed binaries to new absolute paths

---

## What Gets Preserved

The script only rewrites fields that need to change:

- ✅ **Absolute paths you wrote yourself** (e.g. `/opt/custom/binary`) → command preserved; only `env.PATH` is injected so the server can find its own helpers
- ✅ **HTTP / SSE servers** (`type: "http"` or `type: "sse"`) → skipped entirely
- ✅ **`args` arrays** → unchanged (the gallery "exec" → "dlx" typo fix still applies under `--binary pnpm`)
- ✅ **User-defined env vars** → preserved, only `PATH` / `PNPM_HOME` / `NVM_*` are merged in

---

## VS Code Task

Install a one-keystroke task into any project:

```sh
pnpm dlx @kylebrodeur/mcp-mac-setup --install-task
```

Then: `Cmd+Shift+P → Tasks: Run Task → Fix MCP runtime path`.

The repo's own `.vscode/tasks.json` exposes the same tasks for contributors.

---

## Detection Priority

1. **fnm** — `~/.local/share/fnm/aliases/default/bin/`
2. **nvm** — reads `~/.nvm/alias/default` (the active version)
3. **PNPM_HOME / `which pnpm`** — last-resort fallback (warns; path may be unstable)

Override priority with `--prefer fnm` or `--prefer nvm`.

---

## Requirements

- macOS or Linux
- Node ≥ 18
- nvm or fnm managing your Node install (PNPM_HOME fallback also works)

---

## Contributing

Issues and PRs welcome at [github.com/kylebrodeur/mcp-mac-setup](https://github.com/kylebrodeur/mcp-mac-setup).

Run the test suite locally:

```sh
pnpm test
```

---

## License

[MIT](LICENSE)
