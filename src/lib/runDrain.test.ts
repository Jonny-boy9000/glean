import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDrain,
  DRAIN_DURATION_MS,
  MAX_UNPRODUCTIVE,
  SESSION_FALLBACK_MS,
  type RunBurst,
} from './runDrain.js';
import {
  readDrainState,
  writeDrainState,
  drainStatePath,
  stopPath,
  type DrainState,
} from './state.js';
import type { PipelineOpts } from './pipeline.js';
import type { RunSummary } from './types.js';
import type { RateLimitClassification } from './classify.js';

// ── fixtures ───────────────────────────────────────────────────────────────

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-drain-'));
}

// A fixed reference "now" (2026-06-02T12:00:00Z) so all derived ISO strings are
// deterministic. Tests build clocks relative to this.
const T0 = Date.parse('2026-06-02T12:00:00Z');
const clockAt = (ms: number) => () => ms;

function opts(root: string): PipelineOpts {
  return {
    projectPath: 'C:\\fake\\project',
    gleanRoot: root,
    claudeBin: 'claude',
    claudeEnv: {},
    budgetMs: 60 * 60_000,
    taskTimeoutMs: 8 * 60_000,
    dryRun: false,
    templatesDir: 'C:\\fake\\templates',
  };
}

function baseSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    run_id: 'burst-1',
    started_at: new Date(T0).toISOString(),
    ended_at: new Date(T0).toISOString(),
    reason: 'completed',
    budget_ms: 60 * 60_000,
    elapsed_ms: 1000,
    candidates_total: 1,
    ran: 1,
    skipped_dedup: 0,
    failed: 0,
    timed_out: 0,
    exit_code: 0,
    // v0.8.2 item 1: the default baseSummary models a normal SUCCESSFUL burst
    // that produced real output, so it resets the no-progress backstop. Tests
    // exercising the unproductive path override this to false.
    productive: true,
    ...over,
  };
}

// A burst spy that records the opts it was called with and returns a canned
// summary.
function fakeBurst(summary: RunSummary): { fn: RunBurst; calls: PipelineOpts[] } {
  const calls: PipelineOpts[] = [];
  const fn: RunBurst = async (o) => {
    calls.push(o);
    return summary;
  };
  return { fn, calls };
}

// A burst that must NOT be called (guard tests).
const burstNeverCalled: RunBurst = async () => {
  throw new Error('runBurst must not be called for this guard');
};

function existingState(over: Partial<DrainState> = {}): DrainState {
  return {
    drain_window_id: 'win-existing',
    drain_window_started_at: new Date(T0).toISOString(),
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    schema: 1,
    ...over,
  };
}

const SESSION_CLS: RateLimitClassification = {
  kind: 'session',
  reset_at: new Date(T0 + 3 * 3600_000).toISOString(),
  reset_horizon: 'hours',
};
const WEEKLY_CLS: RateLimitClassification = {
  kind: 'weekly',
  reset_at: new Date(T0 + 3 * 86400_000).toISOString(),
  reset_horizon: 'days',
};
const AMBIGUOUS_CLS: RateLimitClassification = {
  kind: 'ambiguous',
  reset_at: null,
  reset_horizon: 'unknown',
};

// ── new window identity ──────────────────────────────────────────────────────

describe('runDrain — window identity', () => {
  it('builds a fresh window when state is missing, then runs the burst', async () => {
    const root = tmpRoot();
    const { fn, calls } = fakeBurst(baseSummary());
    await runDrain(opts(root), clockAt(T0), fn);

    const read = readDrainState(root);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.drain_window_started_at).toBe(new Date(T0).toISOString());
    expect(read.state.next_eligible_at).toBeNull();
    expect(read.state.week_exhausted).toBe(false);
    expect(read.state.completed_task_ids).toEqual([]);
    expect(read.state.unproductive_reentries).toBe(0);
    expect(read.state.schema).toBe(1);
    // burst ran with an (empty) completed set
    expect(calls).toHaveLength(1);
    expect(calls[0].completedTaskIds).toEqual([]);
  });

  it('builds a fresh window when state is corrupt', async () => {
    const root = tmpRoot();
    // write a corrupt budget.json
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(drainStatePath(root), '{ not json');
    const { fn } = fakeBurst(baseSummary());
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.drain_window_id).not.toBe('win-existing');
  });

  it('restarts the window when the observed weekly reset has passed', async () => {
    const root = tmpRoot();
    // state says weekly drained, reset was 1h before now → fresh window
    writeDrainState(root, existingState({
      week_exhausted: true,
      last_observed_weekly_reset: new Date(T0 - 3600_000).toISOString(),
      completed_task_ids: ['old-task'],
    }));
    const { fn, calls } = fakeBurst(baseSummary());
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    // fresh window: week_exhausted cleared, completed set cleared
    expect(read.state.week_exhausted).toBe(false);
    expect(read.state.completed_task_ids).toEqual([]);
    expect(calls[0].completedTaskIds).toEqual([]);
  });

  it('restarts the window when it has aged out past DRAIN_DURATION_MS', async () => {
    const root = tmpRoot();
    const oldStart = T0 - DRAIN_DURATION_MS - 1000;
    writeDrainState(root, existingState({
      drain_window_started_at: new Date(oldStart).toISOString(),
      completed_task_ids: ['stale'],
    }));
    const { fn, calls } = fakeBurst(baseSummary());
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.drain_window_started_at).toBe(new Date(T0).toISOString());
    expect(calls[0].completedTaskIds).toEqual([]);
  });
});

// ── guards (no burst, returns synthesized summary) ───────────────────────────

describe('runDrain — guards', () => {
  it('next_eligible_at in the future → not-eligible, no burst, no run row', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({
      next_eligible_at: new Date(T0 + 3600_000).toISOString(),
    }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('not-eligible');
    expect(summary.ran).toBe(0);
    // budget.json unchanged (still the same next_eligible_at)
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.next_eligible_at).toBe(new Date(T0 + 3600_000).toISOString());
    // no run-id state dir written
    expect(existsSync(join(root, 'state', summary.run_id))).toBe(false);
  });

  it('week_exhausted before weekly reset → weekly-drained, no burst', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({
      week_exhausted: true,
      last_observed_weekly_reset: new Date(T0 + 86400_000).toISOString(),
    }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('weekly-drained');
    expect(summary.ran).toBe(0);
  });

  it('in-window STOP sentinel → stop-sentinel, no burst', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState());
    // STOP written AFTER the window start
    writeFileSync(stopPath(root), new Date(T0 - 1000).toISOString());
    // window started at T0; stop at T0-1000 is BEFORE start → should be ignored.
    // So write a stop AT/AFTER window start to trigger the guard:
    writeFileSync(stopPath(root), new Date(T0 + 1000).toISOString());
    const summary = await runDrain(opts(root), clockAt(T0 + 2000), burstNeverCalled);
    expect(summary.reason).toBe('stop-sentinel');
  });

  it('stale STOP from before the window start is ignored (burst runs)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({
      drain_window_started_at: new Date(T0).toISOString(),
    }));
    // STOP timestamped BEFORE the current window started → ignored.
    writeFileSync(stopPath(root), new Date(T0 - 10_000).toISOString());
    const { fn, calls } = fakeBurst(baseSummary());
    const summary = await runDrain(opts(root), clockAt(T0 + 1000), fn);
    expect(calls).toHaveLength(1);
    expect(summary.reason).not.toBe('stop-sentinel');
  });

  it('unproductive_reentries >= MAX_UNPRODUCTIVE → no-progress, no burst', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: MAX_UNPRODUCTIVE }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('no-progress');
    expect(summary.ran).toBe(0);
  });
});

// ── state transitions after a burst ──────────────────────────────────────────

describe('runDrain — post-burst state transitions', () => {
  it('session rate-limit → persists next_eligible_at + reason session-paused', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState());
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: SESSION_CLS }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('session-paused');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.next_eligible_at).toBe(SESSION_CLS.reset_at);
  });

  it('session rate-limit with no reset_at → uses SESSION_FALLBACK_MS', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState());
    const cls: RateLimitClassification = { kind: 'session', reset_at: null, reset_horizon: 'hours' };
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: cls }));
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.next_eligible_at).toBe(new Date(T0 + SESSION_FALLBACK_MS).toISOString());
  });

  it('weekly rate-limit → week_exhausted + weekly-drained', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState());
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: WEEKLY_CLS }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('weekly-drained');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.week_exhausted).toBe(true);
    expect(read.state.last_observed_weekly_reset).toBe(WEEKLY_CLS.reset_at);
  });

  it('weekly rate-limit with no reset_at → falls back to now + DRAIN_DURATION_MS', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState());
    const cls: RateLimitClassification = { kind: 'weekly', reset_at: null, reset_horizon: 'days' };
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: cls }));
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.last_observed_weekly_reset).toBe(new Date(T0 + DRAIN_DURATION_MS).toISOString());
  });

  it('first ambiguous rate-limit → session-paused retry (next_eligible_at set)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 0 }));
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: AMBIGUOUS_CLS }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('session-paused');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.next_eligible_at).toBe(new Date(T0 + SESSION_FALLBACK_MS).toISOString());
  });

  it('second ambiguous in a row → ambiguous-signal stop', async () => {
    const root = tmpRoot();
    // consecutive_ambiguous already 1 (a prior ambiguous tick) AND next_eligible_at
    // in the past so the eligibility guard lets the burst run.
    writeDrainState(root, existingState({
      consecutive_ambiguous: 1,
      next_eligible_at: new Date(T0 - 1000).toISOString(),
    }));
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: AMBIGUOUS_CLS }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('ambiguous-signal');
  });

  it('an unproductive (non-ambiguous) tick does NOT trip the ambiguous-in-a-row stop', async () => {
    const root = tmpRoot();
    // unproductive_reentries high but consecutive_ambiguous 0 → a FIRST ambiguous
    // signal must still get its one-retry grace (session-paused, not stopped).
    writeDrainState(root, existingState({
      unproductive_reentries: 2,
      consecutive_ambiguous: 0,
      next_eligible_at: new Date(T0 - 1000).toISOString(),
    }));
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: AMBIGUOUS_CLS }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('session-paused');
  });

  it('completed evidence hashes are unioned into the skip-set across bursts (C1)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ completed_task_ids: ['hashA'] }));
    const { fn, calls } = fakeBurst(baseSummary({
      reason: 'rate-limit', ran: 1, classification: SESSION_CLS,
      completed_evidence_hashes: ['hashB', 'hashA'],
    }));
    await runDrain(opts(root), clockAt(T0), fn);
    // The burst was handed the prior skip-set...
    expect(calls[0].completedTaskIds).toEqual(['hashA']);
    // ...and the new hashes were merged + deduped into persisted state.
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect([...read.state.completed_task_ids].sort()).toEqual(['hashA', 'hashB']);
  });

  it('a session reset_at in the past is floored to now + SESSION_FALLBACK (no spin) (I2)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({}));
    const pastReset: RateLimitClassification = { kind: 'session', reset_at: new Date(T0 - 99_000).toISOString(), reset_horizon: 'hours' };
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: pastReset }));
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    // Not the past reset_at — floored forward so guard 3c won't fire immediately.
    expect(read.state.next_eligible_at).toBe(new Date(T0 + SESSION_FALLBACK_MS).toISOString());
  });

  it('repeated session pauses do NOT trip the no-progress backstop (weekend drain survives)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({}));
    // Three consecutive ticks that each re-enter, run 0 tasks, and hit the session
    // limit. A session pause is a legitimate "come back later" wait — it must NOT
    // accrue toward the no-progress backstop, or a normal weekend drain would
    // self-terminate after 3 windows and abandon most of the week's capacity.
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, classification: SESSION_CLS }));
    for (let i = 0; i < 3; i++) {
      const s = readDrainState(root);
      if (s.kind === 'ok') {
        s.state.next_eligible_at = new Date(T0 - 1000).toISOString(); // rewind so guard 3c passes
        writeDrainState(root, s.state);
      }
      const summary = await runDrain(opts(root), clockAt(T0), fn);
      expect(summary.reason).toBe('session-paused'); // never 'no-progress'
    }
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(0);
  });

  it('lock-busy → returns summary unchanged, budget.json untouched', async () => {
    const root = tmpRoot();
    const before = existingState({ unproductive_reentries: 2, completed_task_ids: ['x'] });
    writeDrainState(root, before);
    const raw = readFileSync(drainStatePath(root), 'utf8');
    const { fn } = fakeBurst(baseSummary({ reason: 'lock-busy', ran: 0, exit_code: 40 }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('lock-busy');
    // state file byte-for-byte unchanged
    expect(readFileSync(drainStatePath(root), 'utf8')).toBe(raw);
  });

  it('productive burst resets unproductive_reentries to 0', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 2 }));
    // v0.8.2 item 1: "ran>0" alone is no longer enough — the burst must report
    // productive=true (non-trivial output) to reset the backstop.
    const { fn } = fakeBurst(baseSummary({ reason: 'completed', ran: 3, productive: true }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('completed');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(0);
  });

  it('unproductive burst (ran 0, no rate-limit) increments the counter', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 1 }));
    const { fn } = fakeBurst(baseSummary({ reason: 'no-candidates', ran: 0, productive: false }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('no-candidates');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(2);
  });

  it('passes the persisted completed_task_ids into the burst', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ completed_task_ids: ['a', 'b'] }));
    const { fn, calls } = fakeBurst(baseSummary());
    await runDrain(opts(root), clockAt(T0), fn);
    expect(calls[0].completedTaskIds).toEqual(['a', 'b']);
  });
});

// ── item 1: configurable circuit breaker + richer productive signal ──────────

describe('runDrain — circuit breaker (item 1)', () => {
  it('default threshold is unchanged (3): at 3 unproductive → no-progress', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 3 }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('no-progress');
  });

  it('honors a configured max_unproductive threshold from drainOpts', async () => {
    const root = tmpRoot();
    // 3 would NOT trip a threshold of 5 — the burst must run.
    writeDrainState(root, existingState({ unproductive_reentries: 3 }));
    const { fn, calls } = fakeBurst(baseSummary({ reason: 'completed', ran: 1, productive: true }));
    const summary = await runDrain(opts(root), clockAt(T0), fn, { maxUnproductive: 5 });
    expect(calls).toHaveLength(1);
    expect(summary.reason).toBe('completed');
  });

  it('a configured threshold of 5 → at 5 unproductive returns no-progress (no burst)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 5 }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled, { maxUnproductive: 5 });
    expect(summary.reason).toBe('no-progress');
  });

  it('a burst that ran>0 but produced only trivial output increments unproductive', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 1 }));
    // ran>0 (a task "succeeded") but productive is NOT true (all-empty diff) →
    // under the richer rule this still counts as a no-progress burst.
    const { fn } = fakeBurst(baseSummary({ reason: 'completed', ran: 2, productive: false }));
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(summary.reason).toBe('completed');
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(2);
  });

  it('a genuinely productive burst (productive=true) resets unproductive to 0', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 2 }));
    const { fn } = fakeBurst(baseSummary({ reason: 'completed', ran: 1, productive: true }));
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(0);
  });

  it('a rate-limit pause (classification present) never increments unproductive', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 2 }));
    // ran 0, not productive, BUT a session rate-limit classification → legit wait.
    const { fn } = fakeBurst(baseSummary({ reason: 'rate-limit', ran: 0, productive: false, classification: SESSION_CLS }));
    await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(0);
  });

  it('transient reasons (discovery-failed/lock-busy/not-eligible) never increment unproductive', async () => {
    for (const reason of ['discovery-failed', 'not-eligible'] as const) {
      const root = tmpRoot();
      writeDrainState(root, existingState({ unproductive_reentries: 1 }));
      const { fn } = fakeBurst(baseSummary({ reason, ran: 0, productive: false }));
      await runDrain(opts(root), clockAt(T0), fn);
      const read = readDrainState(root);
      if (read.kind !== 'ok') throw new Error('expected ok');
      // transient → counter held, NOT incremented.
      expect(read.state.unproductive_reentries).toBe(1);
    }
  });

  it('reaching the configured threshold via trivial bursts eventually trips guard 3d', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ unproductive_reentries: 0 }));
    const { fn } = fakeBurst(baseSummary({ reason: 'completed', ran: 1, productive: false }));
    // 3 trivial bursts → counter climbs 1,2,3.
    for (let i = 0; i < 3; i++) await runDrain(opts(root), clockAt(T0), fn);
    const read = readDrainState(root);
    if (read.kind !== 'ok') throw new Error('expected ok');
    expect(read.state.unproductive_reentries).toBe(3);
    // 4th tick: guard 3d fires (>= default 3) before the burst.
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('no-progress');
  });
});

// ── item 3: per-burst anti-spill guard 3e ────────────────────────────────────

describe('runDrain — anti-spill guard 3e (item 3)', () => {
  // A reset 10 min out; default margin 15 → now is INSIDE the margin → hold off.
  // week_exhausted stays false so guard 3b doesn't pre-empt this case.
  it('within the default 15-min margin of a known reset → anti-spill, no burst', async () => {
    const root = tmpRoot();
    const reset = new Date(T0 + 10 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('anti-spill');
    expect(summary.ran).toBe(0);
  });

  it('anti-spill writes NO burst row and leaves state unchanged', async () => {
    const root = tmpRoot();
    const reset = new Date(T0 + 5 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));
    const raw = readFileSync(drainStatePath(root), 'utf8');
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(summary.reason).toBe('anti-spill');
    // budget.json untouched (no-op tick, consistent with guards 3a-3d).
    expect(readFileSync(drainStatePath(root), 'utf8')).toBe(raw);
    expect(existsSync(join(root, 'state', summary.run_id))).toBe(false);
  });

  it('OUTSIDE the margin (reset far in the future) → burst runs', async () => {
    const root = tmpRoot();
    // reset is 2h out, margin 15 min → now is well before the margin → run.
    const reset = new Date(T0 + 120 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));
    const { fn, calls } = fakeBurst(baseSummary());
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(calls).toHaveLength(1);
    expect(summary.reason).not.toBe('anti-spill');
  });

  it('now AT/after the reset → reactive (NOT anti-spill); window restarts via pastWeeklyReset', async () => {
    const root = tmpRoot();
    // reset already passed by 1 min. pastWeeklyReset → fresh window → reset cleared
    // → no anti-spill, burst runs.
    const reset = new Date(T0 - 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));
    const { fn, calls } = fakeBurst(baseSummary());
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(calls).toHaveLength(1);
    expect(summary.reason).not.toBe('anti-spill');
  });

  it('a configurable margin is honored (60 min margin trips at a 30-min-out reset)', async () => {
    const root = tmpRoot();
    const reset = new Date(T0 + 30 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));
    // default 15-min margin would NOT trip at 30 min out, but a 60-min margin does.
    const summary = await runDrain(opts(root), clockAt(T0), burstNeverCalled, { antiSpillMarginMinutes: 60 });
    expect(summary.reason).toBe('anti-spill');
  });

  it('no reset estimate (FIRST burst of a fresh window) → reactive, no anti-spill', async () => {
    const root = tmpRoot();
    // last_observed_weekly_reset null → the margin guard cannot fire (the genuine
    // blind spot: a fresh window has no reset estimate yet).
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: null }));
    const { fn, calls } = fakeBurst(baseSummary());
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(calls).toHaveLength(1);
    expect(summary.reason).not.toBe('anti-spill');
  });

  it('an unparseable reset → reactive, no anti-spill (best-effort, never throws)', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: 'not-a-date' }));
    const { fn, calls } = fakeBurst(baseSummary());
    const summary = await runDrain(opts(root), clockAt(T0), fn);
    expect(calls).toHaveLength(1);
    expect(summary.reason).not.toBe('anti-spill');
  });
});
