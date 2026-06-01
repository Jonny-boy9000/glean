// Tests for classify.ts — rate-limit signal classifier.
// All time-dependent assertions use an injected `now` function so the real
// clock is never touched. See classify.ts for format-extension notes.

import { describe, it, expect } from 'vitest';
import { classifyRateLimit } from './classify.js';

// Fixed epoch: 2026-06-02T12:00:00Z  →  1780401600000 ms
const FIXED_NOW = 1780401600000;
const now = () => FIXED_NOW;

// Helper: offset from FIXED_NOW expressed as a Date string
function nowPlus(ms: number): string {
  return new Date(FIXED_NOW + ms).toISOString();
}

const H = 3600_000; // 1 hour in ms
const M = 60_000;   // 1 minute in ms

// ── No rate-limit text ───────────────────────────────────────────────────────

describe('no rate-limit indication', () => {
  it('returns ambiguous/unknown for unrelated stderr', () => {
    const result = classifyRateLimit('Something went wrong: unexpected EOF', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for empty string', () => {
    const result = classifyRateLimit('', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for unrelated JSON error', () => {
    const result = classifyRateLimit('{"error":"network timeout","code":408}', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });
});

// ── Rate-limit detected but no parseable reset ───────────────────────────────

describe('rate-limit detected, unparseable reset', () => {
  it('returns ambiguous/unknown when only "rate limit" keyword is present', () => {
    const result = classifyRateLimit('You have hit the rate limit. Please wait.', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for 429 with no time info', () => {
    const result = classifyRateLimit('Error 429: Too Many Requests', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for usage limit with no time info', () => {
    const result = classifyRateLimit('usage limit reached', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for 5-hour limit with no time info', () => {
    const result = classifyRateLimit('5-hour limit reached, no reset info', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });

  it('returns ambiguous/unknown for weekly limit with no time info', () => {
    const result = classifyRateLimit('weekly limit exceeded', now);
    expect(result.kind).toBe('ambiguous');
    expect(result.reset_at).toBeNull();
    expect(result.reset_horizon).toBe('unknown');
  });
});

// ── Session resets (reset_horizon: 'hours', kind: 'session') ────────────────

describe('session resets (< 6h from now)', () => {
  it('classifies relative "in N hours" (< 6h) as session', () => {
    const result = classifyRateLimit('rate limit exceeded, try again in 4 hours', now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe(nowPlus(4 * H));
  });

  it('classifies relative "in 3h" shorthand as session', () => {
    const result = classifyRateLimit('usage limit — in 3h you can continue', now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe(nowPlus(3 * H));
  });

  it('classifies relative "in N minutes" as session', () => {
    const result = classifyRateLimit('rate limit hit, try again in 30 minutes', now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe(nowPlus(30 * M));
  });

  it('classifies absolute ISO timestamp within 5h as session', () => {
    const resetAt = new Date(FIXED_NOW + 2 * H).toISOString();
    const result = classifyRateLimit(`rate limit reached. resets at ${resetAt}`, now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe(resetAt);
  });

  it('classifies "resets at HH:MM" within 5h as session (date inferred from now)', () => {
    // FIXED_NOW is 2026-06-02T12:00:00Z. A wall-clock time of "3:00pm" = 15:00 UTC
    // means reset is 3h away — should be session.
    const result = classifyRateLimit('5-hour limit reached, try again at 3:00pm UTC', now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    // reset_at should be 2026-06-02T15:00:00.000Z
    expect(result.reset_at).toBe('2026-06-02T15:00:00.000Z');
  });

  it('classifies "resets at 11:42pm" within 12h today as session when <6h away', () => {
    // FIXED_NOW is 12:00 UTC. 11:42pm = 23:42 UTC → 11h42m away → weekly.
    // But for a session case: use 1:30pm = 13:30 → 1.5h away.
    const result = classifyRateLimit('rate limit: try again at 1:30pm UTC', now);
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe('2026-06-02T13:30:00.000Z');
  });
});

// ── Weekly resets (reset_horizon: 'days', kind: 'weekly') ───────────────────

describe('weekly resets (>= 6h from now)', () => {
  it('classifies relative "in 2 days" as weekly', () => {
    const result = classifyRateLimit('weekly limit reached. Try again in 2 days.', now);
    expect(result.kind).toBe('weekly');
    expect(result.reset_horizon).toBe('days');
    expect(result.reset_at).toBe(nowPlus(2 * 24 * H));
  });

  it('classifies absolute ISO timestamp 3+ days away as weekly', () => {
    const resetAt = new Date(FIXED_NOW + 3 * 24 * H).toISOString();
    const result = classifyRateLimit(`429 Too Many Requests. Resets at ${resetAt}.`, now);
    expect(result.kind).toBe('weekly');
    expect(result.reset_horizon).toBe('days');
    expect(result.reset_at).toBe(resetAt);
  });

  it('classifies relative "in 6h" (boundary: exactly 6h) as weekly', () => {
    const result = classifyRateLimit('rate limit, try again in 6 hours', now);
    expect(result.kind).toBe('weekly');
    expect(result.reset_horizon).toBe('days');
    expect(result.reset_at).toBe(nowPlus(6 * H));
  });
});

// ── 6-hour boundary (injected now for precision) ─────────────────────────────

describe('6-hour boundary', () => {
  it('5h59m → session (just under the 6h cut)', () => {
    const stderrMs = 5 * H + 59 * M;
    const result = classifyRateLimit(`rate limit, try again in ${stderrMs / M} minutes`, now);
    // 359 minutes < 360 minutes (6h)
    expect(result.kind).toBe('session');
    expect(result.reset_horizon).toBe('hours');
    expect(result.reset_at).toBe(nowPlus(stderrMs));
  });

  it('6h01m → weekly (just over the 6h cut)', () => {
    const stderrMs = 6 * H + 1 * M;
    const result = classifyRateLimit(`rate limit, try again in ${stderrMs / M} minutes`, now);
    // 361 minutes > 360 minutes (6h)
    expect(result.kind).toBe('weekly');
    expect(result.reset_horizon).toBe('days');
    expect(result.reset_at).toBe(nowPlus(stderrMs));
  });

  it('exactly 6h (boundary) → weekly', () => {
    const result = classifyRateLimit('rate limit, try again in 360 minutes', now);
    expect(result.kind).toBe('weekly');
    expect(result.reset_horizon).toBe('days');
    expect(result.reset_at).toBe(nowPlus(6 * H));
  });
});

// ── Relative duration shapes ──────────────────────────────────────────────────

describe('relative duration parsing', () => {
  it('parses "in N hours" (long form)', () => {
    const result = classifyRateLimit('rate limit: in 1 hours retry', now);
    expect(result.reset_at).toBe(nowPlus(1 * H));
  });

  it('parses "in Nh" (short form, no space)', () => {
    const result = classifyRateLimit('usage limit — in 2h you may retry', now);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });

  it('parses "in N minutes" (long form)', () => {
    const result = classifyRateLimit('5-hour limit reached, retry in 45 minutes', now);
    expect(result.reset_at).toBe(nowPlus(45 * M));
  });

  it('parses "in N days" (long form)', () => {
    const result = classifyRateLimit('weekly limit, try again in 5 days', now);
    expect(result.reset_at).toBe(nowPlus(5 * 24 * H));
  });

  it('is case-insensitive for duration keywords', () => {
    const result = classifyRateLimit('Rate Limit: In 2 Hours', now);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });
});

// ── Absolute time shapes ──────────────────────────────────────────────────────

describe('absolute time parsing', () => {
  it('parses a bare ISO 8601 timestamp in the text', () => {
    const iso = '2026-06-05T08:00:00Z';
    const expected = new Date(iso).toISOString();
    const result = classifyRateLimit(`rate limit. resets at ${iso}`, now);
    expect(result.reset_at).toBe(expected);
    expect(result.kind).toBe('weekly'); // 3 days away → weekly
  });

  it('parses "resets at HH:MMam" wall-clock (today)', () => {
    // FIXED_NOW = 12:00 UTC. "4:00pm UTC" = 16:00 → 4h away → session
    const result = classifyRateLimit('rate limit: resets at 4:00pm UTC', now);
    expect(result.reset_at).toBe('2026-06-02T16:00:00.000Z');
    expect(result.kind).toBe('session');
  });
});

// ── Keyword variants ──────────────────────────────────────────────────────────

describe('rate-limit keyword variants', () => {
  it('triggers on "rate limit" (with space)', () => {
    const result = classifyRateLimit('rate limit hit, in 2h', now);
    expect(result.kind).not.toBe(undefined);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });

  it('triggers on "429"', () => {
    const result = classifyRateLimit('HTTP 429 error, in 2h', now);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });

  it('triggers on "usage limit"', () => {
    const result = classifyRateLimit('usage limit exceeded, in 2h', now);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });

  it('triggers on "5-hour limit"', () => {
    const result = classifyRateLimit('5-hour limit exceeded, in 2h', now);
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });

  it('triggers on "weekly limit"', () => {
    const result = classifyRateLimit('weekly limit hit, in 2 days', now);
    expect(result.reset_at).toBe(nowPlus(2 * 24 * H));
  });
});
