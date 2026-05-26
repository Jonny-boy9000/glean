import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintCandidate } from './memory.js';
import { Memory } from './memory.js';
import type { RunReason } from './types.js';

describe('fingerprintCandidate', () => {
  it('returns identical hash for identical input', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes whitespace and case in title', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO   in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'HANDLE todo IN SRC/FOO.TS',
    });
    expect(a).toBe(b);
  });

  it('produces different hash for different file_path', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/bar.ts',
      title: 'Handle TODO',
    });
    expect(a).not.toBe(b);
  });

  it('treats null file_path as empty string and is stable', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'fetch-docs',
      file_path: null,
      title: 'Pre-fetch docs for lodash',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'fetch-docs',
      file_path: null,
      title: 'Pre-fetch docs for lodash',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hash for different project_path', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\OtherProject',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    expect(a).not.toBe(b);
  });
});

describe('Memory open + migrate', () => {
  it('creates the schema on a fresh DB and sets user_version=2', () => {
    const m = new Memory(':memory:');
    const rows = (m as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(rows).toEqual([{ name: 'candidates' }, { name: 'runs' }]);
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });

  it('is idempotent — opening twice does not error', () => {
    // Opening :memory: creates a fresh DB each time, so use a file path via tmpdir
    const dir = mkdtempSync(join(tmpdir(), 'glean-mem-'));
    const path = join(dir, 'memory.db');
    const m1 = new Memory(path);
    m1.close();
    const m2 = new Memory(path);
    const v = (m2 as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m2.close();
  });
});

describe('Memory run lifecycle', () => {
  it('records a run and updates ended_at + exit_reason on endRun', () => {
    const m = new Memory(':memory:');
    m.recordRun('2026-05-25-1730-abc123', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const before = (m as unknown as { db: { prepare: (s: string) => { get: (k: string) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM runs WHERE run_id = ?').get('2026-05-25-1730-abc123');
    expect(before.project_path).toBe('C:\\Glean');
    expect(before.budget_seconds).toBe(3600);
    expect(before.ended_at).toBeNull();
    expect(before.exit_reason).toBeNull();
    expect(typeof before.started_at).toBe('number');

    m.endRun('2026-05-25-1730-abc123', 'completed' as RunReason);
    const after = (m as unknown as { db: { prepare: (s: string) => { get: (k: string) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM runs WHERE run_id = ?').get('2026-05-25-1730-abc123');
    expect(after.ended_at).not.toBeNull();
    expect(after.exit_reason).toBe('completed');
    m.close();
  });
});

describe('Memory candidate lifecycle', () => {
  it('records a candidate row, returns its integer id, and updates on outcome', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-1', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const candidateId = m.recordCandidate('run-1', {
      candidate_slug: 'c-1',
      candidate_type: 'research-dossier',
      title: 'Handle TODO in src/foo.ts',
      source_signal: 'git-todo',
      file_path: 'src/foo.ts',
      est_value: 0.8,
      est_tokens: 1200,
      priority_rank: 0,
    });
    expect(typeof candidateId).toBe('number');
    expect(candidateId).toBeGreaterThan(0);

    const row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    expect(row.run_id).toBe('run-1');
    expect(row.candidate_slug).toBe('c-1');
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.candidate_type).toBe('research-dossier');
    expect(row.outcome).toBeNull();

    m.recordOutcome(candidateId, 'ok', {
      dossier_path: 'C:\\foo\\OUT.md',
      started_at: 1_700_000_000_000,
      ended_at: 1_700_000_120_000,
      duration_ms: 120_000,
      bytes_written: 4096,
      stderr_rate_limit_hits: 0,
    });
    const after = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    expect(after.outcome).toBe('ok');
    expect(after.dossier_path).toBe('C:\\foo\\OUT.md');
    expect(after.duration_ms).toBe(120_000);
    expect(after.bytes_written).toBe(4096);
    m.close();
  });

  it('accepts a candidate with null file_path', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-2', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const id = m.recordCandidate('run-2', {
      candidate_slug: 'c-2',
      candidate_type: 'fetch-docs',
      title: 'Pre-fetch docs for lodash',
      source_signal: 'deps',
      file_path: null,
      est_value: 0.3,
      est_tokens: 600,
      priority_rank: 1,
    });
    expect(id).toBeGreaterThan(0);
    m.close();
  });
});

describe('Memory migration v2', () => {
  it('creates the dossier_existed_at_7d column on a fresh DB and sets user_version=2', () => {
    const m = new Memory(':memory:');
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('dossier_existed_at_7d');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });

  it('migrates from v1 to v2 on an existing v1 DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glean-mig-v2-'));
    const path = join(dir, 'memory.db');
    // First open creates v2 (latest); to simulate "v1 DB", manually create v1 schema
    // and downgrade user_version before the second open.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
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
    `);
    raw.pragma('user_version = 1');
    raw.close();

    const m = new Memory(path);
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    expect(cols.map((c) => c.name)).toContain('dossier_existed_at_7d');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });
});
