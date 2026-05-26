import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

describe('verification 16: glean rate CLI', () => {
  function setupMemoryWithCandidate(home: string): number {
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dbPath = join(home, 'glean', 'memory.db');
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
        user_rating_at           INTEGER
      );
      CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
      CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
    `);
    db.pragma('user_version = 3');
    db.prepare('INSERT INTO runs (run_id, started_at, project_path, budget_seconds, max_parallel, glean_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-v16', Date.now(), 'C:\\demo', 3600, 1, '0.4.0');
    const info = db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-v16', 'c-v16', 'fp16', 'research-dossier', 'Test ratable dossier', 'git-todo',
      'a.ts', 0.5, 500, 0, 'ok', 'OUT.md', Date.now());
    const id = Number(info.lastInsertRowid);
    db.close();
    return id;
  }

  it('rates a dossier and --list shows the rating (round-trip)', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v16-rt-'));
    const id = setupMemoryWithCandidate(home);

    const rateRes = spawnSync('node', ['bin/glean.js', 'rate', String(id), 'kept'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(rateRes.status).toBe(0);
    expect(rateRes.stdout).toContain(`rated ${id}`);
    expect(rateRes.stdout).toContain('as kept');

    const listRes = spawnSync('node', ['bin/glean.js', 'rate', '--list'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).toContain('Test ratable dossier');
    expect(listRes.stdout).toContain('kept');
    expect(listRes.stdout).toContain(String(id));
  });

  it('exits 1 on invalid verdict with a useful error', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v16-bad-'));
    const id = setupMemoryWithCandidate(home);

    const res = spawnSync('node', ['bin/glean.js', 'rate', String(id), 'wat'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/unknown verdict 'wat'/);
  });
});
