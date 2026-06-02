import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CandidateType } from './types.js';

export interface FingerprintInput {
  project_path: string;
  candidate_type: CandidateType;
  file_path: string | null;
  title: string;
}

export function fingerprintCandidate(input: FingerprintInput): string {
  const norm = input.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = [
    input.project_path,
    input.candidate_type,
    input.file_path ?? '',
    norm,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

const SCHEMA_V1 = `
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
  stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
`;

export class Memory {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  // True if `table` already has a column named `column`. Used to make ADD COLUMN
  // migrations idempotent (F6): a half-migrated DB (version bump didn't commit but
  // the ALTER did, or a manual edit) must not brick on "duplicate column name".
  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  }

  private addColumnIfMissing(table: string, column: string, ddlType: string): void {
    if (this.hasColumn(table, column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version < 1) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(SCHEMA_V1);
        this.db.pragma('user_version = 1');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    // F6: each ADD COLUMN is guarded by addColumnIfMissing so a half-migrated DB
    // (the ALTER landed but the user_version bump didn't commit, or a column was
    // added out of band) re-runs cleanly instead of throwing "duplicate column
    // name", rolling back, and bricking every future open.
    if (version < 2) {
      this.db.exec('BEGIN');
      try {
        this.addColumnIfMissing('candidates', 'dossier_existed_at_7d', 'INTEGER');
        this.db.pragma('user_version = 2');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    if (version < 3) {
      this.db.exec('BEGIN');
      try {
        this.addColumnIfMissing('candidates', 'user_rating', 'TEXT');
        this.addColumnIfMissing('candidates', 'user_rating_at', 'INTEGER');
        this.db.pragma('user_version = 3');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    if (version < 4) {
      // v4 (T12): draft-impl diff-stat columns so the receipt can read branch results.
      this.db.exec('BEGIN');
      try {
        this.addColumnIfMissing('candidates', 'draft_files', 'INTEGER');
        this.addColumnIfMissing('candidates', 'draft_insertions', 'INTEGER');
        this.addColumnIfMissing('candidates', 'draft_deletions', 'INTEGER');
        this.addColumnIfMissing('candidates', 'prep_branch', 'TEXT');
        this.db.pragma('user_version = 4');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    if (version < 5) {
      // v5 (v0.7.1): glean's own deterministic test-status capture for draft-impl.
      // After a draft session commits, glean runs the project's test_command in
      // the worktree and stores the outcome here ('pass' | 'fail' | 'none').
      this.db.exec('BEGIN');
      try {
        this.addColumnIfMissing('candidates', 'draft_tests', 'TEXT');
        this.db.pragma('user_version = 5');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  recordRun(
    runId: string,
    run: {
      project_path: string;
      budget_seconds: number;
      max_parallel: number;
      glean_version: string;
    },
  ): void {
    this.db.prepare(
      `INSERT INTO runs (run_id, started_at, project_path, budget_seconds, max_parallel, glean_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      Date.now(),
      run.project_path,
      run.budget_seconds,
      run.max_parallel,
      run.glean_version,
    );
  }

  endRun(runId: string, exitReason: string): void {
    this.db.prepare(
      'UPDATE runs SET ended_at = ?, exit_reason = ? WHERE run_id = ?',
    ).run(Date.now(), exitReason, runId);
  }

  recordCandidate(
    runId: string,
    c: {
      candidate_slug: string;
      candidate_type: CandidateType;
      title: string;
      source_signal: 'jsonl' | 'git-todo' | 'gh-pr' | 'deps';
      file_path: string | null;
      est_value: number;
      est_tokens: number;
      priority_rank: number;
    },
  ): number {
    const fingerprint = fingerprintCandidate({
      project_path: this.projectPathFor(runId),
      candidate_type: c.candidate_type,
      file_path: c.file_path,
      title: c.title,
    });
    const info = this.db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId, c.candidate_slug, fingerprint, c.candidate_type, c.title, c.source_signal,
      c.file_path, c.est_value, c.est_tokens, c.priority_rank,
    );
    return Number(info.lastInsertRowid);
  }

  recordOutcome(
    candidateId: number,
    outcome: string,
    fields: {
      dossier_path?: string;
      started_at?: number;
      ended_at?: number;
      duration_ms?: number;
      bytes_written?: number;
      stderr_rate_limit_hits?: number;
      // draft-impl branch results (T12):
      draft_files?: number;
      draft_insertions?: number;
      draft_deletions?: number;
      prep_branch?: string;
      // draft-impl deterministic test status (v5): 'pass' | 'fail' | 'none'.
      draft_tests?: string;
    } = {},
  ): void {
    this.db.prepare(
      `UPDATE candidates
         SET outcome = ?, dossier_path = ?, started_at = ?, ended_at = ?,
             duration_ms = ?, bytes_written = ?, stderr_rate_limit_hits = ?,
             draft_files = ?, draft_insertions = ?, draft_deletions = ?, prep_branch = ?,
             draft_tests = ?
       WHERE id = ?`,
    ).run(
      outcome,
      fields.dossier_path ?? null,
      fields.started_at ?? null,
      fields.ended_at ?? null,
      fields.duration_ms ?? null,
      fields.bytes_written ?? null,
      fields.stderr_rate_limit_hits ?? 0,
      fields.draft_files ?? null,
      fields.draft_insertions ?? null,
      fields.draft_deletions ?? null,
      fields.prep_branch ?? null,
      fields.draft_tests ?? null,
      candidateId,
    );
  }

  findCandidatesNeedingSweep(beforeMs: number): Array<{ id: number; dossier_path: string }> {
    return this.db.prepare(
      `SELECT id, dossier_path
         FROM candidates
        WHERE outcome IS NOT NULL
          AND dossier_path IS NOT NULL
          AND ended_at IS NOT NULL
          AND ended_at < ?
          AND dossier_existed_at_7d IS NULL`,
    ).all(beforeMs) as Array<{ id: number; dossier_path: string }>;
  }

  markDossierExists(candidateId: number, exists: boolean): void {
    this.db.prepare(
      `UPDATE candidates
          SET dossier_existed_at_7d = ?
        WHERE id = ?
          AND dossier_existed_at_7d IS NULL`,
    ).run(exists ? 1 : 0, candidateId);
  }

  setUserRating(candidateId: number, rating: 'kept' | 'discarded' | 'actioned'): { updated: boolean; title: string | null } {
    const row = this.db.prepare('SELECT title FROM candidates WHERE id = ?').get(candidateId) as { title: string } | undefined;
    if (!row) return { updated: false, title: null };
    this.db.prepare('UPDATE candidates SET user_rating = ?, user_rating_at = ? WHERE id = ?')
      .run(rating, Date.now(), candidateId);
    return { updated: true, title: row.title };
  }

  listRecentRatableCandidates(limit: number): Array<{
    id: number;
    title: string;
    candidate_type: CandidateType;
    ended_at: number;
    dossier_path: string;
    user_rating: 'kept' | 'discarded' | 'actioned' | null;
  }> {
    return this.db.prepare(
      `SELECT id, title, candidate_type, ended_at, dossier_path, user_rating
         FROM candidates
        WHERE outcome IS NOT NULL
          AND dossier_path IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT ?`,
    ).all(limit) as Array<{
      id: number;
      title: string;
      candidate_type: CandidateType;
      ended_at: number;
      dossier_path: string;
      user_rating: 'kept' | 'discarded' | 'actioned' | null;
    }>;
  }

  findEnrichmentsBySlugs(slugs: string[]): Map<string, {
    duration_ms: number | null;
    bytes_written: number | null;
    stderr_rate_limit_hits: number;
    user_rating: 'kept' | 'discarded' | 'actioned' | null;
  }> {
    if (slugs.length === 0) return new Map();
    const placeholders = slugs.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT candidate_slug, duration_ms, bytes_written, stderr_rate_limit_hits, user_rating
         FROM candidates
        WHERE candidate_slug IN (${placeholders})`,
    ).all(...slugs) as Array<{
      candidate_slug: string;
      duration_ms: number | null;
      bytes_written: number | null;
      stderr_rate_limit_hits: number;
      user_rating: 'kept' | 'discarded' | 'actioned' | null;
    }>;
    const m = new Map<string, {
      duration_ms: number | null;
      bytes_written: number | null;
      stderr_rate_limit_hits: number;
      user_rating: 'kept' | 'discarded' | 'actioned' | null;
    }>();
    for (const r of rows) {
      m.set(r.candidate_slug, {
        duration_ms: r.duration_ms,
        bytes_written: r.bytes_written,
        stderr_rate_limit_hits: r.stderr_rate_limit_hits,
        user_rating: r.user_rating,
      });
    }
    return m;
  }

  // T13: fetch the most recent run (by started_at) plus all its candidate rows,
  // including the v4 draft-impl columns, so `glean morning` can narrate it.
  // Returns null when there are no runs at all.
  getLatestRunWithCandidates(): {
    run: {
      run_id: string;
      started_at: number;
      ended_at: number | null;
      project_path: string;
      exit_reason: string | null;
    };
    candidates: Array<{
      candidate_slug: string;
      candidate_type: CandidateType;
      title: string;
      outcome: string | null;
      dossier_path: string | null;
      stderr_rate_limit_hits: number;
      draft_files: number | null;
      draft_insertions: number | null;
      draft_deletions: number | null;
      prep_branch: string | null;
      // null on rows written before the v5 migration (genuinely unknown).
      draft_tests: string | null;
    }>;
  } | null {
    const run = this.db.prepare(
      `SELECT run_id, started_at, ended_at, project_path, exit_reason
         FROM runs
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1`,
    ).get() as {
      run_id: string;
      started_at: number;
      ended_at: number | null;
      project_path: string;
      exit_reason: string | null;
    } | undefined;
    if (!run) return null;

    const candidates = this.db.prepare(
      `SELECT candidate_slug, candidate_type, title, outcome, dossier_path,
              stderr_rate_limit_hits, draft_files, draft_insertions,
              draft_deletions, prep_branch, draft_tests
         FROM candidates
        WHERE run_id = ?
        ORDER BY priority_rank ASC, id ASC`,
    ).all(run.run_id) as Array<{
      candidate_slug: string;
      candidate_type: CandidateType;
      title: string;
      outcome: string | null;
      dossier_path: string | null;
      stderr_rate_limit_hits: number;
      draft_files: number | null;
      draft_insertions: number | null;
      draft_deletions: number | null;
      prep_branch: string | null;
      draft_tests: string | null;
    }>;

    return { run, candidates };
  }

  // T6: fetch ALL runs with started_at >= sinceMs, ordered oldest-first, each
  // with its candidate rows. Used by morning.ts to aggregate a drain window into
  // one receipt. Returns an empty array when no runs fall in the window.
  getRunsWithCandidatesSince(sinceMs: number): Array<{
    run: {
      run_id: string;
      started_at: number;
      ended_at: number | null;
      project_path: string;
      exit_reason: string | null;
    };
    candidates: Array<{
      candidate_slug: string;
      candidate_type: CandidateType;
      title: string;
      outcome: string | null;
      dossier_path: string | null;
      stderr_rate_limit_hits: number;
      draft_files: number | null;
      draft_insertions: number | null;
      draft_deletions: number | null;
      prep_branch: string | null;
      draft_tests: string | null;
    }>;
  }> {
    const runs = this.db.prepare(
      `SELECT run_id, started_at, ended_at, project_path, exit_reason
         FROM runs
        WHERE started_at >= ?
        ORDER BY started_at ASC, rowid ASC`,
    ).all(sinceMs) as Array<{
      run_id: string;
      started_at: number;
      ended_at: number | null;
      project_path: string;
      exit_reason: string | null;
    }>;

    const candidateStmt = this.db.prepare(
      `SELECT candidate_slug, candidate_type, title, outcome, dossier_path,
              stderr_rate_limit_hits, draft_files, draft_insertions,
              draft_deletions, prep_branch, draft_tests
         FROM candidates
        WHERE run_id = ?
        ORDER BY priority_rank ASC, id ASC`,
    );

    return runs.map((run) => ({
      run,
      candidates: candidateStmt.all(run.run_id) as Array<{
        candidate_slug: string;
        candidate_type: CandidateType;
        title: string;
        outcome: string | null;
        dossier_path: string | null;
        stderr_rate_limit_hits: number;
        draft_files: number | null;
        draft_insertions: number | null;
        draft_deletions: number | null;
        prep_branch: string | null;
        draft_tests: string | null;
      }>,
    }));
  }

  private projectPathFor(runId: string): string {
    const row = this.db.prepare('SELECT project_path FROM runs WHERE run_id = ?').get(runId) as
      { project_path: string } | undefined;
    if (!row) throw new Error(`memory: unknown run_id ${runId}`);
    return row.project_path;
  }

  close(): void {
    this.db.close();
  }
}
