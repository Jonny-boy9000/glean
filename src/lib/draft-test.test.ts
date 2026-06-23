import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preambleOf, preambleLooksLikeEnvFailure, runTestCommand } from './draft-test.js';
import { linkBaseNodeModules, unlinkNodeModulesLink } from './draft-git.js';

// ADR-0014: an env failure means the suite NEVER STARTED, so its signature can only
// be in the runner's startup preamble — never interleaved with real test output.
describe('preamble-anchored env-failure detection (ADR-0014)', () => {
  it('env signature on line 1 with no fence → whole output is preamble → true (env-blocked)', () => {
    expect(preambleLooksLikeEnvFailure("Error: Cannot find module 'vitest'\n    at Module._resolve")).toBe(true);
  });

  it('env signature on line 1, a test fence on line 2 → still true (the sig is BEFORE the fence)', () => {
    expect(preambleLooksLikeEnvFailure('cannot find module foo\nPASS src/a.test.ts')).toBe(true);
  });

  it('a test fence FIRST, then a late "enoent" in test output → FALSE (a real fail stays fail)', () => {
    expect(preambleLooksLikeEnvFailure('PASS src/a.test.ts\n  AssertionError: expected ENOENT but got OK')).toBe(false);
  });

  it('env signature beyond the 50-line preamble cap (no earlier fence) → not scanned → false', () => {
    const out = Array.from({ length: 60 }, (_, i) => `noise line ${i}`).join('\n') + '\nenoent down here';
    expect(preambleLooksLikeEnvFailure(out)).toBe(false);
  });

  it('case-insensitive in the preamble', () => {
    expect(preambleLooksLikeEnvFailure('CANNOT FIND MODULE foo')).toBe(true);
  });

  it('a clean run (a fence, no env signature) → false', () => {
    expect(preambleLooksLikeEnvFailure('RUN v1.6.1\nPASS src/a.test.ts\nTests 3 passed')).toBe(false);
  });

  it('a "missing script" startup error (whole output is preamble) → true', () => {
    expect(preambleLooksLikeEnvFailure('npm ERR! missing script: test')).toBe(true);
  });

  it('preambleOf cuts at the first fence line', () => {
    expect(preambleOf('startup banner\nPASS src/a.test.ts\ntrailing')).toBe('startup banner');
  });

  it('preambleOf with no fence returns the (capped) whole output', () => {
    expect(preambleOf('only\ntwo lines')).toBe('only\ntwo lines');
  });
});

// ADR-0014: the node_modules link makes a Node draft's declared deps resolvable for
// glean's out-of-session test run, so a draft that would 'env-blocked' on a bare
// worktree reaches 'pass' after linking. (The executor links post-spawn-death.)
describe('node_modules link → reachable deps (ADR-0014)', () => {
  it('absent → env-blocked; linked → pass; teardown removes only the link', () => {
    const base = mkdtempSync(join(tmpdir(), 'glean-nm-base-'));
    const worktree = mkdtempSync(join(tmpdir(), 'glean-nm-wt-'));
    try {
      // A fake module present ONLY in the base checkout's node_modules.
      mkdirSync(join(base, 'node_modules', 'faketestmod'), { recursive: true });
      writeFileSync(join(base, 'node_modules', 'faketestmod', 'package.json'), JSON.stringify({ name: 'faketestmod', main: 'index.js' }));
      writeFileSync(join(base, 'node_modules', 'faketestmod', 'index.js'), 'module.exports = 1;\n');
      const cmd = `node -e "require('faketestmod'); process.exit(0)"`;

      // Bare worktree can't resolve it → suite never started → env-blocked.
      expect(runTestCommand(cmd, worktree, 30_000)).toBe('env-blocked');

      // Link base node_modules in (post-spawn-death) → now it resolves → pass.
      const link = linkBaseNodeModules(base, worktree, true);
      expect(link.linked).toBe(true);
      expect(runTestCommand(cmd, worktree, 30_000)).toBe('pass');

      // Teardown removes ONLY the link, never the base module.
      if (link.path) unlinkNodeModulesLink(link.path);
      expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
      expect(existsSync(join(base, 'node_modules', 'faketestmod'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('is a no-op when descendantsDead is false, or the base has no node_modules', () => {
    const base = mkdtempSync(join(tmpdir(), 'glean-nm-base2-'));
    const worktree = mkdtempSync(join(tmpdir(), 'glean-nm-wt2-'));
    try {
      expect(linkBaseNodeModules(base, worktree, false).linked).toBe(false); // not dead
      expect(linkBaseNodeModules(base, worktree, true).linked).toBe(false);  // base has no deps
      expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
