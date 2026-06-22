import type { Candidate, CandidateType } from './types.js';
import { prioritize, score } from './prioritize.js';

// wave-2 bounded execution-loop optimization. These helpers re-rank the REMAINING
// (not-yet-run) pool BEFORE each task with the CURRENT remaining budget, so the
// loop can (a) defer a task it can't finish (budget-fit) and (b) downweight a
// type that keeps failing this run. All PURE + in-memory; resets each run.
//
// Key invariant (regression safety): with static scores, ample budget (remaining
// >= taskTimeoutMs) and NO failures, pickNext() reproduces prioritize()'s order
// exactly and defers nothing — so the bare `glean run` loop is unchanged.

// Adaptive type-downweighting: once a task TYPE has failed (failed/timeout/
// rate-limit) at least DOWNWEIGHT_THRESHOLD times this run, remaining candidates
// of that type have their ranking score multiplied by DOWNWEIGHT_FACTOR. This is
// a soft penalty — a high-value item of a failing type can still win — not a
// hard skip.
export const DOWNWEIGHT_THRESHOLD = 2;
export const DOWNWEIGHT_FACTOR = 0.3;

// Budget-fit cost heuristic. We don't have a real per-task duration up front; the
// only wall-clock bound glean enforces per task is the timeout. So we model a
// task's cost as a fraction of the timeout proportional to its est_tokens against
// a reference size, CLAMPED to the timeout. Consequence (the load-bearing
// property): estCostMs(c) <= taskTimeoutMs ALWAYS, so while remaining >=
// taskTimeoutMs nothing is ever deferred — budget-fit deferral can only trigger
// late in the run when remaining drops below the timeout. That is exactly the
// "additive-under-pressure" boundary we want.
const REFERENCE_TOKENS = 200_000;

export function estCostMs(c: Candidate, taskTimeoutMs: number): number {
  const frac = Math.min(1, (c.est_tokens || 0) / REFERENCE_TOKENS);
  // Floor at a small positive cost so a zero-token estimate isn't treated as free.
  return Math.max(1, Math.round(taskTimeoutMs * frac));
}

export type PickCtx = {
  remainingMs: number;
  taskTimeoutMs: number;
  // Per-type failure tally accrued DURING this run (failed/timeout/rate-limit).
  typeFailures: Map<CandidateType, number>;
};

export type PickResult = {
  // The chosen candidate, or undefined when nothing in the pool fits the budget.
  pick?: Candidate;
  // Candidates skipped over (deferred) because they couldn't finish in the
  // remaining budget — surfaced so the loop can emit a defer log event.
  deferred: Candidate[];
};

// Adjusted ranking score: prioritize()'s score() times the adaptive downweight
// for any type that has crossed the failure threshold this run.
function adjustedScore(c: Candidate, typeFailures: Map<CandidateType, number>): number {
  const failures = typeFailures.get(c.type) ?? 0;
  const factor = failures >= DOWNWEIGHT_THRESHOLD ? DOWNWEIGHT_FACTOR : 1;
  return score(c) * factor;
}

// Re-rank `pool` (idempotent prioritize() for the base order + the <5min
// fetch-docs floor it already applies), apply adaptive downweighting, then walk
// the result picking the first candidate whose estimated cost fits the remaining
// budget. Anything skipped over for not fitting is returned in `deferred`.
export function pickNext(pool: Candidate[], ctx: PickCtx): PickResult {
  if (pool.length === 0) return { deferred: [] };

  // Base order from the idempotent prioritizer (preserves the <5min-only-
  // fetch-docs floor + type weights + path penalty). prioritize() returns a NEW
  // array and no longer mutates est_value, so this is safe to call every tick.
  const ranked = prioritize(pool, ctx.remainingMs + 0, 0);

  // Re-sort by the adaptively-adjusted score. With no failures this multiplier is
  // 1 for every candidate, so the order is identical to `ranked` (stable sort).
  const reranked = [...ranked].sort((a, b) => adjustedScore(b, ctx.typeFailures) - adjustedScore(a, ctx.typeFailures));

  const deferred: Candidate[] = [];
  for (const c of reranked) {
    if (estCostMs(c, ctx.taskTimeoutMs) <= ctx.remainingMs) {
      return { pick: c, deferred };
    }
    deferred.push(c);
  }
  return { deferred };
}
