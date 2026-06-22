// runDrain.ts — the v0.8 drain wrapper (Task T5).
//
// runDrain is a thin, stateless-per-call wrapper around runPipeline (a single
// burst). It is invoked once per scheduled "tick" (exit-and-re-enter model, NOT
// an in-process sleeper). Each call:
//   1. reads the persisted drain state (state/budget.json),
//   2. decides whether this tick is eligible to run a burst,
//   3. if eligible, runs ONE burst (runPipeline) skipping already-completed
//      tasks,
//   4. folds the burst's outcome (esp. a classified rate-limit) back into the
//      drain state and adjusts the summary reason for the receipt.
//
// All time flows through the injected `now()` so the state machine is fully
// deterministic under test. All persisted timestamps are ISO UTC.

import { randomUUID } from 'node:crypto';
import type { RunSummary } from './types.js';
import type { DrainState } from './state.js';
import {
  readDrainState,
  writeDrainState,
  isStopRequested,
  stopPath,
} from './state.js';
import { runPipeline, type PipelineOpts } from './pipeline.js';
import { readFileSync } from 'node:fs';

// A drain WINDOW spans 60h — long enough to ride out a full weekly reset cycle's
// idle tail. After this we start a fresh window (new id, cleared completed set).
export const DRAIN_DURATION_MS = 60 * 3600_000;
// After this many consecutive unproductive re-entries (a burst that ran 0 tasks)
// we stop the window with 'no-progress' rather than spinning forever.
export const MAX_UNPRODUCTIVE = 3;
// v0.8.2 item 3: default anti-spill margin (minutes) before a known weekly reset.
// Inside this margin runDrain holds off rather than starting work that could run
// into next week's fresh allowance.
export const ANTI_SPILL_MARGIN_MINUTES = 15;
// Fallback session pause when a session-kind rate-limit gives no parseable reset
// moment: 5h (session window) + 15m slack.
export const SESSION_FALLBACK_MS = 5 * 3600_000 + 15 * 60_000;

// A burst is the unit of work runDrain delegates to. Injectable so the guard +
// state-transition logic can be unit-tested without spawning a real pipeline.
export type RunBurst = (opts: PipelineOpts) => Promise<RunSummary>;

// v0.8.2: tunables resolved from config.json's drain_trigger and threaded into
// the state machine. Every field is optional and defaults to the prior hard-coded
// constant, so an absent/empty DrainOpts is byte-identical to pre-v0.8.2 behavior.
export type DrainOpts = {
  // item 1: circuit-breaker threshold (was the hard-coded MAX_UNPRODUCTIVE = 3).
  maxUnproductive?: number;
  // item 3: anti-spill pre-emptive margin, in minutes, before a known weekly
  // reset (default 15). A burst is held off inside this margin.
  antiSpillMarginMinutes?: number;
};

// Reasons that NEVER count toward the no-progress backstop (item 1): a transient
// no-op (discovery hiccup / another burst held the lock / window not yet eligible)
// is not the window genuinely "trying and producing nothing".
// NOTE: of these, only 'discovery-failed' is actually produced by a burst and
// reaches the productivity fold below — 'lock-busy' (guard 5) and 'not-eligible'
// (guard 3c) early-return before the fold. They are kept here as defensive cover
// so the classification stays correct if guard ordering is ever refactored.
const TRANSIENT_REASONS: ReadonlySet<RunSummary['reason']> = new Set([
  'discovery-failed',
  'lock-busy',
  'not-eligible',
]);

export async function runDrain(
  opts: PipelineOpts,
  now: () => number = () => Date.now(),
  runBurst: RunBurst = runPipeline,
  drainOpts: DrainOpts = {},
): Promise<RunSummary> {
  // item 1: resolve the configurable circuit-breaker threshold (default 3).
  const maxUnproductive = drainOpts.maxUnproductive ?? MAX_UNPRODUCTIVE;
  // item 3: resolve the anti-spill margin in minutes (default 15).
  const antiSpillMarginMinutes = drainOpts.antiSpillMarginMinutes ?? ANTI_SPILL_MARGIN_MINUTES;
  // ── 1. Read persisted drain state ──────────────────────────────────────────
  const read = readDrainState(opts.gleanRoot);

  // ── 2. Window identity ─────────────────────────────────────────────────────
  // A NEW window starts when: there is no usable state, OR the previously
  // observed weekly reset has passed (a fresh week of capacity), OR the current
  // window has aged out past DRAIN_DURATION_MS.
  let state: DrainState;
  const isFreshNeeded =
    read.kind !== 'ok' ||
    pastWeeklyReset(read.state, now) ||
    windowAgedOut(read.state, now);

  if (isFreshNeeded) {
    state = freshWindow(now);
    writeDrainState(opts.gleanRoot, state);
  } else {
    state = read.state;
  }

  // ── 3. Guards (lock-free; each returns WITHOUT running a burst) ─────────────

  // 3a. STOP sentinel — only honored if it was written DURING this window. A
  // stale STOP from a previous window is ignored (the window restart supersedes
  // it). The STOP file content is the ISO timestamp written by writeStop.
  if (isStopRequested(opts.gleanRoot)) {
    const stopIso = readStopTimestamp(opts.gleanRoot);
    if (stopIso !== null && Date.parse(stopIso) >= Date.parse(state.drain_window_started_at)) {
      return synthSummary('stop-sentinel', now, opts);
    }
  }

  // 3b. Weekly already drained and we're still before the observed reset → wait.
  if (
    state.week_exhausted &&
    state.last_observed_weekly_reset !== null &&
    now() < Date.parse(state.last_observed_weekly_reset)
  ) {
    return synthSummary('weekly-drained', now, opts);
  }

  // 3c. Session paused and we're still before the next eligible moment → no-op
  // tick. Writes NO run row, persists nothing.
  if (state.next_eligible_at !== null && now() < Date.parse(state.next_eligible_at)) {
    return synthSummary('not-eligible', now, opts);
  }

  // 3d. Too many unproductive re-entries in a row → give up on this window.
  // Threshold is configurable (item 1); defaults to MAX_UNPRODUCTIVE (3).
  if (state.unproductive_reentries >= maxUnproductive) {
    return synthSummary('no-progress', now, opts);
  }

  // 3e. Anti-spill (item 3): if a weekly reset is KNOWN and now() is within the
  // configured margin BEFORE it (reset - margin <= now < reset), hold off this
  // burst rather than starting work that could spill into next week's fresh
  // allowance. A no-op tick consistent with guards 3a-3d (no burst, no state
  // write). Reset source for this lane is last_observed_weekly_reset ONLY; if it
  // is absent (the first burst of a fresh window — the genuine blind spot) or
  // unparseable, the guard does not fire and the drain stays reactive.
  if (withinAntiSpillMargin(state.last_observed_weekly_reset, antiSpillMarginMinutes, now)) {
    return synthSummary('anti-spill', now, opts);
  }

  // ── 4. Eligible → run one burst ────────────────────────────────────────────
  const summary = await runBurst({ ...opts, completedTaskIds: state.completed_task_ids });

  // ── 5. lock-busy → another burst is running; do NOT touch state ─────────────
  if (summary.reason === 'lock-busy') {
    return summary;
  }

  // ── 6. Fold the burst outcome back into drain state ────────────────────────
  // Re-clone so we never mutate the object returned by readDrainState in place.
  // The skip-set is keyed on the STABLE evidence_hash (candidate ids are random
  // uuids regenerated each discovery, so they cannot match across bursts). Union
  // in the hashes this burst completed so a re-entry does NOT redo them — without
  // this, draft-impl re-drafts the same top TODO into a fresh worktree on every
  // tick of the window, wasting the very capacity the drain exists to spend.
  const next: DrainState = {
    ...state,
    completed_task_ids: dedupe([
      ...state.completed_task_ids,
      ...(summary.completed_evidence_hashes ?? []),
    ]),
  };

  // Productivity bookkeeping for guard 3d (the no-progress backstop, item 1).
  // The richer rule: a burst counts as unproductive ONLY when it genuinely TRIED
  // and produced nothing — i.e. it reported productive !== true (no non-trivial
  // output; "ran but everything was empty" now counts, not just ran===0) AND it
  // got no rate-limit classification AND its reason is not transient.
  //   - productive===true                → real progress → RESET to 0.
  //   - classification present           → a legit "come back later" WAIT (a
  //     session/weekly/ambiguous pause) → RESET to 0; counting these would
  //     self-terminate a normal weekend drain after a few pauses (the v0.8.0 bug).
  //   - transient reason (discovery hiccup, etc.) → HOLD the counter unchanged
  //     (neither a stall nor progress).
  //   - otherwise (tried, empty, no signal) → INCREMENT.
  const isTransient = TRANSIENT_REASONS.has(summary.reason);
  const isUnproductive =
    summary.productive !== true && summary.classification == null && !isTransient;
  if (summary.productive === true || summary.classification != null) {
    next.unproductive_reentries = 0;
  } else if (isUnproductive) {
    next.unproductive_reentries = state.unproductive_reentries + 1;
  } else {
    // transient → hold
    next.unproductive_reentries = state.unproductive_reentries;
  }

  const cls = summary.classification;

  if (cls?.kind === 'session') {
    next.consecutive_ambiguous = 0;
    next.next_eligible_at = sessionNextEligible(cls.reset_at, now);
    writeDrainState(opts.gleanRoot, next);
    summary.reason = 'session-paused';
    return summary;
  }

  if (cls?.kind === 'weekly') {
    next.consecutive_ambiguous = 0;
    next.week_exhausted = true;
    next.last_observed_weekly_reset = cls.reset_at ?? new Date(now() + DRAIN_DURATION_MS).toISOString();
    writeDrainState(opts.gleanRoot, next);
    summary.reason = 'weekly-drained';
    return summary;
  }

  if (cls?.kind === 'ambiguous') {
    // First ambiguous rate-limit: pause briefly and retry next tick. A SECOND
    // ambiguous IN A ROW means the signal is unreadable → stop the window.
    // Tracked by a DEDICATED counter (not unproductive_reentries, which any
    // 0-task burst would trip) so the one-retry grace is reliable.
    const priorAmbiguous = state.consecutive_ambiguous ?? 0;
    next.consecutive_ambiguous = priorAmbiguous + 1;
    if (priorAmbiguous >= 1) {
      writeDrainState(opts.gleanRoot, next);
      summary.reason = 'ambiguous-signal';
      return summary;
    }
    next.next_eligible_at = new Date(now() + SESSION_FALLBACK_MS).toISOString();
    writeDrainState(opts.gleanRoot, next);
    summary.reason = 'session-paused';
    return summary;
  }

  // No rate-limit classification (completed / budget-exhausted / no-candidates /
  // stop-sentinel from the burst itself / etc.) — reset the ambiguous streak,
  // persist the updated counters, return the burst's own reason unchanged.
  next.consecutive_ambiguous = 0;
  writeDrainState(opts.gleanRoot, next);
  return summary;
}

function dedupe(arr: readonly string[]): string[] {
  return [...new Set(arr)];
}

// A session pause must never schedule the next tick in the past: a reset_at that
// is already <= now (clock skew, or a just-passed wall-clock time) would clear
// guard 3c immediately and spin. Floor to now + SESSION_FALLBACK_MS.
function sessionNextEligible(resetAt: string | null, now: () => number): string {
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (Number.isFinite(resetMs) && resetMs > now()) return resetAt as string;
  return new Date(now() + SESSION_FALLBACK_MS).toISOString();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function freshWindow(now: () => number): DrainState {
  const iso = new Date(now()).toISOString();
  return {
    drain_window_id: randomUUID(),
    drain_window_started_at: iso,
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    consecutive_ambiguous: 0,
    schema: 1,
  };
}

// item 3: true iff a weekly reset is known/parseable AND now() falls in the
// half-open window [reset - margin, reset). A reset already at/after now() (now
// >= reset) is NOT anti-spill — that's handled reactively (the window restarts
// via pastWeeklyReset). An absent/unparseable reset → false (stay reactive).
function withinAntiSpillMargin(
  lastReset: string | null,
  marginMinutes: number,
  now: () => number,
): boolean {
  if (lastReset === null) return false;
  const resetMs = Date.parse(lastReset);
  if (!Number.isFinite(resetMs)) return false;
  const marginMs = marginMinutes * 60_000;
  const t = now();
  return t >= resetMs - marginMs && t < resetMs;
}

function pastWeeklyReset(state: DrainState, now: () => number): boolean {
  return (
    state.last_observed_weekly_reset !== null &&
    now() > Date.parse(state.last_observed_weekly_reset)
  );
}

function windowAgedOut(state: DrainState, now: () => number): boolean {
  const startedMs = Date.parse(state.drain_window_started_at);
  if (!Number.isFinite(startedMs)) return true; // unparseable start ⇒ restart
  return now() - startedMs > DRAIN_DURATION_MS;
}

function readStopTimestamp(root: string): string | null {
  try {
    return readFileSync(stopPath(root), 'utf8').trim();
  } catch {
    return null;
  }
}

// Build a synthesized RunSummary for a no-op tick (a guard short-circuit). No
// burst ran, so there is no run row and no side effects beyond what the caller
// already persisted. budget_ms mirrors the configured budget for receipt parity.
function synthSummary(reason: RunSummary['reason'], now: () => number, opts: PipelineOpts): RunSummary {
  const iso = new Date(now()).toISOString();
  return {
    run_id: `drain-noop-${randomUUID().slice(0, 8)}`,
    started_at: iso,
    ended_at: iso,
    reason,
    budget_ms: opts.budgetMs,
    elapsed_ms: 0,
    candidates_total: 0,
    ran: 0,
    skipped_dedup: 0,
    failed: 0,
    timed_out: 0,
    exit_code: 0,
  };
}
