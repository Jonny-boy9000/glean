import { describe, it, expect } from 'vitest';
import type { DailyUsage } from './types.js';
import {
  MODEL_WEIGHTS,
  DEFAULT_THRESHOLDS,
  TIER_BUDGET_MINUTES,
  BLIND_SPOT_NOTE,
  weighDay,
  weekStart,
  recommendTier,
} from './pacing.js';

// v0.9 capacity governor — the pacing math, pinned by the design's "Pacing
// definition" section (binding): weighted tokens per model family
// (ASSUMPTION[ADR-0005]), per-weekday median over the trailing 4 complete
// calendar weeks, pace ratio = this-week cumulative / baseline cumulative
// through the same weekday, tiers >1.15 skip / 0.85–1.15 small / 0.5–0.85
// normal / <0.5 large.

const day = (date: string, sonnet = 0, opus = 0, haiku = 0, unknown = 0): DailyUsage => ({
  date,
  tokens: { haiku, sonnet, opus, unknown },
});

// Local-noon clock — far from any midnight/DST edge.
const at = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12, 0, 0);

describe('weighDay (golden, hand-computed — design success criterion 4)', () => {
  it('applies the ADR-0005 multipliers per family', () => {
    // 1000*0.25 + 200*1 + 100*5 + 50*1 = 250 + 200 + 500 + 50 = 1000
    expect(weighDay({ haiku: 1000, sonnet: 200, opus: 100, unknown: 50 })).toBe(1000);
  });

  it('pins the assumed multipliers: haiku 0.25, sonnet 1, opus 5, unknown 1', () => {
    expect(MODEL_WEIGHTS).toEqual({ haiku: 0.25, sonnet: 1, opus: 5, unknown: 1 });
  });

  it('accepts weight overrides', () => {
    expect(weighDay({ haiku: 0, sonnet: 100, opus: 10, unknown: 0 }, { opus: 10 })).toBe(200);
  });
});

describe('weekStart', () => {
  it('returns local Monday 00:00 of the calendar week', () => {
    const wed = weekStart(at(2026, 6, 10)); // Wed Jun 10 2026
    expect([wed.getFullYear(), wed.getMonth(), wed.getDate()]).toEqual([2026, 5, 8]);
    expect([wed.getHours(), wed.getMinutes()]).toEqual([0, 0]);
    expect(wed.getDay()).toBe(1); // Monday
  });

  it('treats Sunday as the LAST day of the week (ISO)', () => {
    const sun = weekStart(at(2026, 6, 14)); // Sun Jun 14 2026
    expect(sun.getDate()).toBe(8);
  });

  it('is identity-ish on a Monday', () => {
    expect(weekStart(at(2026, 6, 8)).getDate()).toBe(8);
  });
});

// A baseline fixture around now = Wed 2026-06-10 (week starts Mon 2026-06-08;
// baseline window = 2026-05-11 .. 2026-06-07, exactly 4 complete weeks).
// Mondays  (05-11, 05-18, 05-25, 06-01): 100, 200, 300, 400 → median 250
// Tuesdays (05-12, 05-19, 05-26, 06-02): all 1000          → median 1000
// Wednesday: usage on 05-13 ONLY (4000) → samples [4000,0,0,0] → median 0
//   (absent days COUNT AS ZERO — a weekday used 1 week in 4 has median 0)
// Baseline cumulative through Wed = 250 + 1000 + 0 = 1250.
function baselineDays(): DailyUsage[] {
  return [
    day('2026-05-11', 100),
    day('2026-05-18', 200),
    day('2026-05-25', 300),
    day('2026-06-01', 400),
    day('2026-05-12', 1000),
    day('2026-05-19', 1000),
    day('2026-05-26', 1000),
    day('2026-06-02', 1000),
    day('2026-05-13', 0, 0, 0, 4000),
    // history anchor so the 14-day cold-start guard is satisfied
    day('2026-05-01', 1),
  ];
}

describe('recommendTier — ratio + baseline math (golden)', () => {
  it('computes pace ratio = this-week cumulative / per-weekday-median cumulative', () => {
    const days = [
      ...baselineDays(),
      day('2026-06-08', 600), // Mon this week
      day('2026-06-09', 400), // Tue this week
    ];
    const rec = recommendTier({ days, now: at(2026, 6, 10) }); // Wed
    expect(rec.ratio).toBeCloseTo(1000 / 1250, 10); // 0.8
    expect(rec.effective_ratio).toBeCloseTo(0.8, 10);
    expect(rec.tier).toBe('normal');
    expect(rec.budget_minutes).toBe(60);
    expect(rec.insufficient_baseline).toBe(false);
    expect(rec.reason).toContain('0.80');
    // Per-day week rows (Mon..today) for the CLI mini table:
    expect(rec.week).toEqual([
      { date: '2026-06-08', weekday: 'Mon', actual: 600, baseline: 250 },
      { date: '2026-06-09', weekday: 'Tue', actual: 400, baseline: 1000 },
      { date: '2026-06-10', weekday: 'Wed', actual: 0, baseline: 0 },
    ]);
  });

  it('weights families before summing (haiku burns 4x slower, opus 5x faster)', () => {
    // Same shape but current-week Monday usage is 600 weighted via opus 120.
    const days = [...baselineDays(), day('2026-06-08', 0, 120)];
    const rec = recommendTier({ days, now: at(2026, 6, 10) });
    expect(rec.week[0].actual).toBe(600);
  });

  it('uses calendar weeks: a Sunday now covers all seven weekday medians', () => {
    const days = [...baselineDays(), day('2026-06-08', 600), day('2026-06-09', 400)];
    const rec = recommendTier({ days, now: at(2026, 6, 14) }); // Sun Jun 14
    expect(rec.week).toHaveLength(7);
    expect(rec.week[6].weekday).toBe('Sun');
    expect(rec.ratio).toBeCloseTo(1000 / 1250, 10); // Thu..Sun medians are all 0
  });
});

// Boundary fixture: all four baseline Mondays at 1000 → Monday median 1000;
// now = Monday → baseline cumulative is exactly 1000 and the current week is
// just Monday, so ratio = monday-usage / 1000.
function mondayFixture(currentMonday: number): DailyUsage[] {
  return [
    day('2026-05-11', 1000),
    day('2026-05-18', 1000),
    day('2026-05-25', 1000),
    day('2026-06-01', 1000),
    day('2026-05-01', 1), // history anchor
    day('2026-06-08', currentMonday),
  ];
}
const MON = at(2026, 6, 8);

describe('recommendTier — tier boundaries (design-pinned)', () => {
  it('>1.15 → skip', () => {
    const rec = recommendTier({ days: mondayFixture(1151), now: MON });
    expect(rec.tier).toBe('skip');
    expect(rec.budget_minutes).toBe(0);
    expect(rec.model_policy).toEqual({ restrict_types: [], model: null, promote_to_opus: [] });
  });

  it('exactly 1.15 → small (skip is strictly above)', () => {
    const rec = recommendTier({ days: mondayFixture(1150), now: MON });
    expect(rec.tier).toBe('small');
  });

  it('0.85–1.15 → small: 15m, fetch-docs only, haiku', () => {
    const rec = recommendTier({ days: mondayFixture(850), now: MON });
    expect(rec.tier).toBe('small');
    expect(rec.budget_minutes).toBe(15);
    expect(rec.model_policy).toEqual({ restrict_types: ['fetch-docs'], model: 'haiku', promote_to_opus: [] });
  });

  it('0.5–0.85 → normal: 60m, no restrictions', () => {
    const rec = recommendTier({ days: mondayFixture(849), now: MON });
    expect(rec.tier).toBe('normal');
    expect(rec.model_policy).toEqual({ restrict_types: null, model: null, promote_to_opus: [] });
    expect(recommendTier({ days: mondayFixture(500), now: MON }).tier).toBe('normal');
  });

  it('<0.5 → large: 120m, draft-impl promoted to opus', () => {
    const rec = recommendTier({ days: mondayFixture(499), now: MON });
    expect(rec.tier).toBe('large');
    expect(rec.budget_minutes).toBe(120);
    expect(rec.model_policy).toEqual({ restrict_types: null, model: null, promote_to_opus: ['draft-impl'] });
  });

  it('thresholds are config-overridable', () => {
    const rec = recommendTier({
      days: mondayFixture(700),
      now: MON,
      thresholds: { skip_above: 0.6 },
    });
    expect(rec.tier).toBe('skip');
  });

  it('pins the default thresholds and budgets', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ skip_above: 1.15, small_above: 0.85, normal_above: 0.5 });
    expect(TIER_BUDGET_MINUTES).toEqual({ skip: 0, small: 15, normal: 60, large: 120 });
  });
});

describe('recommendTier — haircut (blind-spot discount)', () => {
  it('adds the haircut to the measured ratio before tiering', () => {
    // raw 0.8 (+0.1) = 0.9 → small instead of normal
    const days = [...baselineDays(), day('2026-06-08', 600), day('2026-06-09', 400)];
    const rec = recommendTier({ days, now: at(2026, 6, 10), haircut: 0.1 });
    expect(rec.ratio).toBeCloseTo(0.8, 10);
    expect(rec.effective_ratio).toBeCloseTo(0.9, 10);
    expect(rec.tier).toBe('small');
    expect(rec.reason).toContain('haircut');
  });
});

describe('recommendTier — cold start and degenerate baselines', () => {
  it('<14 days of history → insufficient baseline, tier small, NEVER large', () => {
    // 6 days of history, zero current-week usage → a naive ratio would be 0 → large.
    const days = [day('2026-06-05', 50)];
    const rec = recommendTier({ days, now: at(2026, 6, 10) });
    expect(rec.tier).toBe('small');
    expect(rec.insufficient_baseline).toBe(true);
    expect(rec.ratio).toBeNull();
    expect(rec.reason).toMatch(/insufficient/i);
  });

  it('exactly 14 days of history is sufficient', () => {
    // earliest 2026-05-28, now Jun 10 → 14 calendar days of history
    const days = [day('2026-05-28', 1000), ...mondayFixture(800)].filter(
      (d) => d.date !== '2026-05-01',
    );
    const rec = recommendTier({ days, now: at(2026, 6, 10) });
    expect(rec.insufficient_baseline).toBe(false);
  });

  it('no usage history at all → small + insufficient', () => {
    const rec = recommendTier({ days: [], now: at(2026, 6, 10) });
    expect(rec.tier).toBe('small');
    expect(rec.insufficient_baseline).toBe(true);
  });

  it('zero baseline + zero current week → small (conservative, not large)', () => {
    // 4+ weeks old history exists, but none of it falls on this week's
    // weekdays-so-far → baseline cumulative 0.
    const days = [day('2026-04-01', 500), day('2026-05-16', 500)]; // a Sat in window
    const rec = recommendTier({ days, now: at(2026, 6, 8) }); // Mon
    expect(rec.tier).toBe('small');
    expect(rec.insufficient_baseline).toBe(true);
    expect(rec.ratio).toBeNull();
  });

  it('zero baseline but current-week usage → skip (over-pace vs a zero yardstick)', () => {
    const days = [day('2026-04-01', 500), day('2026-06-08', 100)];
    const rec = recommendTier({ days, now: at(2026, 6, 8) });
    expect(rec.tier).toBe('skip');
    expect(rec.ratio).toBeNull();
  });
});

describe('recommendTier — pacing.enabled:false', () => {
  it('reports tier normal with no gating and says why', () => {
    const rec = recommendTier({ days: mondayFixture(5000), now: MON, enabled: false });
    expect(rec.tier).toBe('normal');
    expect(rec.ratio).toBeNull();
    expect(rec.reason).toMatch(/disabled/i);
  });
});

describe('BLIND_SPOT_NOTE', () => {
  it('states the local-JSONL blind spot honestly', () => {
    expect(BLIND_SPOT_NOTE).toMatch(/claude\.ai/i);
    expect(BLIND_SPOT_NOTE).toMatch(/other machines/i);
  });
});

// PIECE 1 (#3): user-input subscription week anchor. An optional weekAnchor
// shifts the "week" boundary (and the baseline window) to start at the
// configured day/time instead of Monday 00:00. Pure — anchor is passed in.
describe('weekStart — with a week anchor', () => {
  it('Saturday-03:00 anchor: a Wednesday belongs to the prior Saturday', () => {
    // now = Wed 2026-06-10 12:00. Most recent Saturday 03:00 is Sat 2026-06-06.
    const ws = weekStart(at(2026, 6, 10), { day: 'Saturday', time: '03:00' });
    expect([ws.getFullYear(), ws.getMonth(), ws.getDate()]).toEqual([2026, 5, 6]);
    expect([ws.getHours(), ws.getMinutes()]).toEqual([3, 0]);
    expect(ws.getDay()).toBe(6); // Saturday
  });

  it('on the anchor day BEFORE the anchor time, the week started a week earlier', () => {
    // now = Sat 2026-06-13 at 01:00 (before 03:00) → week started Sat 2026-06-06 03:00.
    const ws = weekStart(new Date(2026, 5, 13, 1, 0), { day: 'Saturday', time: '03:00' });
    expect(ws.getDate()).toBe(6);
  });

  it('on the anchor day AT/AFTER the anchor time, the week starts today', () => {
    // now = Sat 2026-06-13 at 05:00 (after 03:00) → week started Sat 2026-06-13 03:00.
    const ws = weekStart(new Date(2026, 5, 13, 5, 0), { day: 'Saturday', time: '03:00' });
    expect(ws.getDate()).toBe(13);
    expect(ws.getHours()).toBe(3);
  });

  it('no anchor is byte-identical to the Monday-00:00 calendar week', () => {
    const a = weekStart(at(2026, 6, 10));
    const b = weekStart(at(2026, 6, 10), undefined);
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('recommendTier — with a week anchor', () => {
  // Saturday-03:00 anchor. now = Wed 2026-06-10 → week started Sat 2026-06-06.
  // Baseline window = the 4 anchor-weeks before, starting Sat 2026-05-09 03:00.
  // Anchor-week weekday 0 = Saturday; the current week through Wed spans
  // Sat,Sun,Mon,Tue,Wed (5 rows).
  function anchorBaseline(): DailyUsage[] {
    return [
      // Saturdays of the 4 baseline weeks: 05-09, 05-16, 05-23, 05-30 → 100,200,300,400 → median 250
      day('2026-05-09', 100), day('2026-05-16', 200), day('2026-05-23', 300), day('2026-05-30', 400),
      // history anchor so the 14-day cold-start guard is satisfied
      day('2026-04-25', 1),
    ];
  }

  it('the current-week rows start on the anchor weekday (Sat)', () => {
    const rec = recommendTier({
      days: [...anchorBaseline(), day('2026-06-06', 500)], // Sat this anchor-week
      now: at(2026, 6, 10),
      weekAnchor: { day: 'Saturday', time: '03:00' },
    });
    expect(rec.week[0].weekday).toBe('Sat');
    expect(rec.week[0].date).toBe('2026-06-06');
    expect(rec.week[0].actual).toBe(500);
    expect(rec.week[0].baseline).toBe(250); // median of 100,200,300,400
    expect(rec.week).toHaveLength(5); // Sat..Wed
    expect(rec.week[4].weekday).toBe('Wed');
  });

  it('no anchor produces the identical recommendation to today (no drift)', () => {
    const days = [...baselineDays(), day('2026-06-08', 600), day('2026-06-09', 400)];
    const withUndef = recommendTier({ days, now: at(2026, 6, 10), weekAnchor: undefined });
    const without = recommendTier({ days, now: at(2026, 6, 10) });
    expect(withUndef).toEqual(without);
  });
});
