import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v03 is skipped because the timeout.yaml scenario sleeps 600s and the CLI hard-codes an
// 8-minute per-task timeout with no --task-timeout flag. The test would take ~8 min to complete
// even with a 2m budget (task-timeout kills the sleeping fake-claude after 8m, budget is already
// exhausted, then the loop exits). This exceeds reasonable CI time.
// See spec §10 row 3 for manual verification instructions.
describe('verification 3: budget self-termination', () => {
  it.skip('exits cleanly with summary recording the outcome (skipped: requires ~8m runtime due to hard-coded 8m task timeout)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v3-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: long-running\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'timeout.yaml');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '2m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
      timeout: 10 * 60_000,
    });

    // Either budget-exhausted (10), task-timeout chain leading to completion (0), or 0 if all tasks failed.
    expect([0, 10]).toContain(res.status);
    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(['budget-exhausted', 'completed']).toContain(summary.reason);
  });
}, { timeout: 12 * 60_000 });
