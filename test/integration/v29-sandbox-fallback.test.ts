import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0013: on native Windows the OS sandbox does NOT exist, so config.enforce_spawn
// must fall back to Narrow — with a LOUD warning — and must NOT inject `--settings`
// (a silent unsandboxed run claiming enforcement is the failure mode this guards).
// This proves the safe Windows behaviour; the actual HARD-boundary proof runs on a
// mac/Linux/WSL2 runner (v30, self-skipped here).
describe.skipIf(process.platform !== 'win32')('verification 29: enforce_spawn falls back to Narrow on native Windows', () => {
  it('emits the warning and passes NO --settings to the spawn', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v29-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd');
    const argvOut = join(home, 'argv.jsonl');
    mkdirSync(join(home, 'glean'), { recursive: true });
    // enforce_spawn ON + base_branch set (enables draft-impl, the path that spawns Bash).
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({
      claude_bin: fakeClaude,
      enforce_spawn: true,
      projects: { [repo]: { base_branch: 'main' } },
    }));
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_ARGV_OUT: argvOut },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    // The loud fallback warning is on stderr.
    expect(res.stderr).toMatch(/enforce_spawn is set but the OS sandbox is unavailable/i);
    expect(res.stderr).toMatch(/NOT a hard filesystem boundary/i);

    // No spawn argv carries --settings / --setting-sources (Narrow fallback).
    expect(existsSync(argvOut)).toBe(true);
    const invocations = readFileSync(argvOut, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    for (const argv of invocations) {
      expect(argv).not.toContain('--settings');
      expect(argv).not.toContain('--setting-sources');
      // The deny-list invariant still holds on the fallback path.
      expect(argv).toContain('--disallowedTools');
    }
  });
});
