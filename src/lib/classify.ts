// classify.ts — pure rate-limit signal classifier.
//
// ADR-0003 (supersedes ADR-0001): the REAL `claude -p` SESSION-limit block was
// captured 2026-06-11 (run 2026-06-11-1800-d705f9) and is a STRUCTURED stdout
// signal, not stderr prose: a `rate_limit_event` with status "rejected" (+ a
// numeric resetsAt), an assistant message with top-level error:"rate_limit",
// and a result with is_error:true + api_error_status:429. `classifyStreamJson`
// below parses that VERIFIED shape and is the PRIMARY block classifier.
//
// ASSUMPTION[ADR-0003] — the WEEKLY block shape is still UNVERIFIED (never
// observed). Until it is captured, a weekly block is inferred from the same
// structured signals via the 6-hour resetsAt cut, and the stderr text path
// below (`classifyRateLimit`, the old ADR-0001 guess) remains as a FALLBACK
// for streams that carry no structured signal. Fixture:
// test/fixtures/captured-rate-limit/real-session-429-block.jsonl.
//
// This module is intentionally defensive and easy to extend:
//
//   FORMAT TABLE (update here when ADR-0003 lands a real WEEKLY block sample)
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
// 'session limit' added 2026-06-11: the observed block prose is "You've hit
// your session limit · resets 8pm (<tz>)" (ADR-0003).
const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit|session limit)/i;

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

  // Steps 2+3: parse a reset moment from the text and derive horizon + kind.
  return deriveFromText(stderrText, now());
}

// Shared steps 2+3: run the parser table over free text and derive kind/horizon
// from the parsed reset moment via the 6-hour cut. Used by classifyRateLimit
// (after its keyword guard) and by classifyStreamJson's prose fallback (where
// the block is already structurally established, so no keyword guard applies).
function deriveFromText(text: string, nowMs: number): RateLimitClassification {
  let resetDate: Date | null = null;
  for (const parser of PARSERS) {
    resetDate = parser(text, nowMs);
    if (resetDate !== null) break;
  }
  if (resetDate === null) {
    return { kind: 'ambiguous', reset_at: null, reset_horizon: 'unknown' };
  }
  return deriveFromResetMoment(resetDate.getTime(), nowMs);
}

// The 6-hour cut applied to a known reset moment. A reset already in the past
// (diff <= 0) classifies as session: the pause logic floors a past reset to
// "retry soon", which is the right reaction to a stale-but-real signal.
function deriveFromResetMoment(resetMs: number, nowMs: number): RateLimitClassification {
  const reset_at = new Date(resetMs).toISOString();
  if (resetMs - nowMs < SIX_HOURS_MS) {
    return { kind: 'session', reset_at, reset_horizon: 'hours' };
  }
  return { kind: 'weekly', reset_at, reset_horizon: 'days' };
}

// ── classifyStreamJson — structured BLOCK detector (ADR-0003, PRIMARY) ────────
//
// VERIFIED (captured 2026-06-11, run d705f9 — the real session-limit block;
// fixture test/fixtures/captured-rate-limit/real-session-429-block.jsonl): when
// a `claude -p` burst is blocked by the 5h session cap, the stream-json stdout
// carries — with EMPTY stderr —
//   1. {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
//      "resetsAt":<epoch-s>,"rateLimitType":"five_hour",…}}
//   2. an assistant message with top-level  "error":"rate_limit"
//   3. {"type":"result",…,"is_error":true,"api_error_status":429,
//      "result":"You've hit your session limit · resets 8pm (<tz>)"}
//
// Any of those three shapes is a BLOCK. Warning telemetry (status allowed /
// allowed_warning) is NOT — flagging it would kill healthy runs (the ADR-0001
// near-miss). Horizon: prefer the LAST rate_limit_event resetsAt (exact, epoch
// seconds) via the 6-hour cut; else parse the block prose; else ambiguous.
// Returns null when the stream carries no block at all.
export function classifyStreamJson(
  jsonlText: string,
  now: () => number = () => Date.now(),
): RateLimitClassification | null {
  if (!jsonlText) return null;
  let blockFound = false;
  let resetsAtMs: number | null = null;
  let prose = '';
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Cheap pre-filter: only JSON.parse lines that could carry a signal.
    if (!trimmed.includes('rate_limit') && !trimmed.includes('"is_error":true')) continue;
    let obj: StreamLine;
    try {
      obj = JSON.parse(trimmed) as StreamLine;
    } catch {
      continue; // malformed / truncated line — skip
    }
    if (obj?.type === 'rate_limit_event') {
      const secs = obj.rate_limit_info?.resetsAt;
      if (typeof secs === 'number' && Number.isFinite(secs)) {
        const ms = secs * 1000;
        if (Number.isFinite(new Date(ms).getTime())) resetsAtMs = ms; // last wins
      }
    }
    if (isStreamBlockSignal(obj)) {
      blockFound = true;
      // Collect block prose as the resetsAt-less fallback horizon source.
      if (typeof obj.result === 'string') prose += obj.result + '\n';
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === 'text' && typeof item.text === 'string') prose += item.text + '\n';
        }
      }
    }
  }
  if (!blockFound) return null;
  const nowMs = now();
  if (resetsAtMs !== null) return deriveFromResetMoment(resetsAtMs, nowMs);
  return deriveFromText(prose, nowMs);
}

// Minimal shape of a stream-json line, for the block predicates only.
type StreamLine = {
  type?: unknown;
  is_error?: unknown;
  api_error_status?: unknown;
  error?: unknown;
  result?: unknown;
  rate_limit_info?: { status?: unknown; resetsAt?: unknown };
  message?: { content?: Array<{ type?: unknown; text?: unknown }> };
};

// The three observed/anticipated structured block shapes (ADR-0003).
function isStreamBlockSignal(obj: StreamLine): boolean {
  if (obj?.type === 'rate_limit_event') {
    // Observed block status: "rejected". Anything non-allowed* is treated as a
    // block (exactly the evidence ADR-0001 said would flip it).
    const status = obj.rate_limit_info?.status;
    return typeof status === 'string' && !status.startsWith('allowed');
  }
  if (obj?.type === 'result' && obj.is_error === true && obj.api_error_status === 429) {
    return true;
  }
  // The assistant message that accompanies the block carries a top-level
  // error:"rate_limit" marker.
  return obj?.error === 'rate_limit';
}

// Line-level predicate for the executor's live stdout scan: true iff this single
// stream-json line is one of the structured block shapes. Parse-tolerant.
export function isStreamBlockLine(line: string): boolean {
  try {
    return isStreamBlockSignal(JSON.parse(line) as StreamLine);
  } catch {
    return false;
  }
}

// ── rate_limit_event resetsAt enrichment (ADR-0001 → ADR-0003) ───────────────
//
// VERIFIED: the `claude -p` stream-json output emits discrete
// `{"type":"rate_limit_event","rate_limit_info":{…}}` messages, captured by the
// executor to ~/glean/logs/<run>/<task>.jsonl. The `resetsAt` field (epoch
// SECONDS) is a real reset moment. Used as ENRICHMENT (reset_at back-fill /
// anti-spill margin) for the stderr-detected fallback path; the structured
// block path above (classifyStreamJson) reads resetsAt itself.
//
// Scans stream-json lines for the LAST rate_limit_event carrying a numeric
// `resetsAt` and returns it as an ISO UTC string, else null. Tolerant of
// malformed lines (try/catch per line) so a partial/corrupt log never throws.
export function parseRateLimitEventResetAt(jsonlText: string): string | null {
  if (!jsonlText) return null;
  let resetAt: string | null = null;
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Cheap pre-filter so we only JSON.parse plausible event lines.
    if (!trimmed.includes('rate_limit_event')) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: unknown;
        rate_limit_info?: { resetsAt?: unknown };
      };
      if (obj?.type !== 'rate_limit_event') continue;
      const secs = obj.rate_limit_info?.resetsAt;
      if (typeof secs !== 'number' || !Number.isFinite(secs)) continue;
      const d = new Date(secs * 1000);
      if (!Number.isFinite(d.getTime())) continue;
      // Keep scanning so the LAST valid event wins.
      resetAt = d.toISOString();
    } catch {
      // Malformed / truncated line — skip it.
    }
  }
  return resetAt;
}

// ── Parsers (ordered: most specific / unambiguous first) ─────────────────────

type Parser = (text: string, nowMs: number) => Date | null;

const PARSERS: readonly Parser[] = [
  parseIsoTimestamp,
  parseRelativeDuration,
  parseWallClock,
];

// Parser 1 — ISO 8601 timestamp WITH an explicit timezone (Z or ±HH:MM).
// A zone designator is REQUIRED: `new Date("2026-06-03T11:00:00")` (no zone)
// would be parsed as machine-LOCAL time, silently offsetting reset_at from the
// intended UTC. Requiring a zone means a naive timestamp falls through to the
// other parsers / ambiguous rather than being misread.
// Matches: "2026-06-03T11:00:00Z", "...00.000Z", "...00+03:00", "...00+0300".
function parseIsoTimestamp(text: string, _nowMs: number): Date | null {
  const m = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/);
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
