# Open work 06 — the real `claude -p` rate-limit signal (stream-json `rate_limit_event`)

> **Created:** 2026-06-02, during the v0.8.2 kickoff, while indexing the project's three trees
> (see [`docs/PROJECT-MAP.md`](../PROJECT-MAP.md)). This corrects a load-bearing premise the
> drain core (`classify.ts`) was built on.

## TL;DR

The exact `claude -p` rate-limit signal — the thing v0.8.0's design called "must be captured
empirically" and v0.8.2 item 5 wanted captured from a future live drain — **was already in the
logs.** It is **not free-text stderr.** It is a structured message in the
`--output-format stream-json` stream that glean already writes to `~/glean/logs/<run>/<task>.jsonl`:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1779619200,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  },
  "uuid": "…",
  "session_id": "…"
}
```

And a graduated warning variant (emitted as utilization climbs):

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed_warning",
    "resetsAt": 1779619200,
    "rateLimitType": "five_hour",
    "utilization": 0.94,
    "surpassedThreshold": 0.9,
    "isUsingOverage": false
  }
}
```

Source: `~/glean/logs/2026-05-24-1221-a69612/*.jsonl` (42 `rate_limit_event` lines). Real lines
preserved (redacted) at `test/fixtures/captured-rate-limit/real-five-hour-events.jsonl`.

## What is verified vs. still unknown

| Field | Verified value(s) | Still to capture |
|-------|-------------------|------------------|
| envelope `type` | `"rate_limit_event"` | — |
| `rate_limit_info.status` | `"allowed"`, `"allowed_warning"` | the **blocked/exhausted** value (when actually rate-limited — likely `"blocked"`/`"rejected"`/`"exhausted"`) |
| `rateLimitType` | `"five_hour"` (session) | the **weekly** value (likely `"seven_day"`) |
| `resetsAt` | epoch **seconds** (decoded to real reset moments, e.g. `1779619200` → `2026-05-24T10:40:00Z`) | — |
| `utilization` / `surpassedThreshold` | `0.94` / `0.9` on the warning | thresholds at other levels |
| `overageStatus` / `overageDisabledReason` / `isUsingOverage` | `"rejected"` / `"org_level_disabled"` / `false` | values for an org WITH overage enabled |

All 42 captured events were `five_hour` with `status` in {`allowed`, `allowed_warning`} — i.e. these
runs **approached** the 5-hour session limit but the logs don't contain a hard-blocked event or any
`weekly`/`seven_day` event. So: **session shape verified; weekly value + blocked status still need
one real capture.**

## Why this matters (3 consequences)

1. **`classify.ts` targets the wrong source.** It regex-parses stderr prose ("try again in N
   hours", ISO strings, wall-clock). The real, reliable signal is structured JSON glean already
   captures. The classifier should read `rate_limit_event.rate_limit_info` from the task's
   `.jsonl` first, and keep the stderr regex only as a fallback. The horizon "6-hour cut" guess
   becomes unnecessary for the common case — `rateLimitType` states session-vs-weekly explicitly,
   and `resetsAt` gives the exact moment.

2. **Anti-spill (v0.8.2 item 3) gets real data.** `resetsAt` is the exact reset; `status:
   "allowed_warning"` + `utilization` is a *proactive* approaching-limit signal **before** the hard
   stop. The "refuse to start a task within ~15 min of a known weekly reset" margin can key off a
   real `resetsAt` instead of an estimate, and glean can pause *before* getting rejected.

3. **A stated load-bearing constraint is partly inaccurate.** `CLAUDE.md` says "There is no
   programmatic remaining-window endpoint" and "the executor reacts to **stderr** signals." There
   is, in fact, an inline per-message budget readout (`utilization` + `resetsAt` + `status`). This
   is **not** a `claude usage` query (Spike 0's finding stands — there's no separate headless
   probe), but it is a structured in-stream signal richer than stderr. Update the constraint wording
   when the stream-json classifier lands. The exit-and-re-enter architecture is unaffected.

## Recommended reframe of v0.8.2 item 5

**Before:** "Run a live drain, capture the real stderr, replace classify.ts's invented strings."

**After:**
- Parse `rate_limit_event` from the captured stream-json as the **primary** classifier input
  (session = `five_hour`; treat any non-`five_hour` `rateLimitType` as weekly until the exact value
  is captured; `resetsAt` → the reset moment; `status: allowed_warning` → proactive margin trigger).
- Keep the existing stderr-prose parser as a **fallback** for older/edge output.
- Commit the captured fixtures (done) and add classifier tests against them.
- **One thing still genuinely needs a live event:** the exact **weekly** `rateLimitType` string and
  the **blocked** `status` string. Until then, classify defensively (any unrecognized non-session
  type ⇒ weekly; any non-`allowed*` status ⇒ blocked) and log the raw event so the first real
  occurrence is captured automatically.

## Repro / how to re-harvest

```bash
# distinct rate-limit shapes across all runtime logs
grep -rhoE '"rateLimitType":"[^"]*"' ~/glean/logs | sort | uniq -c
grep -rhoE '"(overageStatus|status)":"[^"]*"' ~/glean/logs | sort | uniq -c
# pull full rate_limit_event objects
grep -rh '"rateLimitType"' ~/glean/logs   # each line is a full stream-json message
```
