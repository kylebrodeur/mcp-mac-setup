/**
 * lib/detect-runtime.js — shared runtime detection + rewrite classifier.
 *
 * Detects nvm/fnm/PNPM_HOME-managed Node installations and exposes the
 * absolute paths needed to launch stdio MCP servers from GUI-launched
 * environments (VS Code, Cursor, Claude Desktop, Claude Code, etc.) that
 * don't inherit the user's interactive shell PATH.
 *
 * Public API:
 *   detectRuntime({ prefer })        → Runtime | null
 *   classifyCommand(cmd, env, binDir) → 'ok' | 'bare' | 'stale' | 'leave'
 *   pickLauncher(cmd, args, runtime) → { command, args }
 *   buildInjectedPath(binDir)       → string
 *   RESOLVABLE_COMMANDS             → Set<string>
 *   RUNTIME_BINARIES                → Set<string>
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Bare-name commands we know how to rewrite to absolute paths. Anything else
// (e.g. "/opt/custom/binary", "/Users/me/code/launcher.sh") is treated as
// user-owned and left alone.
const RESOLVABLE_COMMANDS = new Set(["node", "npx", "pnpm", "npm", "corepack"]);

// Subset that means "this server runs a Node tool that downloads/runs a
// package on demand" — the canonical MCP-server-launched-via-package-manager
// pattern. Used by `--binary auto` mode to choose which absolute path to
// inject for a given server.
const RUNTIME_BINARIES = new Set(["node", "npx", "pnpm", "npm", "corepack"]);

function resolvePnpmHome() {
  if (process.env.PNPM_HOME) return process.env.PNPM_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "pnpm");
  return path.join(os.homedir(), ".local", "share", "pnpm");
}

function readIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/**
 * Detect fnm-managed Node install. fnm's "default alias" symlink points to the
 * active Node version's bin directory.
 */
function detectFnm() {
  const fnmRoot = path.join(os.homedir(), ".local", "share", "fnm");
  if (!fileExists(fnmRoot)) return null;

  const binDir = path.join(fnmRoot, "aliases", "default", "bin");
  const node = path.join(binDir, "node");
  const npx = path.join(binDir, "npx");
  const pnpm = path.join(binDir, "pnpm");
  const npm = path.join(binDir, "npm");

  if (fileExists(node)) {
    return {
      node: fileExists(node) ? node : null,
      npx: fileExists(npx) ? npx : null,
      pnpm: fileExists(pnpm) ? pnpm : null,
      npm: fileExists(npm) ? npm : null,
      binDir,
      source: "fnm",
    };
  }
  return null;
}

/**
 * Detect nvm-managed Node install. nvm stores the active version in
 * `~/.nvm/alias/default` (a plain-text version string, e.g. "v22.19.0" or
 * "lts/hydrogen").
 */
function detectNvm() {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  const aliasFile = path.join(nvmDir, "alias", "default");
  const raw = readIfExists(aliasFile);
  if (!raw) return null;

  let version = raw.trim();
  // Aliases like "lts/hydrogen" aren't resolvable here; skip and fall back.
  if (!version.startsWith("v")) {
    if (/^\d/.test(version)) version = `v${version}`;
    else return null;
  }

  const binDir = path.join(nvmDir, "versions", "node", version, "bin");
  if (!fileExists(path.join(binDir, "node"))) return null;

  const candidate = (name) => fileExists(path.join(binDir, name)) ? path.join(binDir, name) : null;
  return {
    node: candidate("node"),
    npx: candidate("npx"),
    pnpm: candidate("pnpm"),
    npm: candidate("npm"),
    binDir,
    source: `nvm (${version})`,
    nvmDir,
    nvmBin: binDir,
  };
}

/**
 * Last-resort detection: PNPM_HOME, then `which pnpm`, then process.execPath.
 * Used only when neither nvm nor fnm is present. Warns because the resulting
 * absolute path may not survive a Node version switch.
 */
function detectFallback() {
  const pnpmHome = resolvePnpmHome();
  const fromHome = path.join(pnpmHome, "pnpm");
  if (fileExists(fromHome)) {
    return {
      pnpm: fromHome,
      node: process.execPath,
      binDir: pnpmHome,
      source: "PNPM_HOME",
      pnpmHome,
    };
  }

  const which = spawnSync("which", ["pnpm"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    const pnpm = which.stdout.trim();
    process.stderr.write(
      "warn: pnpm found via which — this path may not be stable if VS Code does not inherit your shell PATH.\n" +
      "warn: Consider using nvm or fnm for a stable absolute path.\n"
    );
    return { pnpm, node: process.execPath, binDir: path.dirname(pnpm), source: `which (${pnpm})`, pnpmHome };
  }

  return null;
}

/**
 * @typedef {Object} Runtime
 * @property {string|null} node      absolute path to node binary
 * @property {string|null} npx       absolute path to npx binary
 * @property {string|null} pnpm      absolute path to pnpm binary
 * @property {string|null} npm       absolute path to npm binary
 * @property {string}      binDir    directory containing the binaries (used for PATH injection)
 * @property {string}      source    human-readable detection source (for logs)
 * @property {string}      pnpmHome  PNPM_HOME value (for env injection)
 * @property {string}      [nvmDir]  NVM_DIR (only when detected via nvm)
 * @property {string}      [nvmBin]  resolved nvm bin dir (only when detected via nvm)
 */

/**
 * Detect the active Node-managed runtime.
 *
 * @param {Object}   [opts]
 * @param {"auto"|"fnm"|"nvm"} [opts.prefer="auto"]  Detection priority
 * @returns {Runtime | null}  null if nothing found
 */
function detectRuntime(opts = {}) {
  const prefer = opts.prefer || "auto";
  const order =
    prefer === "fnm" ? [detectFnm, detectNvm] :
    prefer === "nvm" ? [detectNvm, detectFnm] :
                        [detectFnm, detectNvm];

  for (const fn of order) {
    const r = fn();
    if (r && r.node) return { ...r, pnpmHome: r.pnpmHome || resolvePnpmHome() };
  }
  return detectFallback();
}

/**
 * Classify an existing `command` value against the detected runtime to decide
 * whether the rewrite step should run.
 *
 *   "ok"    — absolute path already inside detected binDir → already injected
 *   "bare"  — bare name ("node", "npx", ...) → needs absolute rewrite
 *   "stale" — absolute path to a managed Node binary in a different binDir → rewrite to current
 *   "leave" — anything else (user-owned absolute path) → do not touch
 */
function classifyCommand(command, _env, detectedBinDir) {
  if (!command) return "bare";
  const isAbsolute =
    command.startsWith("/") ||
    command.startsWith(".") ||
    command.includes(path.sep);
  if (isAbsolute) {
    if (command.startsWith(detectedBinDir)) return "ok";
    const base = command.split(path.sep).pop();
    if (RESOLVABLE_COMMANDS.has(base)) return "stale";
    return "leave";
  }
  return RESOLVABLE_COMMANDS.has(command) ? "bare" : "leave";
}

/**
 * Map a (possibly-bare, possibly-stale) command + args to the absolute
 * command + args we want in the rewritten config.
 *
 *   "node"           → runtime.node    (args unchanged)
 *   "npx"            → runtime.npx     (args unchanged)
 *   "pnpm" / "npm"   → runtime.npx     (npx + pnpm/npm both wrap npm scripts)
 *   absolute "node"  → runtime.node    (rewrite stale versions)
 *   absolute "npx"   → runtime.npx     (rewrite stale versions)
 *   anything else    → returned as-is  (caller already classified as 'leave')
 */
function pickLauncher(command, args, runtime) {
  const safeArgs = args || [];
  if (!command) return { command: runtime.node || process.execPath, args: safeArgs };
  if (command === "node") return { command: runtime.node, args: safeArgs };
  if (["npx", "pnpm", "npm", "corepack"].includes(command)) {
    return { command: runtime.npx || runtime.node, args: safeArgs };
  }
  if (command.startsWith("/") || command.startsWith(".") || command.includes(path.sep)) {
    const base = command.split(path.sep).pop();
    if (base === "node") return { command: runtime.node, args: safeArgs };
    if (base === "npx") return { command: runtime.npx || runtime.node, args: safeArgs };
    return { command, args: safeArgs };
  }
  return { command, args: safeArgs };
}

/**
 * Build the PATH string injected into server env. The detected binDir goes
 * first so the launcher can find its siblings (pnpm finds node, etc.).
 */
function buildInjectedPath(binDir) {
  const parts = [binDir, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(parts)].join(":");
}

/**
 * Normalize pnpm `exec` → `dlx` in args (some gallery configs emit "exec"
 * instead of "dlx" by mistake). Kept for backward compatibility with the
 * original mcp-mac-setup behavior.
 */
function normalizeArgs(args) {
  if (!Array.isArray(args) || !args.length) return args;
  if (args[0] === "exec" && args.length >= 2 && args[1].startsWith("@")) {
    return ["dlx", ...args.slice(1)];
  }
  return args;
}

module.exports = {
  RESOLVABLE_COMMANDS,
  RUNTIME_BINARIES,
  detectRuntime,
  classifyCommand,
  pickLauncher,
  buildInjectedPath,
  normalizeArgs,
};
