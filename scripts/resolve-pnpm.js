#!/usr/bin/env node
/**
 * mcp-mac-setup — resolve-pnpm.js
 *
 * Detects the installed Node/pnpm binary (nvm or fnm) and rewrites
 * the VS Code user-level mcp.json so every stdio MCP server uses
 * an absolute PATH-independent command + injected env.
 *
 * Usage (CLI / one-shot):
 *   pnpm dlx @kylebrodeur/mcp-mac-setup
 *
 * Usage (local clone):
 *   node scripts/resolve-pnpm.js               # update all stdio servers
 *   node scripts/resolve-pnpm.js --server playwright
 *   node scripts/resolve-pnpm.js --target /tmp/test-mcp.json
 *   node scripts/resolve-pnpm.js --install-task        # add VS Code task to cwd project
 *   node scripts/resolve-pnpm.js --install-task --task-dir /path/to/project/.vscode
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`warn: ${msg}\n`); }

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function resolveTargetPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(home, ".config", "Code", "User", "mcp.json");
}

function resolvePnpmHome() {
  if (process.env.PNPM_HOME) return process.env.PNPM_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "pnpm");
  return path.join(os.homedir(), ".local", "share", "pnpm");
}

// ---------------------------------------------------------------------------
// Detection: fnm (macOS/Linux)
// ---------------------------------------------------------------------------

function detectFnm() {
  const fnmRoot = path.join(os.homedir(), ".local", "share", "fnm");
  if (!fs.existsSync(fnmRoot)) return null;

  const binDir = path.join(fnmRoot, "aliases", "default", "bin");
  const pnpm = path.join(binDir, "pnpm");
  const node = path.join(binDir, "node");

  if (fs.existsSync(pnpm) && fs.existsSync(node)) {
    return { pnpm, node, binDir, source: "fnm" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection: nvm (macOS/Linux)
// ---------------------------------------------------------------------------

function detectNvm() {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  const aliasFile = path.join(nvmDir, "alias", "default");
  if (!fs.existsSync(aliasFile)) return null;

  let version = fs.readFileSync(aliasFile, "utf8").trim();
  if (!version.startsWith("v")) version = `v${version}`;

  const binDir = path.join(nvmDir, "versions", "node", version, "bin");
  const pnpm = path.join(binDir, "pnpm");
  const node = path.join(binDir, "node");

  if (fs.existsSync(pnpm) && fs.existsSync(node)) {
    return { pnpm, node, binDir, source: `nvm (${version})` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection: fallback via PNPM_HOME or `which`
// ---------------------------------------------------------------------------

function detectFallback(pnpmHome) {
  const fromHome = path.join(pnpmHome, "pnpm");
  if (fs.existsSync(fromHome)) {
    return { pnpm: fromHome, node: process.execPath, binDir: pnpmHome, source: "PNPM_HOME" };
  }

  const which = spawnSync("which", ["pnpm"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    const pnpm = which.stdout.trim();
    warn("pnpm found via which — this path may not be stable if VS Code does not inherit your shell PATH.");
    warn("Consider using nvm or fnm for a stable absolute path.");
    return { pnpm, node: process.execPath, binDir: path.dirname(pnpm), source: `which (${pnpm})` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main detection
// ---------------------------------------------------------------------------

function detectPnpm() {
  const pnpmHome = resolvePnpmHome();

  const result = detectFnm() || detectNvm() || detectFallback(pnpmHome);
  if (!result) return null;

  return { ...result, pnpmHome };
}

// ---------------------------------------------------------------------------
// Args normalisation
// ---------------------------------------------------------------------------

/** Gallery-generated configs sometimes use "exec" instead of "dlx". Fix it. */
function normalizeArgs(args) {
  if (!Array.isArray(args) || !args.length) return args;
  if (args[0] === "exec" && args.length >= 2 && args[1].startsWith("@")) {
    return ["dlx", ...args.slice(1)];
  }
  return args;
}

/** Remove a previously-injected absolute pnpm path from command if the field
 *  is already a binary (idempotency when updating to a newer node version). */
function normalizeCommand(existing, detectedPnpm) {
  // If command is already an absolute pnpm path for a different nvm version, we'll
  // overwrite it. Nothing to strip from args in this case.
  return existing;
}

// ---------------------------------------------------------------------------
// PATH string for env injection
// ---------------------------------------------------------------------------

function buildInjectedPath(binDir, pnpmHome) {
  const parts = [];
  if (binDir) parts.push(binDir);
  if (pnpmHome) parts.push(pnpmHome);
  ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].forEach(p => {
    if (!parts.includes(p)) parts.push(p);
  });
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function ensureConfig(targetPath) {
  if (!fs.existsSync(targetPath)) return { servers: {}, inputs: [] };
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    return raw ? JSON.parse(raw) : { servers: {}, inputs: [] };
  } catch (err) {
    throw new Error(`Could not parse JSON at ${targetPath}: ${err.message}`);
  }
}

function loadConfigServers(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8") || "{}");
    return data.servers || {};
  } catch {
    return {};
  }
}

/**
 * Collect stdio servers from all known config locations:
 *   1. User-level:      ~/Library/Application Support/Code/User/mcp.json
 *   2. Workspace:       .vscode/mcp.json  (or --workspace path)
 *   3. Project-local:   mcp.json in cwd
 * Returns a merged map of { serverName: serverDef } (user config wins on conflict).
 */
function discoverAllServers(workspaceArg) {
  const sources = [
    resolveTargetPath(),                                          // user config
    workspaceArg || path.join(process.cwd(), ".vscode", "mcp.json"), // workspace
    path.join(process.cwd(), "mcp.json"),                          // project root
  ];

  const merged = {};
  for (const src of sources) {
    const servers = loadConfigServers(src);
    for (const [name, def] of Object.entries(servers)) {
      if (!merged[name]) merged[name] = def; // first occurrence wins
    }
  }
  return merged;
}

function isHttpServer(server) {
  return (
    Boolean(server.url) ||
    ["http", "https", "sse", "websocket"].includes((server.type || "").toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) { result.target = args[++i]; }
    else if (args[i] === "--server" && args[i + 1]) { result.server = args[++i]; }
    else if (args[i] === "--workspace" && args[i + 1]) { result.workspace = args[++i]; }
    else if (args[i] === "--install-task") { result.installTask = true; }
    else if (args[i] === "--task-dir" && args[i + 1]) { result.taskDir = args[++i]; }
    else { warn(`unknown arg ignored: ${args[i]}`); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// VS Code task installer
// ---------------------------------------------------------------------------

const TASKS_JSON = {
  version: "2.0.0",
  tasks: [
    {
      label: "Fix MCP pnpm path",
      type: "shell",
      command: "pnpm",
      args: ["dlx", "@kylebrodeur/mcp-mac-setup"],
      presentation: { reveal: "always", panel: "shared", focus: true },
      problemMatcher: [],
    },
    {
      label: "Fix MCP pnpm path (one server)",
      type: "shell",
      command: "pnpm",
      args: ["dlx", "@kylebrodeur/mcp-mac-setup", "--server", "${input:serverName}"],
      presentation: { reveal: "always", panel: "shared", focus: true },
      problemMatcher: [],
    },
  ],
  inputs: [
    {
      id: "serverName",
      type: "promptString",
      description: "MCP server name to update (e.g. playwright, memory)",
    },
  ],
};

function writeTaskFile(taskDir) {
  const vscodDir = taskDir || path.join(process.cwd(), ".vscode");
  const tasksPath = path.join(vscodDir, "tasks.json");

  fs.mkdirSync(vscodDir, { recursive: true });

  if (fs.existsSync(tasksPath)) {
    // Merge: add our tasks if not already present by label
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(tasksPath, "utf8"));
    } catch {
      existing = { version: "2.0.0", tasks: [] };
    }
    existing.tasks = existing.tasks || [];
    const existingLabels = new Set(existing.tasks.map(t => t.label));
    let added = 0;
    for (const task of TASKS_JSON.tasks) {
      if (!existingLabels.has(task.label)) {
        existing.tasks.push(task);
        added++;
      }
    }
    // Merge inputs
    existing.inputs = existing.inputs || [];
    const existingInputIds = new Set(existing.inputs.map(i => i.id));
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

  log("Run task: Cmd+Shift+P → Tasks: Run Task → Fix MCP pnpm path");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { target: targetArg, server: serverArg, workspace: workspaceArg, installTask, taskDir } = parseArgs();

  if (installTask) {
    writeTaskFile(taskDir);
    return;
  }

  const targetPath = targetArg || resolveTargetPath();

  log(`Target:  ${targetPath}`);

  const detected = detectPnpm();
  if (!detected) {
    throw new Error(
      "pnpm not found.\n" +
      "  Install via nvm:    nvm install --lts && corepack enable pnpm\n" +
      "  Install via fnm:    fnm install --lts && corepack enable pnpm\n" +
      "  Install standalone: https://pnpm.io/installation"
    );
  }

  const { pnpm, binDir, pnpmHome, source } = detected;
  log(`Detected: ${source}`);
  log(`  pnpm:     ${pnpm}`);
  log(`  binDir:   ${binDir}`);
  log(`  pnpmHome: ${pnpmHome}`);

  // When --target is a custom/temp path, seed it from the canonical user config
  // so dry-runs reflect real server definitions.
  const canonicalPath = resolveTargetPath();
  const isCustomTarget = targetPath !== canonicalPath;

  let config = ensureConfig(targetPath);
  config.servers = config.servers || {};

  // If the target is empty (new file / temp path), import all servers from canonical config
  if (isCustomTarget && !Object.keys(config.servers).length) {
    const canonicalConfig = ensureConfig(canonicalPath);
    config = { ...canonicalConfig };
    config.servers = { ...(canonicalConfig.servers || {}) };
    log(`  (target empty — seeded from ${canonicalPath})`);
  }

  // Discover all stdio servers across user + workspace + project configs
  const allDiscovered = discoverAllServers(workspaceArg);

  // Merge any discovered servers not yet in the target config (adds missing keys)
  for (const [name, def] of Object.entries(allDiscovered)) {
    if (!config.servers[name]) {
      config.servers[name] = def;
    }
  }

  const stdioServers = Object.keys(config.servers).filter(
    name => !isHttpServer(config.servers[name])
  );

  const serverNames = serverArg ? [serverArg] : stdioServers;

  if (!serverNames.length) {
    throw new Error(
      "No stdio servers found across:\n" +
      `  user:      ${canonicalPath}\n` +
      `  workspace: ${workspaceArg || path.join(process.cwd(), ".vscode", "mcp.json")}\n` +
      "Use --server <name> to specify one explicitly."
    );
  }

  const injectedPath = buildInjectedPath(binDir, pnpmHome);

  for (const name of serverNames) {
    const existing = config.servers[name] || {};

    if (isHttpServer(existing) && !existing.command) {
      log(`  skip ${name} (http/sse transport)`);
      continue;
    }

    const args = normalizeArgs(existing.args || []);
    const mergedEnv = {
      ...(existing.env || {}),
      PATH: injectedPath,
      PNPM_HOME: pnpmHome,
    };

    config.servers[name] = {
      ...existing,
      type: existing.type || "stdio",
      command: pnpm,
      args,
      env: mergedEnv,
    };

    log(`  updated ${name}  (command → ${pnpm})`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, "\t") + "\n");

  log(`\nWrote ${targetPath}`);
  log("Reload VS Code: Cmd+Shift+P → Developer: Reload Window");
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nerror: ${err.message}\n`);
  process.exit(1);
}
