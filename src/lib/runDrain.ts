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
import type { RunSummary, PacingConfig } from './types.js';
import type { Tier } from './pacing.js';
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
  // PIECE 1 (#3): the user's configured subscription week reset (pacing.week_anchor).
  // When a weekly block fires with NO observed reset_at, the fallback becomes the
  // next anchor occurrence instead of the blind now+60h. Absent → now+60h.
  weekAnchor?: { day: string; time: string };
  // PIECE 2: morning anti-spill. When > 0 AND a typical-first-prompt time is
  // known, a burst whose start falls within this many hours BEFORE that time is
  // held off (reason 'morning-anti-spill'). Default 0 / absent → OFF.
  morningBufferHours?: number;
  // PIECE 2: the user's typical first-prompt time in minutes past LOCAL midnight
  // (from activity.ts), or null when there's too little data → guard no-ops.
  typicalFirstPromptMinutes?: number | null;
  // PIECE 3: the loaded pacing config. The pace gate fires ONLY when
  // `pacing.enabled === true`; absent / false → no gate (bare-drain behavior).
  pacing?: PacingConfig;
  // PIECE 3: injectable pace-tier resolver (test seam). Returns the recommended
  // tier at burst start. Default reads local usage and calls recommendTier.
  paceTier?: (pacing: PacingConfig) => Promise<Tier>;
};

// PIECE 3: default pace-tier resolver — reads the user's local JSONL usage and
// asks the pacing engine for a tier. Lazy imports keep this off the bare-drain
// (non-gated) and non-drain code paths entirely.
async function defaultPaceTier(pacing: PacingConfig): Promise<Tier> {
  const [{ loadDailyUsage }, { recommendTier }, { defaultClaudeProjectsDir }, { gleanRoot }] =
    await Promise.all([
      import('./usage.js'),
      import('./pacing.js'),
      import('./dashboard-data.js'),
      import('./state.js'),
    ]);
  const now = new Date();
  const days = loadDailyUsage(defaultClaudeProjectsDir(), {
    gleanRoot: gleanRoot(),
    sinceMs: now.getTime() - 42 * 86_400_000,
  });
  return recommendTier({
    days,
    now,
    enabled: pacing.enabled,
    haircut: pacing.haircut,
    thresholds: pacing.thresholds,
    weekAnchor: pacing.week_anchor,
  }).tier;
}

// PIECE 1 (#3): the next local `<day> <time>` STRICTLY after `nowMs`. Pure;
// returns an ISO UTC string (matching the rest of the persisted timestamps).
// getDay(): Sunday 0 … Saturday 6.
const ANCHOR_DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
export function nextWeekAnchorAfter(anchor: { day: string; time: string }, nowMs: number): string {
  const target = ANCHOR_DAY_INDEX[anchor.day.toLowerCase()] ?? 1;
  const [hh, mm] = anchor.time.split(':').map(Number);
  const now = new Date(nowMs);
  let delta = (target - now.getDay() + 7) % 7;
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, hh, mm);
  // Must be STRICTLY in the future — if today is the anchor day but the time has
  // already passed (or is exactly now), roll forward a full week.
  if (candidate.getTime() <= nowMs) {
    delta += 7;
    candidate.setTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta, hh, mm).getTime());
  }
  return candidate.toISOString();
}

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

  // 3f. Morning anti-spill (PIECE 2): if a morning buffer is configured AND the
  // user's typical first-prompt time is known, and now() falls within the buffer
  // window BEFORE that time, hold off — so prep finishes before the workday and
  // the drain doesn't bleed into fresh capacity. Opt-in (morningBufferHours > 0);
  // thin data (typicalFirstPromptMinutes null) → no-op. A no-op tick (no burst,
  // no state write) like guards 3a-3e; never counts toward the no-progress
  // backstop (it's a deliberate hold, not a stall).
  if (withinMorningBuffer(drainOpts.typicalFirstPromptMinutes, drainOpts.morningBufferHours, now)) {
    return synthSummary('morning-anti-spill', now, opts);
  }

  // 3g. Pace gate (PIECE 3): when pacing is ENABLED, consult the pacing tier at
  // burst start and self-gate. A nightly schedule can fire daily but only spend
  // capacity when the user is UNDER pace; tier 'skip' means there's no slack this
  // week → spend nothing (exit 0, reason 'pace-skip'). Strictly opt-in
  // (pacing.enabled === true); absent/false pacing → no gate, byte-identical to a
  // bare drain. A no-op tick (no burst, no state write) like guards 3a-3f.
  if (drainOpts.pacing?.enabled === true) {
    const resolveTier = drainOpts.paceTier ?? defaultPaceTier;
    const tier = await resolveTier(drainOpts.pacing);
    if (tier === 'skip') {
      return synthSummary('pace-skip', now, opts);
    }
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
    // An OBSERVED reset_at always wins. Otherwise prefer the configured week
    // anchor's next occurrence (PIECE 1 / #3), falling back to the blind now+60h
    // only when no anchor is configured (the genuine blind spot).
    next.last_observed_weekly_reset =
      cls.reset_at ??
      (drainOpts.weekAnchor
        ? nextWeekAnchorAfter(drainOpts.weekAnchor, now())
        : new Date(now() + DRAIN_DURATION_MS).toISOString());
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

// PIECE 2: true iff `now` falls within the half-open window
// [firstPrompt - buffer, firstPrompt) for the NEXT upcoming typical-first-prompt
// moment. `firstPromptMin` is minutes past LOCAL midnight (e.g. 540 = 09:00);
// null (thin data) or a non-positive buffer → false (feature OFF / no-op). The
// window is reconstructed in LOCAL time around `now`, checking today's occurrence
// and tomorrow's, so a "now" just past midnight still sees the morning ahead.
export function withinMorningBuffer(
  firstPromptMin: number | null | undefined,
  bufferHours: number | undefined,
  now: () => number,
): boolean {
  if (firstPromptMin == null) return false;
  if (!bufferHours || bufferHours <= 0) return false;
  const bufferMs = bufferHours * 3600_000;
  const t = now();
  const d = new Date(t);
  // Today's and tomorrow's first-prompt moments in local time.
  for (const dayOffset of [0, 1]) {
    const fp = new Date(
      d.getFullYear(), d.getMonth(), d.getDate() + dayOffset,
      Math.floor(firstPromptMin / 60), firstPromptMin % 60, 0,
    ).getTime();
    if (t >= fp - bufferMs && t < fp) return true;
  }
  return false;
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
