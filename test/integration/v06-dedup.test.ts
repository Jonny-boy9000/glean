import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 6: dedup — second run skips already-produced candidates', () => {
  it('second run skipped_dedup >= first run ran', () => {
    // Setup repo with one TODO
    const repo = mkdtempSync(join(tmpdir(), 'glean-v6-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: dedup-test thing\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    // Use a shared HOME so dossiers persist across runs
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');

    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      FAKE_CLAUDE_SCENARIO: scenario,
    } as NodeJS.ProcessEnv;

    // Run 1
    const res1 = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env,
      encoding: 'utf8',
    });
    expect(res1.status).toBe(0);

    const stateDir1 = join(home, 'glean', 'state');
    const runIds1 = readdirSync(stateDir1).filter((f) => f !== 'RUN.lock');
    expect(runIds1.length).toBe(1);
    const summary1 = JSON.parse(readFileSync(join(stateDir1, runIds1[0], 'summary.json'), 'utf8'));
    const ranRun1: number = summary1.ran;

    // Run 2 — same home, same repo, same scenario
    const res2 = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env,
      encoding: 'utf8',
    });
    expect(res2.status).toBe(0);

    const runIds2 = readdirSync(stateDir1).filter((f) => f !== 'RUN.lock');
    // Should have 2 run dirs now
    expect(runIds2.length).toBe(2);
    const newRunId = runIds2.find((id) => id !== runIds1[0])!;
    const summary2 = JSON.parse(readFileSync(join(stateDir1, newRunId, 'summary.json'), 'utf8'));

    // Second run should have skipped at least as many as first run produced
    expect(summary2.skipped_dedup).toBeGreaterThanOrEqual(ranRun1);
  });
}, { timeout: 60_000 });
