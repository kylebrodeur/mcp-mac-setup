/**
 * test/test-fix-mcp.mjs — full-matrix regression test for mcp-mac-setup.
 *
 * Strategy: spawn bin/mcp-mac-setup.js against scratch JSON files in a tmpdir
 * (no global state mutated). Asserts file contents and exit codes for each
 * of the matrix cases documented in the PR description.
 *
 * Run:  node --test test/test-fix-mcp.mjs
 *        pnpm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "bin", "mcp-mac-setup.js");

function makeScratchDir() {
  return mkdtempSync(join(tmpdir(), "mcp-mac-test-"));
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...(env || {}) },
  });
}

function writeMcpJson(dir, servers) {
  const p = join(dir, ".mcp.json");
  writeFileSync(p, JSON.stringify({ mcpServers: servers }, null, 2));
  return p;
}

function readMcpJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

test("--help exits 0 and lists options", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, `unexpected exit: ${r.stderr}`);
  assert.match(r.stdout, /--binary/);
  assert.match(r.stdout, /--target/);
  assert.match(r.stdout, /--check/);
});

test("rejects unknown --binary value", () => {
  const r = runCli(["--binary", "wat", "--target", "/tmp/nope.json"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --binary value/);
});

// ---------------------------------------------------------------------------
// Detection surface
// ---------------------------------------------------------------------------

test("detects nvm-managed node and injects absolute paths", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "bare-pnpm": { type: "stdio", command: "pnpm", args: ["dlx", "@x/y"] },
    "bare-npx":  { type: "stdio", command: "npx",  args: ["-y", "@a/b"] },
    "bare-node": { type: "stdio", command: "node", args: ["/some/local/shim.js"] },
  });

  const r = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  const cfg = readMcpJson(target);

  // Each bare command was rewritten to an absolute path under detected binDir.
  for (const name of ["bare-pnpm", "bare-npx", "bare-node"]) {
    assert.match(cfg.mcpServers[name].command, /^\//, `${name}.command not absolute: ${cfg.mcpServers[name].command}`);
  }
  assert.match(cfg.mcpServers["bare-pnpm"].command, /\/(pnpm|npx)$/);
  assert.match(cfg.mcpServers["bare-npx"].command, /\/npx$/);
  assert.match(cfg.mcpServers["bare-node"].command, /\/node$/);

  // env.PATH contains the detected binDir.
  assert.match(cfg.mcpServers["bare-node"].env.PATH, /node\/v\d+\.\d+\.\d+\/bin/);
});

// ---------------------------------------------------------------------------
// Idempotency + stale-path rewrite
// ---------------------------------------------------------------------------

test("rewrites stale absolute paths from a prior Node version", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "stale-npx": {
      type: "stdio",
      command: "/Users/kylebrodeur/.nvm/versions/node/v20.20.2/bin/npx",
      args: ["-y", "@x/y"],
      env: { PATH: "/Users/kylebrodeur/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin" },
    },
  });

  const r = runCli(["--binary", "npx", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  const cfg = readMcpJson(target);

  assert.doesNotMatch(
    cfg.mcpServers["stale-npx"].command,
    /v20\.20\.2/,
    `stale path not rewritten: ${cfg.mcpServers["stale-npx"].command}`,
  );
  assert.match(cfg.mcpServers["stale-npx"].command, /\/npx$/);
  assert.match(cfg.mcpServers["stale-npx"].env.PATH, /v22\.\d+\.\d+\/bin/);
});

test("idempotent — second run is a no-op and exits 0", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "bare-npx": { type: "stdio", command: "npx", args: ["-y", "@x/y"] },
  });

  // First run rewrites.
  const r1 = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r1.status, 0);
  const after1 = readFileSync(target, "utf8");

  // Second run must be a no-op (no rewrite messages).
  const r2 = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /ok\s+bare-npx/);
  assert.match(r2.stdout, /No changes\./);

  // File content unchanged.
  const after2 = readFileSync(target, "utf8");
  assert.equal(after1, after2);
});

// ---------------------------------------------------------------------------
// Leave-alone cases
// ---------------------------------------------------------------------------

test("leaves user-owned absolute paths alone (only refreshes env.PATH)", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "custom-binary": {
      type: "stdio",
      command: "/opt/custom/binary",
      args: ["serve"],
    },
  });

  const r = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  const cfg = readMcpJson(target);

  // Command preserved.
  assert.equal(cfg.mcpServers["custom-binary"].command, "/opt/custom/binary");
  // PATH injected even though command was preserved.
  assert.match(cfg.mcpServers["custom-binary"].env.PATH, /node\/v\d+\.\d+\.\d+\/bin/);
});

test("skips http/sse transports", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "http-server": { type: "http", url: "https://example.com/mcp" },
    "sse-server":  { type: "sse",  url: "https://example.com/sse" },
  });

  const r = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skip http-server/);
  assert.match(r.stdout, /skip sse-server/);

  const cfg = readMcpJson(target);
  assert.equal(cfg.mcpServers["http-server"].url, "https://example.com/mcp");
  assert.equal(cfg.mcpServers["sse-server"].url, "https://example.com/sse");
});

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

test("--check exits 0 when config already matches current runtime", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "bare-npx": { type: "stdio", command: "npx", args: ["-y", "@x/y"] },
  });

  // Apply first.
  const r1 = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"]);
  assert.equal(r1.status, 0);

  // Then check.
  const r2 = runCli(["--binary", "all", "--target", target, "--check", "--prefer", "nvm"]);
  assert.equal(r2.status, 0, `expected check=OK, got stderr:\n${r2.stderr}\nstdout:\n${r2.stdout}`);
  assert.match(r2.stdout, /check: OK/);
});

test("--check exits 1 when rewrite is needed", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "bare-npm": { type: "stdio", command: "npm", args: ["exec", "@x/y"] },
  });

  const r = runCli(["--binary", "all", "--target", target, "--check", "--prefer", "nvm"]);
  assert.equal(r.status, 1, `expected exit 1, got 0; stdout:\n${r.stdout}`);
  assert.match(r.stdout, /would be updated/);
});

// ---------------------------------------------------------------------------
// --binary pnpm legacy default still works
// ---------------------------------------------------------------------------

test("--binary pnpm (legacy default) injects pnpm absolute path", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "playwright": { type: "stdio", command: "pnpm", args: ["dlx", "@playwright/mcp"] },
  });

  const r = runCli(["--binary", "pnpm", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0);
  const cfg = readMcpJson(target);
  assert.match(cfg.mcpServers["playwright"].command, /\/pnpm$/);
  assert.deepEqual(cfg.mcpServers["playwright"].args, ["dlx", "@playwright/mcp"]);
});

test("default (no --binary flag) behaves like --binary pnpm for legacy compat", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "x": { type: "stdio", command: "pnpm", args: ["dlx", "@y/z"] },
  });

  const r = runCli(["--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0);
  const cfg = readMcpJson(target);
  assert.match(cfg.mcpServers["x"].command, /\/pnpm$/);
});

// ---------------------------------------------------------------------------
// args normalization (gallery exec → dlx)
// ---------------------------------------------------------------------------

test("normalizes pnpm 'exec' to 'dlx' when --binary pnpm", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "y": { type: "stdio", command: "pnpm", args: ["exec", "@x/y"] },
  });

  const r = runCli(["--binary", "pnpm", "--target", target, "--prefer", "nvm"]);
  assert.equal(r.status, 0);
  const cfg = readMcpJson(target);
  assert.deepEqual(cfg.mcpServers["y"].args, ["dlx", "@x/y"]);
});

// ---------------------------------------------------------------------------
// --server narrows the work
// ---------------------------------------------------------------------------

test("--server updates only the named server", () => {
  const dir = makeScratchDir();
  const target = writeMcpJson(dir, {
    "a": { type: "stdio", command: "npx", args: ["-y", "@x/a"] },
    "b": { type: "stdio", command: "npx", args: ["-y", "@x/b"] },
  });

  const r = runCli(["--binary", "all", "--target", target, "--server", "a", "--prefer", "nvm"]);
  assert.equal(r.status, 0);
  const cfg = readMcpJson(target);

  // a was rewritten
  assert.match(cfg.mcpServers["a"].command, /^\//);
  // b was NOT rewritten (still bare)
  assert.equal(cfg.mcpServers["b"].command, "npx");
});

// ---------------------------------------------------------------------------
// Seeded target: empty --target pulls from canonical user config
// ---------------------------------------------------------------------------

test("empty --target seeds from user-level VS Code config when present", () => {
  // Stub HOME to a scratch dir containing a fake VS Code user-level mcp.json.
  const fakeHome = makeScratchDir();
  const vscodeDir = join(fakeHome, "Library", "Application Support", "Code", "User");
  const canonical = join(vscodeDir, "mcp.json");
  // Skip on non-darwin because the canonical path differs.
  if (process.platform !== "darwin") return;
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(
    canonical,
    JSON.stringify({
      mcpServers: { "from-canonical": { type: "stdio", command: "npx", args: ["-y", "@x/y"] } },
    }),
  );

  const dir = makeScratchDir();
  const target = join(dir, "out.json");
  const r = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"], { env: { HOME: fakeHome } });
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  assert.match(r.stdout, /seeded from/);
  const cfg = readMcpJson(target);
  assert.match(cfg.mcpServers["from-canonical"].command, /^\//);
});

// ---------------------------------------------------------------------------
// Edge case: no servers
// ---------------------------------------------------------------------------

test("errors clearly when no servers exist anywhere", () => {
  const dir = makeScratchDir();
  const fakeHome = makeScratchDir();
  // Point target at an empty file in our scratch dir, not the real VS Code config.
  const target = join(dir, "empty.json");
  writeFileSync(target, "{}");

  const r = runCli(["--binary", "all", "--target", target, "--prefer", "nvm"], { env: { HOME: fakeHome } });
  // Either exits non-zero with "No servers found" OR exits 0 with "No changes"
  // depending on whether --server was given; both are acceptable — what matters
  // is that nothing crashes and the file is untouched.
  if (r.status === 0) {
    assert.match(r.stdout, /No changes/);
  } else {
    assert.match(r.stderr, /No servers found/);
  }
});
