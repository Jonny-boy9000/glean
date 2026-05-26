import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 15: glean today CLI', () => {
  it('prints a grouped report when dossiers exist for today', async () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-home-'));
    const today = localDateString(new Date());
    const dossierDir = join(home, 'glean', 'dossiers', 'demoproj', today);
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\demoproj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - title: "Handle TODO in src/a.ts"',
      '    status: ok',
      '    output: "C:\\\\Users\\\\u\\\\glean\\\\dossiers\\\\demoproj\\\\' + today + '\\\\x\\\\OUT.md"',
      '    type: research-dossier',
      '    task_id: "task-1"',
      '---',
      '',
      '# body ignored',
      '',
    ].join('\n'));

    // Seed memory.db with matching enrichment so the enrichment line should appear.
    const dbPath = join(home, 'glean', 'memory.db');
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
        user_rating_at           INTEGER
      );
      CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
      CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
    `);
    db.pragma('user_version = 3');
    db.prepare('INSERT INTO runs (run_id, started_at, project_path, budget_seconds, max_parallel, glean_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-v15', Date.now(), 'C:\\demoproj', 3600, 1, '0.5.0');
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          ended_at, duration_ms, bytes_written, user_rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v15', 'task-1', 'fp15', 'research-dossier', 'Handle TODO in src/a.ts',
      'git-todo', 'a.ts', 0.5, 500, 0, 'ok', 'OUT.md',
      Date.now(), 720_000, 4300, 'kept',
    );
    db.close();

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`GLEAN today — ${today}`);
    expect(res.stdout).toContain('▸ demoproj');
    expect(res.stdout).toContain('1 tasks');
    expect(res.stdout).toContain('Handle TODO in src/a.ts');
    expect(res.stdout).toContain('ok');
    expect(res.stdout).toContain('12m');
    expect(res.stdout).toContain('4.2KB');
    expect(res.stdout).toContain('rated: kept');
  });

  it('prints the empty-case message when no dossiers exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-empty-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const today = localDateString(new Date());
    expect(res.stdout).toContain(`No glean dossiers for ${today}.`);
  });
});

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
