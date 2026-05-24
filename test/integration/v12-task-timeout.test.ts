import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 12: --task-timeout kills tasks early', () => {
  it('with --task-timeout 2s, a long-sleeping task gets killed and marked timed_out', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v12-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'timeout.yaml');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--task-timeout', '2s'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect([0, 10]).toContain(res.status);
    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(summary.timed_out).toBeGreaterThan(0);
  });
});
