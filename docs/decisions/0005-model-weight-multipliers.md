# ADR-0005 — Model-family weight multipliers for pacing (haiku 0.25 / sonnet 1 / opus 5)

- Status: **UNVERIFIED** (deliberate assumption — consistency over truth)
- Date: 2026-06-13
- Enforced at: `src/lib/pacing.ts:MODEL_WEIGHTS` (tagged `ASSUMPTION[ADR-0005]`) + the
  `pacing.test.ts` test "pins the assumed multipliers: haiku 0.25, sonnet 1, opus 5, unknown 1"

## Context

Self-relative pacing (the v0.9 capacity governor) sums daily tokens from local session JSONL.
Cross-model token mixes are apples-to-oranges: Anthropic publishes **no numeric multiplier** for
how Haiku/Sonnet/Opus draw against the shared weekly cap — only the qualitative "Opus costs
several times more per turn than Sonnet, and Sonnet more than Haiku" (help center, verified
2026-06-12 in the capacity-governor design). Any specific numbers here are a guess.

## Decision

Weight tokens per model family before summing: **haiku 0.25, sonnet 1, opus 5**; model ids
matching none of the three families ride at **1** (sonnet-equivalent). The point is
**week-over-week consistency, not absolute truth** — the pace ratio compares this week's weighted
sum against a baseline computed with the *same* weights, so a wrong multiplier biases both sides
identically and largely cancels. API pricing ratios were considered as a source but rejected:
subscription rate-limit weighting is not priced billing, and false precision invites misreading.

## Status / what would change this

If Anthropic ever publishes per-model cap weights — or the `rate_limit_event` `utilization`
telemetry glean already logs lets us regress observed utilization deltas against per-model token
counts — replace the guesses and supersede this ADR. Changing multipliers shifts every baseline
for ~4 weeks (the trailing window), so note it in the CHANGELOG when it happens.
