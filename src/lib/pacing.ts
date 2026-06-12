import type { CandidateType, DailyUsage, ModelFamily } from './types.js';
import { localDateKey } from './usage.js';

/**
 * v0.9 capacity governor — the pacing engine. PURE: no I/O, injectable clock
 * (`now` is always a parameter). The math is pinned by the design's "Pacing
 * definition" section (docs/design/2026-06-12-capacity-governor-strategy.md):
 *
 * - weighted tokens per model family (multipliers below);
 * - baseline = per-weekday MEDIAN of weighted daily tokens over the trailing
 *   4 complete CALENDAR weeks (28 days ending at the current week's Monday —
 *   calendar weeks, NOT the rolling reset anchor, which is unknowable per
 *   ADR-0001; days with no recorded usage count as ZERO);
 * - pace ratio = this-calendar-week cumulative through today / baseline
 *   cumulative through the same weekday;
 * - tiers: >1.15 skip · 0.85–1.15 small · 0.5–0.85 normal · <0.5 large.
 */

// ASSUMPTION[ADR-0005]: cross-model token mixes are apples-to-oranges and
// Anthropic publishes no numeric multiplier — these weights are a consistency
// device, not truth. 'unknown' rides at 1.0 (sonnet-equivalent).
export const MODEL_WEIGHTS: Record<ModelFamily, number> = {
  haiku: 0.25,
  sonnet: 1,
  opus: 5,
  unknown: 1,
};

export type Tier = 'skip' | 'small' | 'normal' | 'large';

export type TierThresholds = {
  /** Effective ratio strictly above this → skip. */
  skip_above: number;
  /** Effective ratio at/above this (and ≤ skip_above) → small. */
  small_above: number;
  /** Effective ratio at/above this (and < small_above) → normal; below → large. */
  normal_above: number;
};

export const DEFAULT_THRESHOLDS: TierThresholds = {
  skip_above: 1.15,
  small_above: 0.85,
  normal_above: 0.5,
};

export const TIER_BUDGET_MINUTES: Record<Tier, number> = {
  skip: 0,
  small: 15,
  normal: 60,
  large: 120,
};

/** What a tier permits — consumed by the nightly preset (wave 2). */
export type ModelPolicy = {
  /** When non-null, ONLY these candidate types may run ([] = nothing runs). */
  restrict_types: CandidateType[] | null;
  /** Model override for every spawned task (small tier: 'haiku'); null = per-type defaults. */
  model: string | null;
  /** Task types an under-pace week promotes to opus (design: draft-impl only). */
  promote_to_opus: CandidateType[];
};

const TIER_POLICY: Record<Tier, ModelPolicy> = {
  skip: { restrict_types: [], model: null, promote_to_opus: [] },
  small: { restrict_types: ['fetch-docs'], model: 'haiku', promote_to_opus: [] },
  normal: { restrict_types: null, model: null, promote_to_opus: [] },
  large: { restrict_types: null, model: null, promote_to_opus: ['draft-impl'] },
};

export type WeekRow = {
  date: string; // local YYYY-MM-DD
  weekday: string; // Mon..Sun
  actual: number; // weighted tokens recorded that day
  baseline: number; // per-weekday median over the trailing 4 complete weeks
};

export type TierRecommendation = {
  tier: Tier;
  /** Measured pace ratio (null when no honest ratio exists). */
  ratio: number | null;
  /** Ratio the tiers acted on: measured + haircut. */
  effective_ratio: number | null;
  reason: string;
  budget_minutes: number;
  model_policy: ModelPolicy;
  /** Current week, Monday through today — the CLI's mini table. */
  week: WeekRow[];
  insufficient_baseline: boolean;
};

export type RecommendOpts = {
  days: DailyUsage[];
  now: Date;
  /** pacing.enabled — false disables gating entirely (tier 'normal'). */
  enabled?: boolean;
  /** pacing.haircut (0–1) — manual discount for the local-JSONL blind spot. */
  haircut?: number;
  thresholds?: Partial<TierThresholds>;
  weights?: Partial<Record<ModelFamily, number>>;
};

/** Honest blind-spot disclosure rendered by `glean usage` (design-mandated). */
export const BLIND_SPOT_NOTE =
  'Blind spot: claude.ai web/desktop chat and other machines share the weekly cap ' +
  'but write no local JSONL here — an under-pace reading may be wrong if usage ' +
  'shifted elsewhere. Config: pacing.haircut (0-1) discounts for this; ' +
  'pacing.enabled:false turns the gate off.';

/** Weighted-token total for one day's per-family raw counts. */
export function weighDay(
  tokens: Record<ModelFamily, number>,
  weights?: Partial<Record<ModelFamily, number>>,
): number {
  const w = { ...MODEL_WEIGHTS, ...weights };
  return (Object.keys(tokens) as ModelFamily[]).reduce((sum, f) => sum + tokens[f] * (w[f] ?? 1), 0);
}

/** Local Monday 00:00 of `now`'s calendar week (ISO: Sunday is day 7). */
export function weekStart(now: Date): Date {
  const backToMonday = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - backToMonday);
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Median of exactly four samples = mean of the middle two. */
function median4(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return (s[1] + s[2]) / 2;
}

/** Parse a YYYY-MM-DD key as a LOCAL date (midnight). */
function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole calendar days between two local midnights, DST-safe via rounding. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * The wave-2 public API: pace this calendar week against the user's own
 * 4-week baseline and recommend a drain tier. Pure — callers inject `now`
 * and the (already glean-excluded) daily usage from usage.ts.
 *
 * Degenerate cases, pinned:
 * - `enabled: false` → tier 'normal', no gating (ratio null).
 * - <14 days of history (or none) → "insufficient baseline" → 'small', never
 *   'large' (design's cold-start rule).
 * - baseline cumulative 0 with a quiet current week → 'small' (conservative);
 *   with current-week usage → 'skip' (any usage over-paces a zero yardstick).
 */
export function recommendTier(opts: RecommendOpts): TierRecommendation {
  const { days, now } = opts;
  const haircut = Math.min(1, Math.max(0, opts.haircut ?? 0));
  const thresholds: TierThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };

  // Weighted totals by local date key.
  const weighted = new Map<string, number>();
  for (const d of days) {
    weighted.set(d.date, (weighted.get(d.date) ?? 0) + weighDay(d.tokens, opts.weights));
  }

  // Baseline: per-weekday median over the 4 complete calendar weeks before
  // this one. The window starts on a Monday, so day i's weekday index is i%7.
  const monday = weekStart(now);
  const windowStart = addDays(monday, -28);
  const perWeekday: number[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const samples: number[] = [];
    for (let week = 0; week < 4; week++) {
      samples.push(weighted.get(localDateKey(addDays(windowStart, week * 7 + wd))) ?? 0);
    }
    perWeekday.push(median4(samples));
  }

  // Current week rows, Monday through today (local days).
  const todayIdx = (now.getDay() + 6) % 7;
  const week: WeekRow[] = [];
  for (let wd = 0; wd <= todayIdx; wd++) {
    const date = localDateKey(addDays(monday, wd));
    week.push({ date, weekday: WEEKDAY_LABELS[wd], actual: weighted.get(date) ?? 0, baseline: perWeekday[wd] });
  }
  const currentCum = week.reduce((s, r) => s + r.actual, 0);
  const baselineCum = week.reduce((s, r) => s + r.baseline, 0);

  const make = (
    tier: Tier,
    ratio: number | null,
    effective: number | null,
    reason: string,
    insufficient: boolean,
  ): TierRecommendation => ({
    tier,
    ratio,
    effective_ratio: effective,
    reason,
    budget_minutes: TIER_BUDGET_MINUTES[tier],
    model_policy: TIER_POLICY[tier],
    week,
    insufficient_baseline: insufficient,
  });

  if (opts.enabled === false) {
    return make('normal', null, null, 'pacing disabled (pacing.enabled = false) — no gating, defaulting to normal', false);
  }

  // Cold start: under 14 days of history, the median yardstick is noise.
  if (days.length === 0) {
    return make('small', null, null, 'insufficient baseline (no usage history yet; need 14 days) → small', true);
  }
  const earliest = days.reduce((min, d) => (d.date < min ? d.date : min), days[0].date);
  const historyDays = daysBetween(parseDateKey(earliest), addDays(now, 0)) + 1;
  if (historyDays < 14) {
    return make('small', null, null, `insufficient baseline (${historyDays} days of history; need 14) → small`, true);
  }

  if (baselineCum === 0) {
    if (currentCum === 0) {
      return make('small', null, null, 'no baseline usage through this weekday and a quiet week so far → small (conservative)', true);
    }
    return make(
      'skip',
      null,
      null,
      `${fmt(currentCum)} weighted tokens this week against a zero baseline through ${WEEKDAY_LABELS[todayIdx]} → skip`,
      false,
    );
  }

  const ratio = currentCum / baselineCum;
  const effective = ratio + haircut;
  const tier: Tier =
    effective > thresholds.skip_above ? 'skip'
    : effective >= thresholds.small_above ? 'small'
    : effective >= thresholds.normal_above ? 'normal'
    : 'large';
  const haircutNote = haircut > 0 ? ` (measured ${ratio.toFixed(2)} + haircut ${haircut})` : '';
  const reason =
    `pace ${effective.toFixed(2)}${haircutNote}: ${fmt(currentCum)} weighted tokens this week vs ` +
    `${fmt(baselineCum)} baseline through ${WEEKDAY_LABELS[todayIdx]} → ${tier} (${TIER_BUDGET_MINUTES[tier]}m)`;
  return make(tier, ratio, effective, reason, false);
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
