// morning.test.ts — T6: drain window aggregation for findMorningRun
//
// Tests cover:
//  1. 3-run window aggregation: union of branches, summed rate-limit hits, bursts=3, weekly-drained outcome
//  2. No budget.json → fallback to single-latest-run (no `bursts` field — byte-identical regression test)
//  3. Window with 0 runs → honest 0-burst report

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from './memory.js';
import { findMorningRun } from './morning.js';
import type { DrainState } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-morning-'));
}

function writeMemoryDb(root: string): Memory {
  mkdirSync(root, { recursive: true });
  return new Memory(join(root, 'memory.db'));
}

function writeBudgetJson(root: string, drainWindowStartedAt: string): void {
  const state: DrainState = {
    drain_window_id: 'dw-test',
    drain_window_started_at: drainWindowStartedAt,
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    schema: 1,
  };
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'budget.json'), JSON.stringify(state, null, 2));
}

// Seed a run with a fixed started_at timestamp.
function seedRun(
  m: Memory,
  runId: string,
  startedAt: number,
  opts: {
    exit_reason?: string;
    project_path?: string;
    candidates?: Array<{
      slug: string;
      type?: 'research-dossier' | 'fetch-docs' | 'draft-impl';
      rate_limit_hits?: number;
      dossier_path?: string;
      prep_branch?: string;
    }>;
  } = {},
): void {
  const db = (m as unknown as {
    db: { prepare: (s: string) => { run: (...a: unknown[]) => void } };
  }).db;

  m.recordRun(runId, {
    project_path: opts.project_path ?? 'C:\\TestProj',
    budget_seconds: 3600,
    max_parallel: 1,
    glean_version: '0.8.0',
  });
  // Override started_at (recordRun uses Date.now()).
  db.prepare('UPDATE runs SET started_at = ?, exit_reason = ? WHERE run_id = ?')
    .run(startedAt, opts.exit_reason ?? 'completed', runId);

  for (const c of opts.candidates ?? []) {
    const id = m.recordCandidate(runId, {
      candidate_slug: c.slug,
      candidate_type: c.type ?? 'research-dossier',
      title: `Title for ${c.slug}`,
      source_signal: 'git-todo',
      file_path: 'src/a.ts',
      est_value: 0.5,
      est_tokens: 500,
      priority_rank: 0,
    });
    m.recordOutcome(id, 'ok', {
      dossier_path: c.dossier_path ?? `C:\\glean\\dossiers\\testproj\\${c.slug}\\OUT.md`,
      stderr_rate_limit_hits: c.rate_limit_hits ?? 0,
      prep_branch: c.prep_branch ?? null,
      draft_files: c.prep_branch ? 1 : null,
      draft_insertions: c.prep_branch ? 5 : null,
      draft_deletions: c.prep_branch ? 0 : null,
      draft_tests: c.prep_branch ? 'pass' : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('findMorningRun — drain window aggregation (T6)', () => {
  let root: string;
  let m: Memory;

  beforeEach(() => {
    root = makeTmpRoot();
    m = writeMemoryDb(root);
  });

  afterEach(() => {
    m.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('aggregates 3 bursts: union of branches, summed rate-limit hits, bursts=3, weekly-drained outcome', () => {
    const windowStart = Date.now() - 10_000;
    writeBudgetJson(root, new Date(windowStart).toISOString());

    // Run 1 — a dossier candidate (1 rate-limit hit)
    seedRun(m, 'run-1', windowStart + 100, {
      exit_reason: 'session-paused',
      candidates: [{ slug: 'dossier-a', rate_limit_hits: 1 }],
    });
    // Run 2 — a draft-impl candidate with a branch (2 rate-limit hits)
    seedRun(m, 'run-2', windowStart + 2000, {
      exit_reason: 'session-paused',
      candidates: [
        { slug: 'branch-b', type: 'draft-impl', prep_branch: 'prep/glean-branch-b', rate_limit_hits: 2 },
      ],
    });
    // Run 3 — another dossier + the weekly drain terminal (0 hits)
    seedRun(m, 'run-3', windowStart + 4000, {
      exit_reason: 'weekly-drained',
      candidates: [{ slug: 'dossier-c', rate_limit_hits: 0 }],
    });

    const report = findMorningRun(root);

    expect(report).not.toBeNull();
    expect(report!.bursts).toBe(3);
    expect(report!.exit_reason).toBe('weekly-drained');   // last run's reason
    expect(report!.rate_limit_hits).toBe(3);              // 1+2+0

    // branch-b should be in branches
    expect(report!.branches).toHaveLength(1);
    expect(report!.branches[0].prep_branch).toBe('prep/glean-branch-b');

    // dossier-a and dossier-c should be in files (2 file entries)
    expect(report!.files).toHaveLength(2);
    const fileSlugs = report!.files.map((f) => f.title);
    expect(fileSlugs).toContain('Title for dossier-a');
    expect(fileSlugs).toContain('Title for dossier-c');

    // run_id should be the latest run
    expect(report!.run_id).toBe('run-3');

    // started_at should be the first run's timestamp
    expect(report!.started_at).toBe(windowStart + 100);
  });

  it('deduplicates branches by prep_branch (last-write wins)', () => {
    const windowStart = Date.now() - 10_000;
    writeBudgetJson(root, new Date(windowStart).toISOString());

    // Run 1: branch-x with outcome 'ok' (early pass)
    seedRun(m, 'run-e1', windowStart + 100, {
      exit_reason: 'session-paused',
      candidates: [{ slug: 'branch-x-v1', type: 'draft-impl', prep_branch: 'prep/glean-x' }],
    });
    // Run 2: same prep_branch (retry), outcome should be the newer one
    seedRun(m, 'run-e2', windowStart + 2000, {
      exit_reason: 'completed',
      candidates: [{ slug: 'branch-x-v2', type: 'draft-impl', prep_branch: 'prep/glean-x' }],
    });

    const report = findMorningRun(root);
    expect(report!.bursts).toBe(2);
    // Deduplicated — only one branch entry for prep/glean-x
    expect(report!.branches.filter((b) => b.prep_branch === 'prep/glean-x')).toHaveLength(1);
  });

  it('deduplicates files by candidate_slug (last-write wins)', () => {
    const windowStart = Date.now() - 10_000;
    writeBudgetJson(root, new Date(windowStart).toISOString());

    // Two runs with the same candidate_slug → only one file entry
    seedRun(m, 'run-f1', windowStart + 100, {
      exit_reason: 'session-paused',
      candidates: [{ slug: 'shared-slug', dossier_path: 'C:\\glean\\old\\OUT.md' }],
    });
    seedRun(m, 'run-f2', windowStart + 2000, {
      exit_reason: 'completed',
      candidates: [{ slug: 'shared-slug', dossier_path: 'C:\\glean\\new\\OUT.md' }],
    });

    const report = findMorningRun(root);
    expect(report!.files).toHaveLength(1);
    // Last-write wins — newer dossier_path
    expect(report!.files[0].output).toBe('C:\\glean\\new\\OUT.md');
  });
});

describe('findMorningRun — no budget.json → single-run fallback', () => {
  let root: string;
  let m: Memory;

  beforeEach(() => {
    root = makeTmpRoot();
    m = writeMemoryDb(root);
  });

  afterEach(() => {
    m.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a report with NO bursts field when budget.json is absent', () => {
    // No budget.json written
    const now = Date.now();
    seedRun(m, 'run-solo', now - 1000, {
      exit_reason: 'completed',
      candidates: [{ slug: 'solo-task' }],
    });

    const report = findMorningRun(root);
    expect(report).not.toBeNull();
    expect(report!.bursts).toBeUndefined();   // single-run mode: no bursts field
    expect(report!.exit_reason).toBe('completed');
    expect(report!.files).toHaveLength(1);
    expect(report!.run_id).toBe('run-solo');
  });

  it('the single-run path picks the latest run (not the oldest)', () => {
    const now = Date.now();
    seedRun(m, 'run-old', now - 5000, { exit_reason: 'completed' });
    seedRun(m, 'run-new', now - 1000, { exit_reason: 'budget-exhausted' });

    const report = findMorningRun(root);
    expect(report!.run_id).toBe('run-new');
    expect(report!.exit_reason).toBe('budget-exhausted');
    expect(report!.bursts).toBeUndefined();
  });

  it('returns null when memory.db has no runs', () => {
    // DB exists (created by writeMemoryDb) but no runs seeded
    expect(findMorningRun(root)).toBeNull();
  });

  it('returns null when memory.db is absent', () => {
    const emptyRoot = makeTmpRoot();
    try {
      expect(findMorningRun(emptyRoot)).toBeNull();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('findMorningRun — drain window with 0 runs', () => {
  it('returns a report with bursts=0 and honest "0 bursts" indicator', () => {
    const root = makeTmpRoot();
    const m = writeMemoryDb(root);

    const windowStart = new Date(Date.now() - 3600_000).toISOString();
    writeBudgetJson(root, windowStart);
    // No runs seeded → zero runs in window

    try {
      const report = findMorningRun(root);
      expect(report).not.toBeNull();
      expect(report!.bursts).toBe(0);
      expect(report!.branches).toHaveLength(0);
      expect(report!.files).toHaveLength(0);
      expect(report!.rate_limit_hits).toBe(0);
    } finally {
      m.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
