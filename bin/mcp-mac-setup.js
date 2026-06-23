#!/usr/bin/env node
/**
 * bin/mcp-mac-setup.js — CLI entry point for @kylebrodeur/mcp-mac-setup.
 *
 * Detects a Node-managed runtime (nvm / fnm / PNPM_HOME) and rewrites stdio
 * MCP server entries in the target `mcp.json` so that:
 *   - `command` is an absolute path (PATH-independent)
 *   - `env.PATH` is hardcoded to include the runtime bin directory
 *   - `env.PNPM_HOME`, `env.NVM_DIR`, `env.NVM_BIN` are set when relevant
 *
 * Works with any host that reads `{ "mcpServers": { ... } }` JSON:
 *   - VS Code (user-level and workspace)
 *   - Cursor / Windsurf / Zed (project-root .mcp.json)
 *   - Claude Code / Claude Desktop
 *
 * Backward compatible with the original --binary pnpm default; new
 * `--binary auto` mode rewrites node/npx/pnpm/npm according to each server's
 * actual command.
 *
 * Usage:
 *   mcp-mac-setup                                  # rewrite user VS Code mcp.json (pnpm default)
 *   mcp-mac-setup --binary auto                    # rewrite for any Node-managed binary
 *   mcp-mac-setup --binary node --server codegraph
 *   mcp-mac-setup --target /path/to/.mcp.json
 *   mcp-mac-setup --check                          # exit 0 if config matches current runtime
 *   mcp-mac-setup --install-task                   # write .vscode/tasks.json
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RESOLVABLE_COMMANDS,
  detectRuntime,
  classifyCommand,
  pickLauncher,
  buildInjectedPath,
  normalizeArgs,
} = require("../lib/detect-runtime");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`warn: ${msg}\n`); }

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function defaultTargetPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

function workspaceMcpPath(workspaceArg) {
  return workspaceArg || path.join(process.cwd(), ".vscode", "mcp.json");
}

function projectMcpPath() {
  return path.join(process.cwd(), "mcp.json");
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function ensureConfig(targetPath) {
  if (!fs.existsSync(targetPath)) return { mcpServers: {} };
  const raw = fs.readFileSync(targetPath, "utf8");
  if (!raw.trim()) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(raw);
    return { mcpServers: {}, ...parsed };
  } catch (err) {
    throw new Error(`Could not parse JSON at ${targetPath}: ${err.message}`);
  }
}

function loadConfigServers(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    if (!raw.trim()) return {};
    const data = JSON.parse(raw);
    return data.mcpServers || data.servers || {};
  } catch {
    return {};
  }
}

function isHttpServer(server) {
  if (!server) return false;
  if (server.url) return true;
  const t = (server.type || "").toLowerCase();
  return ["http", "https", "sse", "websocket"].includes(t);
}

/**
 * Discover stdio servers across all known config locations. First occurrence
 * wins (user config > workspace > project root). Used to seed an empty
 * `--target` so dry-runs reflect real definitions.
 */
function discoverAllServers(workspaceArg) {
  const sources = [defaultTargetPath(), workspaceMcpPath(workspaceArg), projectMcpPath()];
  const merged = {};
  for (const src of sources) {
    const servers = loadConfigServers(src);
    for (const [name, def] of Object.entries(servers)) {
      if (!merged[name]) merged[name] = def;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {
    binary: "pnpm",        // default — backward compatible
    target: null,
    server: null,
    workspace: null,
    prefer: "auto",
    check: false,
    installTask: false,
    taskDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--binary" && argv[i + 1]) {
      const v = argv[++i];
      if (!["auto", "node", "npx", "pnpm", "npm", "all"].includes(v)) {
        throw new Error(`invalid --binary value: ${v} (expected auto|node|npx|pnpm|npm|all)`);
      }
      result.binary = v;
    } else if (a === "--target" && argv[i + 1]) result.target = argv[++i];
    else if (a === "--server" && argv[i + 1]) result.server = argv[++i];
    else if (a === "--workspace" && argv[i + 1]) result.workspace = argv[++i];
    else if (a === "--prefer" && argv[i + 1]) {
      const v = argv[++i];
      if (!["auto", "fnm", "nvm"].includes(v)) {
        throw new Error(`invalid --prefer value: ${v} (expected auto|fnm|nvm)`);
      }
      result.prefer = v;
    } else if (a === "--check") result.check = true;
    else if (a === "--install-task") result.installTask = true;
    else if (a === "--task-dir" && argv[i + 1]) result.taskDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      log([
        "Usage: mcp-mac-setup [options]",
        "",
        "Options:",
        "  --binary <name>     Which Node binary to inject. One of:",
        "                      auto   — rewrite per-server based on each command (default if --server given)",
        "                      pnpm   — always inject pnpm (legacy default, backward compatible)",
        "                      node   — always inject node",
        "                      npx    — always inject npx",
        "                      npm    — always inject npm",
        "                      all    — rewrite any server whose command matches a known Node tool",
        "  --target <path>     Write to <path> instead of the user-level mcp.json",
        "  --server <name>     Update only the named server",
        "  --workspace <path>  Also read workspace .vscode/mcp.json from <path>",
        "  --prefer <v>        Detection preference: auto | fnm | nvm (default: auto)",
        "  --check             Exit 0 if config already matches current runtime, 1 otherwise",
        "  --install-task      Write a .vscode/tasks.json entry into the project",
        "  --task-dir <path>   With --install-task: target <path>/.vscode",
        "  --help, -h          Show this message",
      ].join("\n"));
      process.exit(0);
    } else {
      warn(`unknown arg ignored: ${a}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Server rewriting
// ---------------------------------------------------------------------------

/**
 * Decide which absolute runtime command to use for a given server, given the
 * --binary mode. The mode controls whether we always inject pnpm (legacy),
 * pick based on each server's command (auto), or treat the flag as a hint
 * for a specific binary.
 */
function chooseLauncher(existingCmd, runtime, mode) {
  const base = (existingCmd || "").split(path.sep).pop();

  // "all" and "auto": treat whatever the user already wrote as the hint.
  if (mode === "all" || mode === "auto") {
    if (RESOLVABLE_COMMANDS.has(base)) return runtime[base] || runtime.npx || runtime.node;
    if (RESOLVABLE_COMMANDS.has(existingCmd)) return runtime[existingCmd] || runtime.npx || runtime.node;
    return null; // leave it to pickLauncher with full context
  }

  // Explicit mode: always inject that binary.
  if (mode === "pnpm") return runtime.pnpm || runtime.npx || runtime.node;
  if (mode === "npm") return runtime.npm || runtime.npx || runtime.node;
  if (mode === "npx") return runtime.npx || runtime.node;
  if (mode === "node") return runtime.node;
  return null;
}

function rewriteServer(server, runtime, mode) {
  const existing = server || {};
  if (isHttpServer(existing) && !existing.command) return { server: existing, changed: false, action: "skip-http" };

  const detectedPathInjected =
    existing.env && existing.env.PATH
      ? existing.env.PATH.split(":").includes(runtime.binDir)
      : false;

  const cls = classifyCommand(existing.command, existing.env, runtime.binDir);

  // Idempotent: command + PATH both match current runtime → no-op.
  if (cls === "ok" && detectedPathInjected) {
    return { server: existing, changed: false, action: "ok" };
  }

  // User-owned absolute path → leave command alone, but still inject PATH.
  if (cls === "leave") {
    if (detectedPathInjected) return { server: existing, changed: false, action: "leave" };
    return {
      server: {
        ...existing,
        type: existing.type || "stdio",
        env: { ...(existing.env || {}), PATH: buildInjectedPath(runtime.binDir) },
      },
      changed: true,
      action: "leave-path-only",
    };
  }

  // cls is "bare" or "stale" — pick launcher based on mode + classify.
  const explicitCmd = chooseLauncher(existing.command, runtime, mode);
  const picked = explicitCmd
    ? { command: explicitCmd, args: existing.args || [] }
    : pickLauncher(existing.command, existing.args || [], runtime);

  const mergedEnv = {
    ...(existing.env || {}),
    PATH: buildInjectedPath(runtime.binDir),
    PNPM_HOME: runtime.pnpmHome || "",
    ...(runtime.nvmDir ? { NVM_DIR: runtime.nvmDir } : {}),
    ...(runtime.nvmBin ? { NVM_BIN: runtime.nvmBin } : {}),
  };

  return {
    server: {
      ...existing,
      type: existing.type || "stdio",
      command: picked.command,
      args: mode === "pnpm" ? normalizeArgs(picked.args) : picked.args,
      env: mergedEnv,
    },
    changed: true,
    action: "rewrite",
  };
}

// ---------------------------------------------------------------------------
// VS Code task installer
// ---------------------------------------------------------------------------

const TASKS_JSON = {
  version: "2.0.0",
  tasks: [
    {
      label: "Fix MCP runtime path",
      type: "shell",
      command: "node",
      args: ["${workspaceFolder}/bin/mcp-mac-setup.js", "--binary", "auto"],
      options: { cwd: "${workspaceFolder}" },
      presentation: { reveal: "always", panel: "shared", focus: true },
      problemMatcher: [],
    },
    {
      label: "Fix MCP runtime path (one server)",
      type: "shell",
      command: "node",
      args: [
        "${workspaceFolder}/bin/mcp-mac-setup.js",
        "--binary", "auto",
        "--server",
        "${input:serverName}",
      ],
      options: { cwd: "${workspaceFolder}" },
      presentation: { reveal: "always", panel: "shared", focus: true },
      problemMatcher: [],
    },
  ],
  inputs: [
    {
      id: "serverName",
      type: "promptString",
      description: "MCP server name to update (e.g. playwright, memory, codegraph)",
    },
  ],
};

function writeTaskFile(taskDir) {
  const vscodeDir = taskDir || path.join(process.cwd(), ".vscode");
  const tasksPath = path.join(vscodeDir, "tasks.json");
  fs.mkdirSync(vscodeDir, { recursive: true });

  if (fs.existsSync(tasksPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(tasksPath, "utf8")); }
    catch { existing = { version: "2.0.0", tasks: [] }; }
    existing.tasks = existing.tasks || [];
    const existingLabels = new Set(existing.tasks.map((t) => t.label));
    let added = 0;
    for (const task of TASKS_JSON.tasks) {
      if (!existingLabels.has(task.label)) {
        existing.tasks.push(task);
        added++;
      }
    }
    existing.inputs = existing.inputs || [];
    const existingInputIds = new Set(existing.inputs.map((i) => i.id));
    for (const input of TASKS_JSON.inputs) {
      if (!existingInputIds.has(input.id)) existing.inputs.push(input);
    }
    fs.writeFileSync(tasksPath, JSON.stringify(existing, null, "\t") + "\n");
    log(added > 0
      ? `Merged ${added} task(s) into ${tasksPath}`
      : `Tasks already present in ${tasksPath} — nothing to add.`);
  } else {
    fs.writeFileSync(tasksPath, JSON.stringify(TASKS_JSON, null, "\t") + "\n");
    log(`Created ${tasksPath}`);
  }

  log("Run task: Cmd+Shift+P → Tasks: Run Task → Fix MCP runtime path");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.installTask) {
    writeTaskFile(args.taskDir);
    return;
  }

  // --binary auto becomes the default when --server is given AND the server
  // exists in the config (so we can pick the right binary for it).
  let binaryMode = args.binary;
  if (binaryMode === "pnpm" && args.server) {
    const targetPath = args.target || defaultTargetPath();
    const cfg = ensureConfig(targetPath);
    const server = (cfg.mcpServers || {})[args.server];
    if (server && RESOLVABLE_COMMANDS.has((server.command || "").split(path.sep).pop())) {
      binaryMode = "all"; // honor the server's actual binary
    }
  }

  const targetPath = args.target || defaultTargetPath();
  log(`Target:  ${targetPath}`);
  log(`Mode:    --binary ${binaryMode}`);

  const runtime = detectRuntime({ prefer: args.prefer });
  if (!runtime || !runtime.node) {
    throw new Error(
      "No Node-managed runtime detected.\n" +
      "  Install via nvm:    nvm install --lts\n" +
      "  Install via fnm:    fnm install --lts\n" +
      "  Install standalone: https://nodejs.org/"
    );
  }
  log(`Detected: ${runtime.source}`);
  log(`  node:    ${runtime.node}`);
  log(`  npx:     ${runtime.npx}`);
  log(`  pnpm:    ${runtime.pnpm}`);
  log(`  binDir:  ${runtime.binDir}`);

  const canonicalPath = defaultTargetPath();
  const isCustomTarget = targetPath !== canonicalPath;

  let config = ensureConfig(targetPath);
  config.mcpServers = config.mcpServers || {};

  // Seed an empty target from the canonical user-level config so dry-runs
  // and `mcp:check` reflect real server definitions.
  if (isCustomTarget && !Object.keys(config.mcpServers).length) {
    const canonicalConfig = ensureConfig(canonicalPath);
    config = { ...canonicalConfig };
    config.mcpServers = { ...(canonicalConfig.mcpServers || canonicalConfig.servers || {}) };
    log(`  (target empty — seeded from ${canonicalPath})`);
  }

  // Pull in server definitions from workspace + project-root configs.
  // Only seed from canonical user-level config when --target is a NEW file
  // (the historical behavior). When --target points at an existing file,
  // we trust it as the source of truth and DO NOT merge in canonical servers —
  // doing so would silently rewrite the user's per-project mcp.json with
  // whatever happens to live in their user-level VS Code config.
  const allDiscovered = discoverAllServers(args.workspace);
  const targetIsNew = !fs.existsSync(targetPath);
  if (targetIsNew) {
    for (const [name, def] of Object.entries(allDiscovered)) {
      if (!config.mcpServers[name]) config.mcpServers[name] = def;
    }
  }

  const serverNames = args.server
    ? [args.server]
    : Object.keys(config.mcpServers);

  if (!serverNames.length) {
    throw new Error(
      "No servers found across:\n" +
      `  user:      ${canonicalPath}\n` +
      `  workspace: ${args.workspace || path.join(process.cwd(), ".vscode", "mcp.json")}\n` +
      `  project:   ${projectMcpPath()}\n` +
      "Use --server <name> to specify one explicitly."
    );
  }

  let changes = 0;
  const stale = [];

  for (const name of serverNames) {
    const server = config.mcpServers[name];
    if (!server) {
      warn(`server "${name}" not found in config`);
      continue;
    }

    const result = rewriteServer(server, runtime, binaryMode);
    config.mcpServers[name] = result.server;

    if (result.action === "ok") log(`  ok    ${name}`);
    else if (result.action === "leave") log(`  skip ${name} (user-owned absolute command: ${server.command})`);
    else if (result.action === "leave-path-only") { log(`  fixed ${name} (refreshed env.PATH)`); changes++; }
    else if (result.action === "skip-http") log(`  skip ${name} (http/sse transport)`);
    else if (result.action === "rewrite") {
      log(`  fixed ${name}  (${server.command} → ${result.server.command})`);
      // Only report "stale from a previous Node version" when the existing
      // command was an absolute path pointing at a different nvm/fnm bin dir.
      // Bare-name rewrites ("npx" → absolute) are not version drift.
      const existingCmd = server.command || "";
      const wasAbsolute = existingCmd.startsWith("/") || existingCmd.includes(path.sep);
      const base = existingCmd.split(path.sep).pop();
      if (
        wasAbsolute &&
        RESOLVABLE_COMMANDS.has(base) &&
        !existingCmd.startsWith(runtime.binDir)
      ) {
        stale.push({ name, from: existingCmd, to: runtime.binDir });
      }
      changes++;
    }
  }

  if (stale.length) {
    log("\nStale paths detected (previous Node version):");
    for (const s of stale) log(`  ${s.name}: ${s.from}  →  ${s.to}`);
  }

  if (args.check) {
    if (changes === 0) {
      log("\ncheck: OK — config matches current runtime");
      process.exit(0);
    }
    log(`\ncheck: ${changes} server(s) would be updated. Re-run without --check to apply.`);
    process.exit(1);
  }

  if (changes === 0) {
    log("\nNo changes.");
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, "\t") + "\n");
  log(`\nWrote ${targetPath}`);
  log("Reload host: VS Code → Cmd+Shift+P → Developer: Reload Window; Claude Code/Cursor → restart MCP server.");
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nerror: ${err.message}\n`);
  if (err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
}
