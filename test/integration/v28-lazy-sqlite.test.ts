import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// F6: better-sqlite3 (a native module) must load LAZILY — only when a command
// that actually needs telemetry/memory runs. A broken native binding (common
// for a global `npm i -g` on a Node ABI without a prebuilt) must NOT prevent
// `glean version` / `--help` / etc. from starting.
//
// We prove this by spawning the built CLI with a --require shim that makes
// `require('better-sqlite3')` throw. If `version` still exits 0 and prints the
// version, better-sqlite3 is provably NOT on the startup path.

function brokenSqliteShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'glean-shim-'));
  const shim = join(dir, 'break-sqlite.cjs');
  // Intercept module loading: any attempt to load better-sqlite3 throws, exactly
  // as a missing/mismatched native binding would. This does NOT touch the real
  // installed module on disk.
  writeFileSync(
    shim,
    [
      "const Module = require('node:module');",
      'const orig = Module._load;',
      'Module._load = function (request, parent, isMain) {',
      "  if (request === 'better-sqlite3' || request.includes('better-sqlite3')) {",
      "    throw new Error('SHIM: better-sqlite3 native binding is broken');",
      '  }',
      '  return orig.apply(this, arguments);',
      '};',
      '',
    ].join('\n'),
  );
  return shim;
}

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

describe('verification 28: better-sqlite3 loads lazily, broken binding does not break startup', () => {
  it('glean version exits 0 and prints the version even when better-sqlite3 is broken', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const shim = brokenSqliteShim();
    // No inner quotes around the path: NODE_OPTIONS preload resolution on Windows
    // mishandles quoted paths, and os.tmpdir() paths never contain spaces.
    const res = spawnSync('node', ['bin/glean.js', 'version'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_OPTIONS: `--require ${shim}` },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkgVersion);
  });

  it('glean --help exits 0 even when better-sqlite3 is broken', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const shim = brokenSqliteShim();
    const res = spawnSync('node', ['bin/glean.js', '--help'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_OPTIONS: `--require ${shim}` },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
  });

  it('memory-backed command (rate) degrades with a clear warning, not a native crash', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const shim = brokenSqliteShim();
    const res = spawnSync('node', ['bin/glean.js', 'rate', '--list'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_OPTIONS: `--require ${shim}` },
      encoding: 'utf8',
    });
    // Non-zero (rating genuinely needs sqlite) but a clean one-line warning — not
    // an unhandled native-module stack trace.
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('telemetry disabled (better-sqlite3 unavailable');
    expect(res.stderr).not.toContain('at Module._load');
  });

  it('glean doctor runs under a broken sqlite binding: reports sqlite WARN but still exits 0', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const shim = brokenSqliteShim();
    const res = spawnSync('node', ['bin/glean.js', 'doctor'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, NODE_OPTIONS: `--require ${shim}` },
      encoding: 'utf8',
    });
    // sqlite is a WARN (not a hard requirement), so a broken binding must NOT
    // make doctor fail — doctor is precisely the tool that diagnoses this.
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('WARN');
    expect(res.stdout).toContain('better-sqlite3');
  });

  it('built dist/cli.js reaches memory.js only via dynamic import, never a top-level static import', () => {
    const cli = readFileSync('dist/cli.js', 'utf8');
    // No top-level `import ... from '.../memory.js'` and no static imports of the
    // memory-bearing modules (pipeline/today/morning/peek/runDrain). They must
    // all be reached via `await import(...)` inside command handlers.
    const staticImportOfMemoryBearing = /^import\s+.*from\s+['"]\.\/lib\/(memory|pipeline|runDrain|today|morning|peek|rate|repair)\.js['"]/m;
    expect(cli).not.toMatch(staticImportOfMemoryBearing);
  });
});
