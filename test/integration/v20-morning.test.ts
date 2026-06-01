import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function todayDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Create a memory.db at the v4 schema (with the draft-impl columns) for the
// morning receipt to read. Mirrors the live schema in src/lib/memory.ts.
async function seedDb(dbPath: string): Promise<import('better-sqlite3').Database> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE runs (
      run_id          TEXT PRIMARY KEY,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      project_path    TEXT NOT NULL,
      budget_seconds  INTEGER NOT NULL,
      max_parallel    INTEGER NOT NULL,
      exit_reason     TEXT,
      glean_version   TEXT NOT NULL
    );
    CREATE INDEX idx_runs_started_at ON runs(started_at);
    CREATE TABLE candidates (
      id                       INTEGER PRIMARY KEY,
      run_id                   TEXT NOT NULL REFERENCES runs(run_id),
      candidate_slug           TEXT NOT NULL,
      fingerprint              TEXT NOT NULL,
      candidate_type           TEXT NOT NULL,
      title                    TEXT NOT NULL,
      source_signal            TEXT NOT NULL,
      file_path                TEXT,
      est_value                REAL NOT NULL,
      est_tokens               INTEGER NOT NULL,
      priority_rank            INTEGER NOT NULL,
      outcome                  TEXT,
      dossier_path             TEXT,
      started_at               INTEGER,
      ended_at                 INTEGER,
      duration_ms              INTEGER,
      bytes_written            INTEGER,
      stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0,
      dossier_existed_at_7d    INTEGER,
      user_rating              TEXT,
      user_rating_at           INTEGER,
      draft_files              INTEGER,
      draft_insertions         INTEGER,
      draft_deletions          INTEGER,
      prep_branch              TEXT
    );
    CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
    CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
  `);
  db.pragma('user_version = 4');
  return db;
}

describe('verification 20: glean morning CLI', () => {
  it('renders a while-you-slept receipt for the latest run (branch + dossier)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v20-home-'));
    const date = todayDate();
    const slug = 'demoproj';
    const worktree = join(home, 'glean', 'work', 'fix-retry-task-1');

    // INDEX.md supplies the authoritative worktree path for the branch entry.
    const dossierDir = join(home, 'glean', 'dossiers', slug, date);
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: run-v20',
      'project_path: C:\\demoproj',
      'generated_at: 2026-06-01T03:18:00.000Z',
      'entries:',
      '  - task_id: "task-1"',
      '    title: "Implement retry in fetch.ts"',
      '    status: ok',
      '    type: draft-impl',
      '    branch: "prep/glean-task-1"',
      '    base: "main"',
      `    worktree: "${worktree.replace(/\\/g, '\\\\')}"`,
      '    files: 2',
      '    insertions: 47',
      '    deletions: 3',
      '  - task_id: "task-2"',
      '    title: "Research caching strategies"',
      '    status: ok',
      '    type: research-dossier',
      '    output: "OUT.md"',
      '---',
      '',
    ].join('\n'));

    const dbPath = join(home, 'glean', 'memory.db');
    const db = await seedDb(dbPath);
    db.prepare('INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-v20', Date.parse('2026-06-01T03:12:00.000Z'), Date.parse('2026-06-01T03:18:00.000Z'), 'C:\\demoproj', 3600, 1, 'completed', '0.7.0');
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          stderr_rate_limit_hits, draft_files, draft_insertions, draft_deletions, prep_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v20', 'task-1', 'fp1', 'draft-impl', 'Implement retry in fetch.ts',
      'git-todo', 'fetch.ts', 1.0, 800, 0, 'ok', null,
      1, 2, 47, 3, 'prep/glean-task-1',
    );
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          stderr_rate_limit_hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v20', 'task-2', 'fp2', 'research-dossier', 'Research caching strategies',
      'git-todo', null, 0.5, 500, 1, 'ok', 'OUT.md',
      0,
    );
    db.close();

    const res = spawnSync('node', ['bin/glean.js', 'morning'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    // Header names the run.
    expect(res.stdout).toContain('run-v20');
    // Branch entry: prep branch, diff stat, correct review/discard commands.
    expect(res.stdout).toContain('prep/glean-task-1');
    expect(res.stdout).toContain('+47');
    expect(res.stdout).toContain('-3');
    expect(res.stdout).toContain('Implement retry in fetch.ts');
    expect(res.stdout).toContain(`cd ${worktree}`);
    expect(res.stdout).not.toMatch(/git checkout prep/);
    expect(res.stdout).toContain(`worktree remove --force ${worktree}`);
    expect(res.stdout).toContain('branch -D prep/glean-task-1');
    // Dossier entry rendered today-style.
    expect(res.stdout).toContain('Research caching strategies');
    // Honest outcome + summary; no weekly-drain claim.
    expect(res.stdout).toContain('6 min');
    expect(res.stdout).toMatch(/completed/i);
    expect(res.stdout.toLowerCase()).not.toContain('drained');
    expect(res.stdout.toLowerCase()).not.toContain('weekly');
  });

  it('surfaces a draft-impl candidate that produced NO branch (I6)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v20-nobranch-'));
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dbPath = join(home, 'glean', 'memory.db');
    const db = await seedDb(dbPath);
    db.prepare('INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-v20nb', Date.parse('2026-06-01T03:12:00.000Z'), Date.parse('2026-06-01T03:13:00.000Z'), 'C:\\demoproj', 3600, 1, 'completed', '0.7.0');
    // draft-impl candidate, outcome failed, prep_branch NULL (provisioning/commit failed).
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          stderr_rate_limit_hits, draft_files, draft_insertions, draft_deletions, prep_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v20nb', 'task-nb', 'fpnb', 'draft-impl', 'Implement a TODO that never landed',
      'git-todo', 'z.ts', 1.0, 800, 0, 'failed', null,
      0, null, null, null, null,
    );
    db.close();

    const res = spawnSync('node', ['bin/glean.js', 'morning'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    // The failed draft-impl is not dropped — it appears with an honest line.
    expect(res.stdout).toContain('Implement a TODO that never landed');
    expect(res.stdout.toLowerCase()).toContain('attempted');
    expect(res.stdout.toLowerCase()).toContain('nothing landed');
  });

  it('prints a friendly message when memory.db is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v20-nodb-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const res = spawnSync('node', ['bin/glean.js', 'morning'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No recent glean run');
  });

  it('renders the trivial-diff guard for an empty branch diff', async () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v20-trivial-'));
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dbPath = join(home, 'glean', 'memory.db');
    const db = await seedDb(dbPath);
    db.prepare('INSERT INTO runs (run_id, started_at, ended_at, project_path, budget_seconds, max_parallel, exit_reason, glean_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('run-v20t', Date.parse('2026-06-01T03:12:00.000Z'), Date.parse('2026-06-01T03:13:00.000Z'), 'C:\\demoproj', 3600, 1, 'completed', '0.7.0');
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          stderr_rate_limit_hits, draft_files, draft_insertions, draft_deletions, prep_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v20t', 'task-x', 'fpx', 'draft-impl', 'Tried a TODO but produced nothing',
      'git-todo', 'x.ts', 1.0, 800, 0, 'failed', null,
      0, 0, 0, 0, 'prep/glean-task-x',
    );
    db.close();

    const res = spawnSync('node', ['bin/glean.js', 'morning'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no changes');
    expect(res.stdout).not.toContain('+0 / -0');
  });
});
