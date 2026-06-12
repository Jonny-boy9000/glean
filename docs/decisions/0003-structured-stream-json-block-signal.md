# ADR-0003 — Rate-limit block signal: structured stream-json 429 (session shape VERIFIED)

- Status: **Accepted** for the SESSION block (real capture); the WEEKLY block shape remains **UNVERIFIED**
- Date: 2026-06-12
- Enforced at: `src/lib/classify.ts:classifyStreamJson` / `isStreamBlockLine` + `src/lib/executor.ts` (live stdout scan in `runClaude`; stderr fallback `RATE_LIMIT_RE` tagged `ASSUMPTION[ADR-0003]`); tests: `classifyStreamJson (structured block detector — ADR-0003)` in `src/lib/classify.test.ts`, the `structured-429` executor + pipeline tests, fixture `test/fixtures/captured-rate-limit/real-session-429-block.jsonl`.
- Supersedes: [ADR-0001](./0001-rate-limit-signal-source.md)

## Context

ADR-0001's tripwire fired. On 2026-06-11 (run `2026-06-11-1800-d705f9`) the 5-hour session cap
blocked a live drain mid-run, and the real block shape was finally captured. It is a **structured
stdout** signal, with **EMPTY stderr** and exit code 1:

1. `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<epoch-s>,"rateLimitType":"five_hour",…}}` — the first ever non-`allowed*` status;
2. an assistant message with top-level `"error":"rate_limit"` whose text is `You've hit your session limit · resets 8pm (Asia/Jerusalem)`;
3. `{"type":"result",…,"is_error":true,"api_error_status":429,"result":"You've hit your session limit · …"}`.

Because the old detector watched **stderr only**, these spawns were classified `failed`: the
pipeline spawned 6 more doomed ~2s tasks instead of pausing, and (a separate ledger bug, fixed in
the same change) recorded them all as completed.

## Decision

1. **`classifyStreamJson` is the PRIMARY block detector/classifier.** The executor scans stream-json
   stdout live, line-buffered; any of the three shapes above flags the spawn `rate-limit` and kills it.
   Warning telemetry (`status` = `allowed`/`allowed_warning`) is never a block (ADR-0001's near-miss).
2. **Horizon**: prefer the last `rate_limit_event.resetsAt` (verified, epoch seconds) via the 6-hour
   session/weekly cut; else parse the block prose; else `ambiguous`.
3. **The stderr regex is demoted to FALLBACK**, kept for any block that arrives as stderr prose
   (`session limit` added to its keywords — the observed wording).
4. **The weekly block remains a guess.** Nothing weekly-shaped has ever been observed; a weekly block
   is currently *inferred* from the same structured signals when `resetsAt` is ≥6h away. The
   BLOCK-CAPTURE tripwire and the skipped test in `classify.test.ts` stay armed for it.

## Status / what would change this

Capturing a real **weekly** block (the armed tripwire writes `<task>.BLOCK-CAPTURE.txt`): verify the
6-hour-cut inference against its actual shape (`rateLimitType`? a distinct status? prose wording?),
add the fixture, un-skip the weekly tripwire test, and supersede this ADR if the inference is wrong.
