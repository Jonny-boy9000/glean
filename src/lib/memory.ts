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
  }

  close(): void {
    this.db.close();
  }
}
