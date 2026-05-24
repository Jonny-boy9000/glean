import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 10: stale lock — dead-PID lock is recovered and run proceeds', () => {
  it('exits 0 and orchestrator.log contains lock.stale_recovered', () => {
    // Setup repo
    const repo = mkdtempSync(join(tmpdir(), 'glean-v10-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: stale-lock-test\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));

    // Pre-write a stale lock with a definitely-dead PID
    mkdirSync(join(home, 'glean', 'state'), { recursive: true });
    writeFileSync(
      join(home, 'glean', 'state', 'RUN.lock'),
      JSON.stringify({ pid: 999999, run_id: 'old-dead-run', started_at: new Date().toISOString() }),
    );

    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
    } as NodeJS.ProcessEnv;

    // Run dry-run — should recover the stale lock and complete normally
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--dry-run'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(res.status).toBe(0);

    // Find the log for this run
    const logsDir = join(home, 'glean', 'logs');
    const runs = readdirSync(logsDir);
    expect(runs.length).toBe(1);

    const logContent = readFileSync(join(logsDir, runs[0], 'orchestrator.log'), 'utf8');

    // Should contain the stale recovery event
    expect(logContent).toContain('lock.stale_recovered');
  });
}, { timeout: 30_000 });
