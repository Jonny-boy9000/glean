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
    if (version < 2) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE candidates ADD COLUMN dossier_existed_at_7d INTEGER');
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
        this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating TEXT');
        this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating_at INTEGER');
        this.db.pragma('user_version = 3');
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
    } = {},
  ): void {
    this.db.prepare(
      `UPDATE candidates
         SET outcome = ?, dossier_path = ?, started_at = ?, ended_at = ?,
             duration_ms = ?, bytes_written = ?, stderr_rate_limit_hits = ?
       WHERE id = ?`,
    ).run(
      outcome,
      fields.dossier_path ?? null,
      fields.started_at ?? null,
      fields.ended_at ?? null,
      fields.duration_ms ?? null,
      fields.bytes_written ?? null,
      fields.stderr_rate_limit_hits ?? 0,
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
