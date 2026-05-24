import { describe, it, expect } from 'vitest';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

describe('verification 7: lock — concurrent second run exits 40', () => {
  it('second glean exits with code 40 when first is running', async () => {
    // Setup repo
    const repo = mkdtempSync(join(tmpdir(), 'glean-v7-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: lock-test\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    // long-running scenario sleeps 60s so first run stays alive
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'long-running.yaml');

    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      FAKE_CLAUDE_SCENARIO: scenario,
    } as NodeJS.ProcessEnv;

    // Start first glean run (long-running, will hold the lock)
    const first = spawn('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], { env });

    // Wait for first run to acquire the lock
    await wait(1500);

    // Spawn second run — should exit 40 immediately
    const res2 = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(res2.status).toBe(40);

    // Clean up: stop the first process
    try {
      execSync(`node bin/glean.js stop`, { env });
    } catch { /* ignore */ }

    // Wait for first to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if stop sentinel didn't work fast enough
        try { first.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 15_000);
      first.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });
}, { timeout: 60_000 });
