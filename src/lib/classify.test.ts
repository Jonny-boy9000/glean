// Tests for classify.ts — rate-limit signal classifier.
// All time-dependent assertions use an injected `now` function so the real
// clock is never touched. See classify.ts for format-extension notes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRateLimit, classifyStreamJson, parseRateLimitEventResetAt } from './classify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  __dirname, '..', '..', 'test', 'fixtures', 'captured-rate-limit', 'real-five-hour-events.jsonl',
);
const BLOCK_FIXTURE = join(
  __dirname, '..', '..', 'test', 'fixtures', 'captured-rate-limit', 'real-session-429-block.jsonl',
);

// Fixed epoch: 2026-06-02T12:00:00Z  →  1780401600000 ms
const FIXED_NOW = 1780401600000;
const now = () => FIXED_NOW;

// Helper: offset from FIXED_NOW expressed as a Date string
function nowPlus(ms: number): string {
  return new Date(FIXED_NOW + ms).toISOString();
}

const H = 3600_000; // 1 hour in ms
const M = 60_000;   // 1 minute in ms

// ── ADR-0001 → ADR-0003 tripwire (now scoped to the WEEKLY block) ────────────
// This skipped test is an intentional, visible reminder of the remaining
// UNVERIFIED assumption. The SESSION block WAS captured 2026-06-11 (run d705f9;
// fixture real-session-429-block.jsonl, asserted by the classifyStreamJson tests
// below) — but the WEEKLY block shape has still never been observed; weekly is
// currently inferred via the 6-hour resetsAt cut. See
// docs/decisions/0003-structured-stream-json-block-signal.md. When a real WEEKLY
// block is captured (the executor BLOCK-CAPTURE tripwire stays armed), drop the
// fixture in, un-skip this, assert classify handles the verified shape, and
// supersede ADR-0003 if the inference was wrong. Until then it shows up as
// `1 skipped` on every run by design.
describe('ADR-0003: real WEEKLY-block signal (UNVERIFIED)', () => {
  it.skip('classifies a captured real claude -p WEEKLY rate-limit BLOCK (no fixture yet — ADR-0003 open)', () => {
    // Intentionally empty: there is no real weekly-block fixture to assert
    // against yet. The presence of this skipped test is the tripwire.
  });
});

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

// ── classifyStreamJson — the structured BLOCK detector (ADR-0003) ─────────────
// The REAL session-limit block was captured 2026-06-11 (run 2026-06-11-1800-d705f9):
// a rate_limit_event with status "rejected" + an assistant message with top-level
// error:"rate_limit" + a result with is_error:true and api_error_status:429, all on
// stdout with EMPTY stderr. classifyStreamJson is the primary detector for that
// shape; it returns null when the stream carries no block (warnings are not blocks).
describe('classifyStreamJson (structured block detector — ADR-0003)', () => {
  // Fixture resetsAt = 1781197200 (epoch seconds) → 2026-06-11T17:00:00.000Z
  const RESET_MS = 1781197200000;

  it('classifies the captured real session-429 block as session with the event resetsAt', () => {
    const text = readFileSync(BLOCK_FIXTURE, 'utf8');
    const cls = classifyStreamJson(text, () => RESET_MS - 2 * H);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('session');
    expect(cls!.reset_at).toBe('2026-06-11T17:00:00.000Z');
    expect(cls!.reset_horizon).toBe('hours');
  });

  it('a rejected event whose resetsAt is >= 6h away classifies as weekly', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1781197200 },
    });
    const cls = classifyStreamJson(line, () => RESET_MS - 8 * H);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('weekly');
    expect(cls!.reset_horizon).toBe('days');
  });

  it('returns null for warning-only telemetry (allowed/allowed_warning is NOT a block)', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    expect(classifyStreamJson(text, now)).toBeNull();
  });

  it('returns null for unrelated stream lines and for empty input', () => {
    const text = [
      '{"type":"message_start","message":{"id":"m1","role":"assistant"}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
    ].join('\n');
    expect(classifyStreamJson(text, now)).toBeNull();
    expect(classifyStreamJson('', now)).toBeNull();
  });

  it('a 429 result with no rate_limit_event degrades to ambiguous via the prose', () => {
    // "resets 8pm (Asia/Jerusalem)" carries no parseable reset moment.
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
      result: "You've hit your session limit · resets 8pm (Asia/Jerusalem)",
    });
    const cls = classifyStreamJson(line, now);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('ambiguous');
    expect(cls!.reset_at).toBeNull();
  });

  it('a 429 result with parseable prose derives the horizon from the prose', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
      result: 'usage limit reached, try again in 4 hours',
    });
    const cls = classifyStreamJson(line, now);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('session');
    expect(cls!.reset_at).toBe(nowPlus(4 * H));
  });

  it('an assistant message with top-level error:"rate_limit" alone is a block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8pm" }] },
      error: 'rate_limit',
    });
    const cls = classifyStreamJson(line, now);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('ambiguous');
  });

  it('tolerates malformed / non-JSON lines around the block', () => {
    const text = [
      'not json',
      '{"type":"result","is_error":true',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1781197200}}',
      '}{ broken',
    ].join('\n');
    const cls = classifyStreamJson(text, () => RESET_MS - 1 * H);
    expect(cls).not.toBeNull();
    expect(cls!.kind).toBe('session');
  });
});

// The observed block prose says "session limit" — the keyword guard (and the
// executor's stderr fallback regex, kept in sync) must trigger on it.
describe('rate-limit keyword: "session limit" (observed 2026-06-11)', () => {
  it('triggers on "session limit" with a parseable horizon', () => {
    const result = classifyRateLimit('session limit reached, try again in 2 hours', now);
    expect(result.kind).toBe('session');
    expect(result.reset_at).toBe(nowPlus(2 * H));
  });
});

// ── rate_limit_event resetsAt enrichment (ADR-0001: VERIFIED warning-only) ────
// parseRateLimitEventResetAt reads the stream-json `rate_limit_event` telemetry
// (verified shape — a WARNING, not a block) and returns the `resetsAt` epoch as
// ISO UTC. This is enrichment for the anti-spill margin, NOT the block detector;
// classifyRateLimit (stderr) is unchanged and remains load-bearing for the block.
describe('parseRateLimitEventResetAt (rate_limit_event enrichment)', () => {
  it('returns the resetsAt ISO from the committed warning-only fixture', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    // Fixture resetsAt = 1779619200 (epoch seconds) → 2026-05-24T10:40:00.000Z
    expect(parseRateLimitEventResetAt(text)).toBe('2026-05-24T10:40:00.000Z');
  });

  it('returns null when there is no rate_limit_event line', () => {
    const text = [
      '{"type":"message_start","message":{"id":"m1","role":"assistant"}}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ].join('\n');
    expect(parseRateLimitEventResetAt(text)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseRateLimitEventResetAt('')).toBeNull();
  });

  it('tolerates malformed / non-JSON lines around a valid event', () => {
    const text = [
      'this is not json at all',
      '{"type":"rate_limit_event"',                       // truncated JSON
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1779619200}}',
      '}{ also broken',
    ].join('\n');
    expect(parseRateLimitEventResetAt(text)).toBe('2026-05-24T10:40:00.000Z');
  });

  it('prefers the LAST rate_limit_event when several are present', () => {
    const text = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1779619200}}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1779622800}}',
    ].join('\n');
    // The second event's resetsAt (1779622800) → 2026-05-24T11:40:00.000Z
    expect(parseRateLimitEventResetAt(text)).toBe('2026-05-24T11:40:00.000Z');
  });

  it('returns null for a rate_limit_event missing resetsAt', () => {
    const text = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}';
    expect(parseRateLimitEventResetAt(text)).toBeNull();
  });
});
