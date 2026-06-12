import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v0.9 capacity governor: `glean usage` — self-relative weekly pacing from
// local JSONL accounting (internal loader, ADR-0007; weights ADR-0005).
// The CLI's clock is the real now(), so fixtures are generated RELATIVE to
// today: 35 days of constant usage makes every per-weekday baseline median
// equal to the daily amount, pinning the pace ratio at exactly 1.00 → small.

const DAILY_TOKENS = 1000; // sonnet (weight 1) → 1000 weighted per day

function usageLine(ts: Date, opts?: { cwd?: string; model?: string; tokens?: number; id?: string }): string {
  const id = opts?.id ?? `m-${ts.getTime()}-${Math.random().toString(36).slice(2)}`;
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts.toISOString(),
    cwd: opts?.cwd ?? 'C:\\fake\\repo',
    requestId: `r-${id}`,
    message: {
      id,
      model: opts?.model ?? 'claude-sonnet-4-5-20250929',
      usage: { input_tokens: opts?.tokens ?? DAILY_TOKENS, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

function setupHome(opts?: { historyDays?: number; pacing?: Record<string, unknown> }): { home: string } {
  const home = mkdtempSync(join(tmpdir(), 'glean-v25-home-'));
  mkdirSync(join(home, 'glean'), { recursive: true });
  const sessions = join(home, '.claude', 'projects', 'C--fake-repo');
  mkdirSync(sessions, { recursive: true });

  const historyDays = opts?.historyDays ?? 35;
  const now = new Date();
  const lines: string[] = [];
  for (let back = 0; back < historyDays; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 10, 0, 0);
    lines.push(usageLine(d));
  }
  writeFileSync(join(sessions, 'history.jsonl'), lines.join('\n') + '\n');

  // A glean-spawned session with ENORMOUS opus usage — must be excluded, or
  // the ratio blows past every threshold and the tier assertions below fail.
  const gleanSessions = join(home, '.claude', 'projects', 'glean-dossier');
  mkdirSync(gleanSessions, { recursive: true });
  writeFileSync(join(gleanSessions, 'spawned.jsonl'), usageLine(
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0),
    { cwd: join(home, 'glean', 'dossiers', 'proj', 'x'), model: 'claude-opus-4-1', tokens: 10_000_000 },
  ) + '\n');

  if (opts?.pacing) {
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ pacing: opts.pacing }));
  }
  return { home };
}

function runCli(home: string, args: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync('node', ['bin/glean.js', ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
}

describe('verification 25: glean usage CLI', () => {
  it('renders week-vs-baseline, pace ratio 1.00 → small, blind spot, honest capacity', () => {
    const { home } = setupHome();
    const res = runCli(home, ['usage']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/pace ratio/i);
    expect(res.stdout).toContain('1.00');
    expect(res.stdout).toContain('small');
    expect(res.stdout).toContain('claude.ai'); // the honest blind-spot note
    expect(res.stdout).toMatch(/no rate-limit telemetry/i); // no drain logs in this home
  });

  it('--json emits the machine-readable report the nightly gate consumes', () => {
    const { home } = setupHome();
    const res = runCli(home, ['usage', '--json']);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.recommendation.tier).toBe('small');
    expect(report.recommendation.budget_minutes).toBe(15);
    expect(report.recommendation.ratio).toBeCloseTo(1, 5);
    expect(report.recommendation.model_policy).toEqual({ restrict_types: ['fetch-docs'], model: 'haiku', promote_to_opus: [] });
    expect(report.recommendation.week.length).toBeGreaterThanOrEqual(1);
    expect(report.capacity.found).toBe(false);
    expect(typeof report.blind_spot).toBe('string');
    expect(typeof report.generated_at).toBe('string');
  });

  it('cold start (<14 days of history) reports insufficient baseline → small', () => {
    const { home } = setupHome({ historyDays: 3 });
    const res = runCli(home, ['usage', '--json']);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.recommendation.tier).toBe('small');
    expect(report.recommendation.insufficient_baseline).toBe(true);
    expect(report.recommendation.ratio).toBeNull();
  });

  it('honors pacing.haircut from config (1.00 + 0.5 → skip)', () => {
    const { home } = setupHome({ pacing: { haircut: 0.5 } });
    const res = runCli(home, ['usage', '--json']);
    const report = JSON.parse(res.stdout);
    expect(report.recommendation.effective_ratio).toBeCloseTo(1.5, 5);
    expect(report.recommendation.tier).toBe('skip');
  });

  it('honors pacing.enabled:false (no gating, tier normal)', () => {
    const { home } = setupHome({ pacing: { enabled: false } });
    const res = runCli(home, ['usage', '--json']);
    const report = JSON.parse(res.stdout);
    expect(report.recommendation.tier).toBe('normal');
    expect(report.recommendation.reason).toMatch(/disabled/i);
  });
});
