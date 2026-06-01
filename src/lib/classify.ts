// classify.ts — pure rate-limit signal classifier.
//
// NOTE: real `claude -p` stderr formats are TBD (captured by "Spike B").
// This module is intentionally defensive and easy to extend:
//
//   FORMAT TABLE (update here as Spike B lands real samples)
//   ──────────────────────────────────────────────────────────────────────────
//   Shape        Example                                    Parser used
//   ──────────────────────────────────────────────────────────────────────────
//   ISO UTC      "resets at 2026-06-03T11:00:00Z"          parseIsoTimestamp
//   Relative h   "try again in 4 hours" / "in 3h"          parseRelativeDuration
//   Relative m   "try again in 30 minutes"                  parseRelativeDuration
//   Relative d   "try again in 2 days"                      parseRelativeDuration
//   Wall-clock   "try again at 3:00pm UTC"                  parseWallClock
//   ──────────────────────────────────────────────────────────────────────────
//   To add a new shape: write a parser → Date | null and add it to PARSERS below.

export type RateLimitClassification = {
  kind: 'session' | 'weekly' | 'ambiguous';
  reset_at: string | null;          // ISO UTC if a reset moment is derivable, else null
  reset_horizon: 'hours' | 'days' | 'unknown';
};

// Matches the same pattern used in executor.ts so they stay in sync.
const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit)/i;

// The 6-hour cut: resets within this window are classified as a session reset
// (<=~5h), resets beyond it are weekly resets. Sits just past the 5-hour
// session window so a full session reset is always 'hours'.
const SIX_HOURS_MS = 6 * 3600_000;

export function classifyRateLimit(
  stderrText: string,
  now: () => number = () => Date.now(),
): RateLimitClassification {
  // Step 1: guard — is this even a rate-limit signal?
  if (!RATE_LIMIT_RE.test(stderrText)) {
    return { kind: 'ambiguous', reset_at: null, reset_horizon: 'unknown' };
  }

  // Step 2: try each parser in priority order until one succeeds.
  const nowMs = now();
  let resetDate: Date | null = null;
  for (const parser of PARSERS) {
    resetDate = parser(stderrText, nowMs);
    if (resetDate !== null) break;
  }

  // Step 3: derive horizon + kind from the reset moment (or fall through to ambiguous).
  if (resetDate === null) {
    return { kind: 'ambiguous', reset_at: null, reset_horizon: 'unknown' };
  }

  const diffMs = resetDate.getTime() - nowMs;
  const reset_at = resetDate.toISOString();

  if (diffMs < SIX_HOURS_MS) {
    return { kind: 'session', reset_at, reset_horizon: 'hours' };
  }
  return { kind: 'weekly', reset_at, reset_horizon: 'days' };
}

// ── Parsers (ordered: most specific / unambiguous first) ─────────────────────

type Parser = (text: string, nowMs: number) => Date | null;

const PARSERS: readonly Parser[] = [
  parseIsoTimestamp,
  parseRelativeDuration,
  parseWallClock,
];

// Parser 1 — bare ISO 8601 timestamp anywhere in the text.
// Matches: "2026-06-03T11:00:00Z", "2026-06-03T11:00:00.000Z", etc.
function parseIsoTimestamp(text: string, _nowMs: number): Date | null {
  const m = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Parser 2 — relative duration: "in N hours/h", "in N minutes", "in N days".
// Case-insensitive. The number may be fractional (e.g. "in 0.5 hours") but
// real stderr usually uses integers.
const RELATIVE_RE = /\bin\s+(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:inutes?)?|d(?:ays?)?)(?:\b|\s|$)/i;

function parseRelativeDuration(text: string, nowMs: number): Date | null {
  const m = text.match(RELATIVE_RE);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  let ms: number;
  if (unit.startsWith('d')) {
    ms = n * 86400_000;
  } else if (unit.startsWith('h')) {
    ms = n * 3600_000;
  } else if (unit.startsWith('m')) {
    ms = n * 60_000;
  } else {
    return null;
  }
  return new Date(nowMs + ms);
}

// Parser 3 — wall-clock time: "at 3:00pm UTC", "at 11:42pm", "at 15:30".
// Derives the reset date by finding the next occurrence of that time relative
// to `nowMs`. Only supports UTC (or bare, treated as UTC) to avoid timezone
// ambiguity — extend here once real stderr samples are captured by Spike B.
//
// Supported patterns:
//   "3:00pm"  / "11:42pm"  (12h with am/pm)
//   "15:30"   / "3:30"     (bare 24h or 12h — treated as UTC)
const WALL_CLOCK_RE = /\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:utc)?/i;

function parseWallClock(text: string, nowMs: number): Date | null {
  const m = text.match(WALL_CLOCK_RE);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const meridiem = m[3]?.toLowerCase();

  // Convert 12h → 24h
  if (meridiem === 'am') {
    if (hours === 12) hours = 0;
  } else if (meridiem === 'pm') {
    if (hours !== 12) hours += 12;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  // Build a Date for this time on the same UTC calendar day as `nowMs`.
  const base = new Date(nowMs);
  const candidate = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    hours,
    minutes,
    0,
    0,
  ));

  // If the time has already passed today UTC, advance by one day.
  if (candidate.getTime() <= nowMs) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  return candidate;
}
