import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0009: an auth failure (expired/missing login) must stop the run with the
// distinct reason 'auth-error' (exit 50), so a silently dead drain can't
// masquerade as a pile of failed tasks. The auth-error shape is UNVERIFIED — the
// fake-claude scenario uses claude's own stderr auth prose + a non-zero exit.
describe('verification 28: auth failure exits 50 with reason auth-error', () => {
  it('passes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v28-'));
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
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'auth-error.yaml');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    expect(res.status).toBe(50);
    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(summary.reason).toBe('auth-error');
  });
});
