import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v21 — the drain loop end-to-end through the REAL CLI (exit-and-re-enter).
// The unit tests (runDrain.test.ts) mock the burst; this drives the real
// executor -> pipeline -> classify -> budget.json -> re-entry path. Time can't be
// injected through a subprocess, so re-entry is exercised via the persisted
// next_eligible_at (a future value -> a no-op tick; rewound to the past -> resume).
//
// NOTE: the fixture stderr ("Try again in 4 hours" / "in 3 days") is a plausible
// shape, NOT the empirically-captured wording (Spike B is pending). The test
// validates the LOOP given a classifiable signal; the classifier format table
// updates when real stderr lands, without changing this test's assertions.

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'glean-v21-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: implement the drain\n');
  execSync('git add . && git commit -q -m i', { cwd: repo });
  return repo;
}

function makeHome(scenarioFile: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
  const fakeClaude = process.platform === 'win32'
    ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
    : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
  mkdirSync(join(home, 'glean'), { recursive: true });
  writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
  const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', scenarioFile);
  return { home, env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario } };
}

function drainOnce(repo: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const res = spawnSync('node', ['bin/glean.js', 'run', '--drain', '--project', repo, '--budget', '60m'], {
    env, encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

function budgetPath(home: string): string {
  return join(home, 'glean', 'state', 'budget.json');
}
function runDirs(home: string): string[] {
  const dir = join(home, 'glean', 'state');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f !== 'RUN.lock' && f !== 'budget.json');
}

describe('v21 drain: session pause → no-op tick → resume', () => {
  it('persists a future next_eligible_at, no-ops the next tick, resumes when rewound', () => {
    const repo = makeRepo();
    const { home, env } = makeHome('session-limit.yaml');

    // Tick 1: hits the 5-hour (session) limit → pauses with a future next_eligible_at.
    drainOnce(repo, env);
    expect(existsSync(budgetPath(home))).toBe(true);
    const b1 = JSON.parse(readFileSync(budgetPath(home), 'utf8'));
    expect(b1.week_exhausted).toBe(false);
    expect(b1.next_eligible_at).not.toBeNull();
    expect(Date.parse(b1.next_eligible_at)).toBeGreaterThan(Date.now());
    const runsAfter1 = runDirs(home).length;
    expect(runsAfter1).toBeGreaterThan(0); // a real burst ran

    // Tick 2: now < next_eligible_at → not-eligible no-op (no new burst, exit 0).
    const t2 = drainOnce(repo, env);
    expect(t2.status).toBe(0);
    expect(t2.stdout).toContain('not-eligible');
    expect(runDirs(home).length).toBe(runsAfter1); // NO new run row created

    // Tick 3: rewind next_eligible_at into the past → eligible → resumes a burst.
    const b = JSON.parse(readFileSync(budgetPath(home), 'utf8'));
    b.next_eligible_at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(budgetPath(home), JSON.stringify(b));
    drainOnce(repo, env);
    expect(runDirs(home).length).toBeGreaterThan(runsAfter1); // a fresh burst ran
  });
});

describe('v21 drain: weekly limit stops the window', () => {
  it('marks week_exhausted and no-ops subsequent ticks', () => {
    const repo = makeRepo();
    const { home, env } = makeHome('weekly-limit.yaml');

    // Tick 1: hits the weekly limit → week_exhausted, reset days away.
    drainOnce(repo, env);
    const b1 = JSON.parse(readFileSync(budgetPath(home), 'utf8'));
    expect(b1.week_exhausted).toBe(true);
    expect(b1.last_observed_weekly_reset).not.toBeNull();
    expect(Date.parse(b1.last_observed_weekly_reset)).toBeGreaterThan(Date.now());
    const runsAfter1 = runDirs(home).length;

    // Tick 2: week_exhausted and before the reset → weekly-drained no-op.
    const t2 = drainOnce(repo, env);
    expect(t2.status).toBe(0);
    expect(t2.stdout).toContain('weekly-drained');
    expect(runDirs(home).length).toBe(runsAfter1); // NO new burst
  });
});
