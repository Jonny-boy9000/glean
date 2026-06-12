import { describe, it, expect } from 'vitest';
import { renderUsage, type UsageReport } from './render-usage.js';
import type { TierRecommendation } from './pacing.js';
import { BLIND_SPOT_NOTE } from './pacing.js';
import type { CapacityInfo } from './dashboard-data.js';

const REC: TierRecommendation = {
  tier: 'normal',
  ratio: 0.8,
  effective_ratio: 0.8,
  reason: 'pace 0.80: 1,000 weighted tokens this week vs 1,250 baseline through Wed → normal (60m)',
  budget_minutes: 60,
  model_policy: { restrict_types: null, model: null, promote_to_opus: [] },
  week: [
    { date: '2026-06-08', weekday: 'Mon', actual: 600, baseline: 250 },
    { date: '2026-06-09', weekday: 'Tue', actual: 400, baseline: 1000 },
    { date: '2026-06-10', weekday: 'Wed', actual: 0, baseline: 0 },
  ],
  insufficient_baseline: false,
};

const CAP_FOUND: CapacityInfo = {
  found: true,
  run_id: '2026-06-11-1800-d705f9',
  task_id: 'abc',
  captured_at: '2026-06-11T18:30:00.000Z',
  status: 'allowed_warning',
  rate_limit_type: 'five_hour',
  utilization: 0.93,
  resets_at: '2026-06-11T20:00:00.000Z',
  is_using_overage: false,
};

const CAP_NONE: CapacityInfo = {
  found: false, run_id: null, task_id: null, captured_at: null,
  status: null, rate_limit_type: null, utilization: null, resets_at: null, is_using_overage: null,
};

function report(over?: Partial<UsageReport>): UsageReport {
  return {
    generated_at: '2026-06-10T10:00:00.000Z',
    recommendation: REC,
    capacity: CAP_NONE,
    blind_spot: BLIND_SPOT_NOTE,
    ...over,
  };
}

describe('renderUsage', () => {
  it('renders the per-day week-vs-baseline mini table with totals', () => {
    const out = renderUsage(report(), false);
    expect(out).toContain('Mon');
    expect(out).toContain('2026-06-08');
    expect(out).toContain('600');
    expect(out).toContain('1,000'); // week total
    expect(out).toContain('1,250'); // baseline total
    expect(out).toMatch(/this week/i);
    expect(out).toMatch(/baseline/i);
  });

  it('shows the pace ratio, tier recommendation and reasoning', () => {
    const out = renderUsage(report(), false);
    expect(out).toContain('0.80');
    expect(out).toMatch(/normal/);
    expect(out).toContain('60m');
    expect(out).toContain(REC.reason);
  });

  it('always prints the honest blind-spot note', () => {
    expect(renderUsage(report(), false)).toContain('claude.ai');
  });

  it('renders the last captured five_hour utilization when telemetry exists', () => {
    const out = renderUsage(report({ capacity: CAP_FOUND }), false);
    expect(out).toContain('93%');
    expect(out).toContain('five_hour');
  });

  it('says so honestly when no rate-limit telemetry has been captured', () => {
    expect(renderUsage(report(), false)).toMatch(/no rate-limit telemetry/i);
  });

  it('renders an em-dash ratio for insufficient-baseline reports', () => {
    const rec: TierRecommendation = {
      ...REC,
      tier: 'small',
      ratio: null,
      effective_ratio: null,
      insufficient_baseline: true,
      budget_minutes: 15,
      reason: 'insufficient baseline (6 days of history; need 14) → small',
    };
    const out = renderUsage(report({ recommendation: rec }), false);
    expect(out).toContain('—');
    expect(out).toMatch(/insufficient/);
  });

  it('emits no ANSI codes when useColor is false, some when true', () => {
    expect(renderUsage(report(), false)).not.toContain('\x1b[');
    expect(renderUsage(report(), true)).toContain('\x1b[');
  });
});
