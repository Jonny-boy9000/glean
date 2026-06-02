import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTodayDossiers } from './today.js';
import { findMorningRun } from './morning.js';
import { writeDrainState } from './state.js';

function makeIndex(root: string, slug: string, date: string, entries: Array<{ title: string; status: string; output: string; type: string; task_id?: string }>, projectPath?: string): void {
  const dir = join(root, 'dossiers', slug, date);
  mkdirSync(dir, { recursive: true });
  const frontmatter = {
    run_id: 'run-x',
    project_path: projectPath ?? `C:\\projects\\${slug}`,
    generated_at: '2026-05-26T10:00:00.000Z',
    entries,
  };
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => k === 'entries'
      ? `entries:\n${(v as typeof entries).map((e, i) => `  - title: ${JSON.stringify(e.title)}\n    status: ${e.status}\n    output: ${JSON.stringify(e.output)}\n    type: ${e.type}\n    task_id: ${JSON.stringify(e.task_id ?? `task-${i + 1}`)}`).join('\n')}`
      : `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(join(dir, 'INDEX.md'), `---\n${yaml}\n---\n\n# body ignored\n`);
}

describe('findTodayDossiers', () => {
  it('returns empty when dossiers directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-empty-'));
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r).toEqual({ date: '2026-05-26', projects: [] });
  });

  it('returns one project group when one INDEX exists for the target date', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-1-'));
    makeIndex(root, 'foo', '2026-05-26', [
      { title: 'Handle TODO in src/a.ts', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
      { title: 'Pre-fetch docs for lodash', status: 'ok', output: 'lodash.md', type: 'fetch-docs' },
    ]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.date).toBe('2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].project_slug).toBe('foo');
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].title).toBe('Handle TODO in src/a.ts');
    expect(r.projects[0].entries[0].status).toBe('ok');
  });

  it('filters to the target date and sorts projects alphabetically', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-multi-'));
    makeIndex(root, 'zebra', '2026-05-26', [{ title: 't1', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    makeIndex(root, 'alpha', '2026-05-26', [{ title: 't2', status: 'failed', output: '', type: 'research-dossier' }]);
    makeIndex(root, 'beta', '2026-05-25', [{ title: 'yesterday', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['alpha', 'zebra']);
  });

  it('skips a project with corrupt frontmatter without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-corrupt-'));
    const dir = join(root, 'dossiers', 'broken', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), 'no frontmatter here, just text\n');
    makeIndex(root, 'good', '2026-05-26', [{ title: 't', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['good']);
  });
});

describe('findTodayDossiers task_id preservation', () => {
  it('preserves task_id from INDEX frontmatter on each entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-taskid-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\proj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - task_id: "task-abc"',
      '    title: "First"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '  - task_id: "task-def"',
      '    title: "Second"',
      '    status: ok',
      '    output: "B.md"',
      '    type: fetch-docs',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].task_id).toBe('task-abc');
    expect(r.projects[0].entries[1].task_id).toBe('task-def');
  });

  it('skips entries that lack task_id (validation guard)', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-notask-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - title: "Has task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '    task_id: "task-x"',
      '  - title: "No task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects[0].entries).toHaveLength(1);
    expect(r.projects[0].entries[0].task_id).toBe('task-x');
  });
});

describe('findTodayDossiers enrichment merge', () => {
  it('attaches memory.db enrichment to entries by task_id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-enr-'));

    // Create a real memory.db using the Memory class.
    const dbPath = join(root, 'memory.db');
    const { Memory } = await import('./memory.js');
    const mem = new Memory(dbPath);
    mem.recordRun('r-1', { project_path: 'C:\\proj', budget_seconds: 3600, max_parallel: 1, glean_version: '0.5.0' });
    const id = mem.recordCandidate('r-1', {
      candidate_slug: 'task-enr-1',
      candidate_type: 'research-dossier',
      title: 'Has enrichment',
      source_signal: 'git-todo',
      file_path: 'a.ts',
      est_value: 0.5,
      est_tokens: 500,
      priority_rank: 0,
    });
    (mem as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=?, duration_ms=?, bytes_written=?, stderr_rate_limit_hits=?, user_rating=? WHERE id=?')
      .run('ok', 'OUT.md', Date.now(), 720_000, 4300, 1, 'kept', id);
    mem.close();

    // INDEX.md with the matching task_id
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - task_id: "task-enr-1"',
      '    title: "Has enrichment"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    const entry = r.projects[0].entries[0];
    expect(entry.duration_ms).toBe(720_000);
    expect(entry.bytes_written).toBe(4300);
    expect(entry.rate_limit_hits).toBe(1);
    expect(entry.user_rating).toBe('kept');
  });

  it('returns entries with no enrichment fields when memory.db is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-nodb-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - task_id: "task-x"',
      '    title: "No memory.db"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    const entry = r.projects[0].entries[0];
    expect(entry.duration_ms).toBeUndefined();
    expect(entry.bytes_written).toBeUndefined();
    expect(entry.user_rating).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v0.8.2 item 4: today/peek window-aware aggregation.
//
// During an ACTIVE drain window, `today` must aggregate ALL runs in the window
// (the same source of truth as `morning`), not just the single date dir. With
// no drain window, `today` runs its EXACT current single-day path (byte-identical).
// ---------------------------------------------------------------------------

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

// Seed a real-schema memory.db (via the Memory class), then stamp run/candidate
// rows with explicit timestamps so a drain window can be reasoned about.
async function seedWindowDb(
  root: string,
  runs: Array<{ run_id: string; project_path: string; started_at: number; ended_at: number | null }>,
  candidates: SeedCandidate[],
): Promise<void> {
  const dbPath = join(root, 'memory.db');
  const { Memory } = await import('./memory.js');
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
  writeDrainState(root, {
    drain_window_id: 'win-1',
    drain_window_started_at: new Date(startedAtMs).toISOString(),
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    schema: 1,
  });
}

describe('findTodayDossiers window-aware aggregation (v0.8.2 item 4)', () => {
  it('during an active drain window, aggregates the SAME branches+dossiers morning reports (parity)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-window-'));
    const projectPath = 'C:\\projects\\demoproj';
    const slug = 'demoproj';

    // Two bursts in the window, separated by a day — the single-day path would
    // only ever see one of them; the window path must see both.
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

    // Window started before the first burst so both runs fall inside it.
    writeWindow(root, t0 - 60_000);

    const today = findTodayDossiers(root);
    const morning = findMorningRun(root);
    expect(morning).not.toBeNull();

    // today must surface every branch + dossier that morning does, across both bursts.
    const todayTitles = today.projects.flatMap((p) => p.entries.map((e) => e.title)).sort();
    const morningTitles = [
      ...morning!.branches.map((b) => b.title),
      ...morning!.files.map((f) => f.title),
    ].sort();
    expect(todayTitles).toEqual(morningTitles);
    expect(todayTitles).toEqual([
      'Add backoff to client.ts',
      'Implement retry in fetch.ts',
      'Pre-fetch docs for zod',
      'Research caching strategies',
    ]);

    // Branch entries carry the prep branch as output, parallel to morning's branches.
    const allEntries = today.projects.flatMap((p) => p.entries);
    const retry = allEntries.find((e) => e.title === 'Implement retry in fetch.ts');
    expect(retry?.type).toBe('draft-impl');
    expect(retry?.task_id).toBe('task-1');
    expect(retry?.output).toBe('prep/glean-task-1');
    expect(retry?.status).toBe('ok');

    // Grouped by project so peek can still slice.
    expect(today.projects).toHaveLength(1);
    expect(today.projects[0].project_slug).toBe(slug);
    expect(today.projects[0].entries).toHaveLength(4);
  });

  it('with NO drain window, output is byte-identical to the single-day path (regression)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-nowindow-'));
    // A seeded memory.db with runs, but NO budget.json → must fall through to
    // the EXACT current single-day INDEX-driven behavior.
    const t0 = Date.parse('2026-06-01T03:00:00.000Z');
    await seedWindowDb(
      root,
      [{ run_id: 'run-a', project_path: 'C:\\projects\\demoproj', started_at: t0, ended_at: t0 + 360_000 }],
      [{ run_id: 'run-a', candidate_slug: 'task-1', candidate_type: 'research-dossier', title: 'A window task', outcome: 'ok', dossier_path: 'OUT.md', prep_branch: null }],
    );

    // Single-day INDEX for a specific date with a DIFFERENT entry — the window
    // aggregator (if wrongly triggered) would surface 'A window task' instead.
    makeIndex(root, 'foo', '2026-05-26', [
      { title: 'Single-day task', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.date).toBe('2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].project_slug).toBe('foo');
    expect(r.projects[0].entries).toHaveLength(1);
    expect(r.projects[0].entries[0].title).toBe('Single-day task');
  });

  it('an active window with ZERO runs falls through honestly (no fabrication)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-zeroburst-'));
    // Window opened but no runs have executed yet, and no INDEX dirs.
    writeWindow(root, Date.now() - 60_000);
    const r = findTodayDossiers(root);
    expect(r.projects).toEqual([]);
  });
});
