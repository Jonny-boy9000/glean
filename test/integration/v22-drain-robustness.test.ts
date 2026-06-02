import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDrain,
  type RunBurst,
  type DrainOpts,
} from '../../src/lib/runDrain.js';
import {
  readDrainState,
  writeDrainState,
  type DrainState,
} from '../../src/lib/state.js';
import { findTodayDossiers } from '../../src/lib/today.js';
import { findMorningRun } from '../../src/lib/morning.js';
import type { PipelineOpts } from '../../src/lib/pipeline.js';
import type { RunSummary } from '../../src/lib/types.js';
import type { RateLimitClassification } from '../../src/lib/classify.js';

// ---------------------------------------------------------------------------
// v22 — cross-lane integration test for the v0.8.2 "drain robustness" milestone.
//
// The per-feature unit tests (runDrain.test.ts, today.test.ts) prove each item
// in isolation. THIS file proves the four v0.8.2 behaviors hold when composed
// against a real persisted budget.json / memory.db over a sequence of ticks:
//   item 3 — anti-spill pre-emptive margin before a known weekly reset
//   item 2 — mid-window re-discovery + cross-burst dedup of completed work
//   item 1 — configurable circuit-breaker threshold (no-progress backstop)
//   item 4 — today == morning during an active drain window (cross-surface)
//
// Determinism: every tick gets an INJECTED now() and an INJECTABLE runBurst, so
// no real `claude -p` ever spawns, there are no sleeps, and no assertion reads a
// live Date.now(). Fixtures are seeded into a fresh mkdtemp gleanRoot per test.
// ---------------------------------------------------------------------------

// A fixed reference "now" so every derived ISO string is stable across runs.
const T0 = Date.parse('2026-06-02T12:00:00.000Z');
const clockAt = (ms: number) => () => ms;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-v22-'));
}

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
    productive: true,
    ...over,
  };
}

// A burst spy that records every opts it was handed (so cross-burst dedup of the
// completed-task skip-set can be inspected) and replays a queue of canned
// summaries — one per call, last one sticky.
function scriptedBurst(summaries: RunSummary[]): { fn: RunBurst; calls: PipelineOpts[] } {
  const calls: PipelineOpts[] = [];
  let i = 0;
  const fn: RunBurst = async (o) => {
    calls.push(o);
    const s = summaries[Math.min(i, summaries.length - 1)];
    i += 1;
    return s;
  };
  return { fn, calls };
}

// A burst that must NEVER run (guard-only ticks).
const burstNeverCalled: RunBurst = async () => {
  throw new Error('runBurst must not be called on a guard-only tick');
};

function existingState(over: Partial<DrainState> = {}): DrainState {
  return {
    drain_window_id: 'win-v22',
    drain_window_started_at: new Date(T0).toISOString(),
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    consecutive_ambiguous: 0,
    schema: 1,
    ...over,
  };
}

function readOk(root: string): DrainState {
  const r = readDrainState(root);
  if (r.kind !== 'ok') throw new Error(`expected ok drain state, got ${r.kind}`);
  return r.state;
}

const SESSION_CLS: RateLimitClassification = {
  kind: 'session',
  reset_at: new Date(T0 + 3 * 3600_000).toISOString(),
  reset_horizon: 'hours',
};

// --- item 4 seed helpers (modeled on today.test.ts seedWindowDb/writeWindow) --

type SeedCandidate = {
  run_id: string;
  candidate_slug: string;
  candidate_type: string;
  title: string;
  outcome: string;
  dossier_path: string | null;
  prep_branch: string | null;
  draft_files?: number | null;
  draft_insertions?: number | null;
  draft_deletions?: number | null;
};

async function seedWindowDb(
  root: string,
  runs: Array<{ run_id: string; project_path: string; started_at: number; ended_at: number | null }>,
  candidates: SeedCandidate[],
): Promise<void> {
  const dbPath = join(root, 'memory.db');
  const { Memory } = await import('../../src/lib/memory.js');
  const mem = new Memory(dbPath);
  const db = (mem as unknown as { db: import('better-sqlite3').Database }).db;
  const insRun = db.prepare(
    `INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of runs) {
    insRun.run(r.run_id, r.started_at, r.ended_at, r.project_path, 3600, 1, 'completed', '0.8.2');
  }
  const insCand = db.prepare(
    `INSERT INTO candidates
       (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
        file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
        stderr_rate_limit_hits, draft_files, draft_insertions, draft_deletions, prep_branch, draft_tests)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let rank = 0;
  for (const c of candidates) {
    insCand.run(
      c.run_id, c.candidate_slug, `fp-${c.candidate_slug}`, c.candidate_type, c.title,
      'git-todo', null, 1.0, 800, rank++, c.outcome, c.dossier_path,
      0, c.draft_files ?? null, c.draft_insertions ?? null, c.draft_deletions ?? null, c.prep_branch, null,
    );
  }
  mem.close();
}

function writeWindow(root: string, startedAtMs: number): void {
  writeDrainState(root, existingState({
    drain_window_id: 'win-aggr',
    drain_window_started_at: new Date(startedAtMs).toISOString(),
  }));
}

describe('v22 drain robustness (cross-lane integration)', () => {
  // ── item 3: anti-spill boundary ────────────────────────────────────────────
  it('item 3 — a tick INSIDE the anti-spill margin holds off (no burst); OUTSIDE it runs; once past the reset a fresh window starts', async () => {
    const root = tmpRoot();
    // A known weekly reset 10 min out. Default anti-spill margin is 15 min, so
    // now()=T0 sits INSIDE [reset-15m, reset) → the burst must be held off.
    const reset = new Date(T0 + 10 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: reset }));

    // Tick A — inside the margin → 'anti-spill', burst never invoked, state untouched.
    const inside = await runDrain(opts(root), clockAt(T0), burstNeverCalled);
    expect(inside.reason).toBe('anti-spill');
    expect(inside.ran).toBe(0);
    expect(readOk(root).last_observed_weekly_reset).toBe(reset); // nothing "spilled"/changed

    // Tick B — OUTSIDE the margin (rewind now to 30 min before the reset, margin
    // is 15) → the burst runs and the window keeps its known reset.
    const farReset = new Date(T0 + 30 * 60_000).toISOString();
    writeDrainState(root, existingState({ week_exhausted: false, last_observed_weekly_reset: farReset }));
    const outside = scriptedBurst([baseSummary({ reason: 'completed', ran: 1, productive: true })]);
    const ranSummary = await runDrain(opts(root), clockAt(T0), outside.fn);
    expect(outside.calls).toHaveLength(1);
    expect(ranSummary.reason).not.toBe('anti-spill');

    // Tick C — now() AT/after the reset → NOT anti-spill. pastWeeklyReset fires,
    // a fresh window starts (reset estimate cleared), and the burst runs anew.
    writeDrainState(root, existingState({ week_exhausted: true, last_observed_weekly_reset: reset }));
    const afterReset = scriptedBurst([baseSummary({ reason: 'completed', ran: 1, productive: true })]);
    const fresh = await runDrain(opts(root), clockAt(T0 + 11 * 60_000), afterReset.fn);
    expect(fresh.reason).not.toBe('anti-spill');
    expect(afterReset.calls).toHaveLength(1);
    const afterState = readOk(root);
    expect(afterState.week_exhausted).toBe(false);                 // fresh window
    expect(afterState.last_observed_weekly_reset).toBeNull();        // estimate cleared
    expect(afterState.completed_task_ids).toEqual([]);              // skip-set reset
  });

  // ── item 2: mid-window re-discovery + cross-burst dedup ────────────────────
  it('item 2 — burst 2 is handed burst 1\'s completed hash in its skip-set, and a new hash unions in', async () => {
    const root = tmpRoot();
    writeDrainState(root, existingState({ completed_task_ids: [] }));

    // Burst 1 completes h1 and pauses on a session limit (a legit "come back
    // later" wait, so the window stays alive for the re-discovery on tick 2).
    // Burst 2 completes a NEW hash h2.
    const burst = scriptedBurst([
      baseSummary({ reason: 'rate-limit', ran: 1, productive: true, classification: SESSION_CLS, completed_evidence_hashes: ['h1'] }),
      baseSummary({ reason: 'completed', ran: 1, productive: true, completed_evidence_hashes: ['h2'] }),
    ]);

    // Tick 1: fresh skip-set ([]), folds h1 in and pauses (session).
    const s1 = await runDrain(opts(root), clockAt(T0), burst.fn);
    expect(s1.reason).toBe('session-paused');
    expect(burst.calls[0].completedTaskIds).toEqual([]);
    expect(readOk(root).completed_task_ids).toEqual(['h1']);

    // Re-eligibility: rewind next_eligible_at into the past so guard 3c clears
    // (this is the deterministic stand-in for "the session window reopened").
    const mid = readOk(root);
    mid.next_eligible_at = new Date(T0 - 1000).toISOString();
    writeDrainState(root, mid);

    // Tick 2: the burst MUST be handed h1 in its skip-set (so re-discovery skips
    // already-done work), and h2 unions into persisted state afterward.
    const s2 = await runDrain(opts(root), clockAt(T0), burst.fn);
    expect(s2.reason).toBe('completed');
    expect(burst.calls).toHaveLength(2);
    expect(burst.calls[1].completedTaskIds).toContain('h1'); // dedup: prior work skipped
    expect([...readOk(root).completed_task_ids].sort()).toEqual(['h1', 'h2']); // union
  });

  // ── item 1: configurable circuit breaker ───────────────────────────────────
  it('item 1 — a configured maxUnproductive=2 trips no-progress after 2 unproductive bursts (default 3 takes one more)', async () => {
    // Configured threshold = 2.
    const root2 = tmpRoot();
    writeDrainState(root2, existingState({ unproductive_reentries: 0 }));
    const drainOpts: DrainOpts = { maxUnproductive: 2 };
    // An unproductive burst: ran 0, productive false, NO classification, a
    // non-transient reason ('no-candidates') → increments the counter.
    const unproductive = () => baseSummary({ reason: 'no-candidates', ran: 0, productive: false });

    // Two consecutive unproductive bursts climb the counter to 2.
    const b1 = scriptedBurst([unproductive()]);
    const t1 = await runDrain(opts(root2), clockAt(T0), b1.fn, drainOpts);
    expect(t1.reason).toBe('no-candidates');
    expect(readOk(root2).unproductive_reentries).toBe(1);

    const b2 = scriptedBurst([unproductive()]);
    const t2 = await runDrain(opts(root2), clockAt(T0), b2.fn, drainOpts);
    expect(t2.reason).toBe('no-candidates');
    expect(readOk(root2).unproductive_reentries).toBe(2);

    // The NEXT tick: guard 3d fires at the configured threshold of 2 → no-progress,
    // burst never invoked.
    const t3 = await runDrain(opts(root2), clockAt(T0), burstNeverCalled, drainOpts);
    expect(t3.reason).toBe('no-progress');

    // Same counter value (2) with the DEFAULT threshold (unset → 3) does NOT trip
    // yet — the burst still runs. This pins the "configurable vs default" contrast.
    const rootDefault = tmpRoot();
    writeDrainState(rootDefault, existingState({ unproductive_reentries: 2 }));
    const stillRuns = scriptedBurst([baseSummary({ reason: 'completed', ran: 1, productive: true })]);
    const td = await runDrain(opts(rootDefault), clockAt(T0), stillRuns.fn);
    expect(stillRuns.calls).toHaveLength(1);
    expect(td.reason).not.toBe('no-progress');
    // It takes a 3rd unproductive burst for the default to trip.
    writeDrainState(rootDefault, existingState({ unproductive_reentries: 3 }));
    const tdStop = await runDrain(opts(rootDefault), clockAt(T0), burstNeverCalled);
    expect(tdStop.reason).toBe('no-progress');
  });

  // ── item 4: today == morning during an active window ───────────────────────
  it('item 4 — during an active drain window, findTodayDossiers surfaces the SAME titles as findMorningRun (cross-surface parity)', async () => {
    const root = tmpRoot();
    const projectPath = 'C:\\projects\\demoproj';
    const slug = 'demoproj';

    // Two bursts a day apart — the single-day path would see only one; the
    // window-aware path (item 4) must see BOTH, matching morning.
    const t0 = Date.parse('2026-06-01T03:00:00.000Z');
    const t1 = Date.parse('2026-06-02T03:00:00.000Z');
    await seedWindowDb(
      root,
      [
        { run_id: 'run-a', project_path: projectPath, started_at: t0, ended_at: t0 + 360_000 },
        { run_id: 'run-b', project_path: projectPath, started_at: t1, ended_at: t1 + 360_000 },
      ],
      [
        { run_id: 'run-a', candidate_slug: 'task-1', candidate_type: 'draft-impl', title: 'Implement retry in fetch.ts', outcome: 'ok', dossier_path: null, prep_branch: 'prep/glean-task-1', draft_files: 2, draft_insertions: 47, draft_deletions: 3 },
        { run_id: 'run-a', candidate_slug: 'task-2', candidate_type: 'research-dossier', title: 'Research caching strategies', outcome: 'ok', dossier_path: 'OUT-a.md', prep_branch: null },
        { run_id: 'run-b', candidate_slug: 'task-3', candidate_type: 'draft-impl', title: 'Add backoff to client.ts', outcome: 'ok', dossier_path: null, prep_branch: 'prep/glean-task-3', draft_files: 1, draft_insertions: 12, draft_deletions: 0 },
        { run_id: 'run-b', candidate_slug: 'task-4', candidate_type: 'fetch-docs', title: 'Pre-fetch docs for zod', outcome: 'ok', dossier_path: 'zod.md', prep_branch: null },
      ],
    );

    // The window opened just before the first burst so both runs fall inside it.
    writeWindow(root, t0 - 60_000);

    const today = findTodayDossiers(root);
    const morning = findMorningRun(root);
    expect(morning).not.toBeNull();

    const todayTitles = today.projects.flatMap((p) => p.entries.map((e) => e.title)).sort();
    const morningTitles = [
      ...morning!.branches.map((b) => b.title),
      ...morning!.files.map((f) => f.title),
    ].sort();

    // The cross-surface contract: today and morning agree, set-for-set.
    expect(todayTitles).toEqual(morningTitles);
    expect(todayTitles).toEqual([
      'Add backoff to client.ts',
      'Implement retry in fetch.ts',
      'Pre-fetch docs for zod',
      'Research caching strategies',
    ]);

    // Both bursts contributed, grouped under the one project so peek can slice.
    expect(today.projects).toHaveLength(1);
    expect(today.projects[0].project_slug).toBe(slug);
    expect(today.projects[0].entries).toHaveLength(4);
    expect(morning!.bursts).toBe(2);
  });
});
