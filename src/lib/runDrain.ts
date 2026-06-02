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

import { v4 as uuid } from 'uuid';
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
// Fallback session pause when a session-kind rate-limit gives no parseable reset
// moment: 5h (session window) + 15m slack.
export const SESSION_FALLBACK_MS = 5 * 3600_000 + 15 * 60_000;

// A burst is the unit of work runDrain delegates to. Injectable so the guard +
// state-transition logic can be unit-tested without spawning a real pipeline.
export type RunBurst = (opts: PipelineOpts) => Promise<RunSummary>;

export async function runDrain(
  opts: PipelineOpts,
  now: () => number = () => Date.now(),
  runBurst: RunBurst = runPipeline,
): Promise<RunSummary> {
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
  if (state.unproductive_reentries >= MAX_UNPRODUCTIVE) {
    return synthSummary('no-progress', now, opts);
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

  // Productivity bookkeeping for guard 3d (the no-progress backstop). A burst is
  // "unproductive" ONLY if it ran 0 tasks AND got no rate-limit signal — i.e. it
  // woke up with nothing to do or everything failed. A session/weekly/ambiguous
  // rate-limit is a legitimate "come back later" WAIT across the window, not a
  // stall: counting it would self-terminate a normal multi-session weekend drain
  // after 3 pauses, abandoning most of the week's capacity.
  next.unproductive_reentries =
    summary.ran > 0 || summary.classification != null ? 0 : state.unproductive_reentries + 1;

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
    drain_window_id: uuid(),
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
    run_id: `drain-noop-${uuid().slice(0, 8)}`,
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
