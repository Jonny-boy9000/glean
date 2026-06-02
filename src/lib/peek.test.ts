import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitRoot, findPeekDossier } from './peek.js';
import { writeDrainState } from './state.js';

describe('findGitRoot', () => {
  it('walks up and finds .git in an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-git-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  it('returns null when no .git is found walking up to filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBeNull();
  });
});

describe('findPeekDossier', () => {
  function writeIndex(gleanRoot: string, slug: string, date: string, entries: Array<{ task_id: string; title: string; status: string; output: string; type: string }>): void {
    const dir = join(gleanRoot, 'dossiers', slug, date);
    mkdirSync(dir, { recursive: true });
    const yaml = [
      '---',
      'run_id: r-1',
      `project_path: C:\\${slug}`,
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      ...entries.flatMap((e) => [
        `  - task_id: "${e.task_id}"`,
        `    title: "${e.title}"`,
        `    status: ${e.status}`,
        `    output: "${e.output}"`,
        `    type: ${e.type}`,
      ]),
      '---',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'INDEX.md'), yaml);
  }

  function todayDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it('returns the matching project filtered when cwd is inside a git repo with a dossier', () => {
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos-'));
    const repoRoot = join(reposParent, 'myproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root-'));
    writeIndex(gleanRoot, 'myproj', todayDate(), [
      { task_id: 'task-1', title: 'Handle TODO', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);

    const report = findPeekDossier(gleanRoot, repoRoot);
    expect(report).not.toBeNull();
    expect(report!.projects).toHaveLength(1);
    expect(report!.projects[0].project_slug).toBe('myproj');
    expect(report!.projects[0].entries[0].title).toBe('Handle TODO');
  });

  it('returns null when cwd has no .git OR when no matching dossier exists', () => {
    // Sub-case A: no .git anywhere up
    const noGitDir = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-cwd-'));
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root2-'));
    expect(findPeekDossier(gleanRoot, noGitDir)).toBeNull();

    // Sub-case B: .git exists but no dossier for this repo's slug
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos2-'));
    const repoRoot = join(reposParent, 'otherproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    writeIndex(gleanRoot, 'unrelated', todayDate(), [
      { task_id: 'task-1', title: 'Other', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);
    expect(findPeekDossier(gleanRoot, repoRoot)).toBeNull();
  });

  // v0.8.2 item 4: peek inherits today's window aggregation; the slug filter
  // must still slice an AGGREGATED window report to the CWD project only.
  it('during an active drain window, slices the aggregated report to the CWD project only', async () => {
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-window-repos-'));
    const repoRoot = join(reposParent, 'myproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-window-root-'));

    // Seed a memory.db whose window spans TWO projects.
    const dbPath = join(gleanRoot, 'memory.db');
    const { Memory } = await import('./memory.js');
    const mem = new Memory(dbPath);
    const db = (mem as unknown as { db: import('better-sqlite3').Database }).db;
    const t0 = Date.now() - 2 * 3_600_000;
    db.prepare(
      `INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-mine', t0, t0 + 360_000, 'C:\\repos\\myproj', 3600, 1, 'completed', '0.8.2');
    db.prepare(
      `INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-other', t0 + 60_000, t0 + 420_000, 'C:\\repos\\otherproj', 3600, 1, 'completed', '0.8.2');
    const insCand = db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          stderr_rate_limit_hits, draft_files, draft_insertions, draft_deletions, prep_branch, draft_tests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insCand.run('run-mine', 'task-mine', 'fp-mine', 'research-dossier', 'Mine task', 'git-todo', null, 1.0, 800, 0, 'ok', 'OUT-mine.md', 0, null, null, null, null, null);
    insCand.run('run-other', 'task-other', 'fp-other', 'research-dossier', 'Other task', 'git-todo', null, 1.0, 800, 1, 'ok', 'OUT-other.md', 0, null, null, null, null, null);
    mem.close();

    writeDrainState(gleanRoot, {
      drain_window_id: 'win-1',
      drain_window_started_at: new Date(t0 - 60_000).toISOString(),
      next_eligible_at: null,
      week_exhausted: false,
      last_observed_weekly_reset: null,
      completed_task_ids: [],
      unproductive_reentries: 0,
      schema: 1,
    });

    const report = findPeekDossier(gleanRoot, repoRoot);
    expect(report).not.toBeNull();
    expect(report!.projects).toHaveLength(1);
    expect(report!.projects[0].project_slug).toBe('myproj');
    const titles = report!.projects[0].entries.map((e) => e.title);
    expect(titles).toContain('Mine task');
    expect(titles).not.toContain('Other task');
  });
});
