import { describe, it, expect } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

describe('verification 4: STOP sentinel halts between tasks', () => {
  it('exits 30 with reason stop-sentinel', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v4-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: one\n');
    writeFileSync(join(repo, 'b.ts'), '// TODO: two\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
    // slow-exit.yaml sleeps 3s — long enough that the first task is still running when we write STOP
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'slow-exit.yaml');

    const child = spawn('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
    });
    await wait(2000); // let first task start (fake-claude sleeps 3s so it's still running)
    execSync(`node bin/glean.js stop`, { env: { ...process.env, USERPROFILE: home, HOME: home } });
    const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? -1)));
    expect(code).toBe(30);
    try { unlinkSync(join(home, 'glean', 'STOP')); } catch { /* */ }

    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(summary.reason).toBe('stop-sentinel');
  });
}, { timeout: 120_000 });
