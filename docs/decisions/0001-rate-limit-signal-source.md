# ADR-0001 — Rate-limit signal source (stderr vs. stream-json `rate_limit_event`)

- Status: **Superseded by [0002](./0003-structured-stream-json-block-signal.md)** (2026-06-12 — the real SESSION block was captured 2026-06-11; the weekly shape is still unobserved and stays open under ADR-0003)
- Date: 2026-06-02
- Enforced at: `src/lib/classify.ts` (the parser table) + `src/lib/executor.ts:RATE_LIMIT_RE` (the block detector), both tagged `ASSUMPTION[ADR-0001]`; tripwire test `classify: no real-block fixture yet (ADR-0001)` in `src/lib/classify.test.ts`.
- Related: [`docs/open-work/06-rate-limit-signal-findings.md`](../open-work/06-rate-limit-signal-findings.md), [`docs/PROJECT-MAP.md`](../PROJECT-MAP.md) §6.

## Context

glean's drain loop must detect when a `claude -p` burst is **rate-limited** and classify the reset
horizon (session ~5h → pause & resume; weekly → stop). The whole exit-and-re-enter design rests on
reading this signal correctly.

There are **two distinct mechanisms**, and conflating them caused a near-miss on 2026-06-02:

1. **On-demand usage query** — `/usage` (interactive TUI) and any headless `claude usage` subcommand.
   **These do not exist for `claude -p`** (Spike 0). A headless session cannot *ask* for its budget.
   This part is settled and unchanged.

2. **Passively-emitted telemetry** — the `claude` CLI emits discrete
   `{"type":"rate_limit_event","rate_limit_info":{…}}` messages into its `--output-format
   stream-json` output, which glean's executor already captures to `~/glean/logs/<run>/<task>.jsonl`.

### What is VERIFIED (from glean's own captured logs, 2026-05-24 runs)

- `claude -p` **does** emit `rate_limit_event` telemetry. Fields: `status`, `resetsAt` (epoch
  **seconds**), `rateLimitType` (`"five_hour"` observed), and on a warning: `utilization` (0.94) +
  `surpassedThreshold` (0.9).
- All 42 captured events have `status` ∈ {`allowed`, `allowed_warning`} and came from a run that
  **completed normally** (`reason: completed`, exit 0, 14 tasks ran, 0 failed). I.e. these are
  **proactive WARNING telemetry, emitted during a non-blocked run.**

### What is NOT verified (the dangerous gap)

- **The hard-BLOCK shape has never been captured.** No sample of what `claude -p` emits when a
  session is actually rate-limited and *cannot proceed* — not its stderr, not a "blocked"/"rejected"
  `rate_limit_event` status, not an error `result`. The signal that actually *ends a burst* is a guess.
- Whether `resetsAt` is accurate (the human-displayed reset time has known drift/bugs), and whether
  events fire on every run.

## Decision

1. **Keep the stderr block detector (`executor.ts:RATE_LIMIT_RE` → `classify.ts`) as the primary,
   load-bearing path, unchanged.** It is a guess, but it is the only thing we have for the block.
2. **Use `rate_limit_event` only for what is verified, as an enhancement, never the authority:**
   `resetsAt` → feeds the anti-spill margin (v0.8.2 item 3) with real reset data; `utilization`/
   `allowed_warning` → optional proactive-pause + telemetry.
3. **Self-capturing tripwire:** the executor dumps the full raw stderr + last stream messages the
   **first time it ever flags a real block**, so the missing block shape captures itself instead of
   waiting on a human to remember. (Folded into the v0.8.2 classify/executor lane.)
4. Commit the warning-shape lines as fixtures, **labeled honestly as warning-only**
   (`test/fixtures/captured-rate-limit/real-five-hour-events.jsonl`).

### Alternatives rejected

- *Make `rate_limit_event` the primary classifier.* Rejected: the event we have is a warning, not
  a block — it cannot detect the thing the drain reacts to. This was the near-miss.
- *Defer everything to a future live drain.* Rejected: `resetsAt` is verified and usefully closes
  most of the anti-spill gap now; only the block shape needs the live event.

## Status / what would change this

Flip to **Accepted** when a **real `claude -p` block is captured** — either a `rate_limit_event`
with a non-`allowed*` status, or the actual block stderr/result. The tripwire (decision #3) is how
that capture happens automatically; the `glean run --drain` validation run is the manual path. When
captured: add the real fixture, make `classify` parse the verified block shape, retire the guesswork,
and supersede this ADR. Until then the horizon classifier remains the single biggest correctness risk
in the drain — treat it as such.
