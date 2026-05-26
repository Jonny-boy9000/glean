import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from './memory.js';
import { runDossierExistenceSweep, SWEEP_AGE_MS } from './sweep.js';

function seedEligible(m: Memory, runId: string, slug: string, dossierPath: string, endedAt: number): number {
  m.recordRun(runId, {
    project_path: 'C:\\proj',
    budget_seconds: 3600,
    max_parallel: 1,
    glean_version: '0.3.0',
  });
  const id = m.recordCandidate(runId, {
    candidate_slug: slug,
    candidate_type: 'research-dossier',
    title: slug,
    source_signal: 'git-todo',
    file_path: 'a.ts',
    est_value: 0.5,
    est_tokens: 500,
    priority_rank: 0,
  });
  (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
    .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=? WHERE id=?')
    .run('ok', dossierPath, endedAt, id);
  return id;
}

function readColumn(m: Memory, id: number): number | null {
  const row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
    .db.prepare('SELECT dossier_existed_at_7d FROM candidates WHERE id=?').get(id);
  return row.dossier_existed_at_7d as number | null;
}

describe('runDossierExistenceSweep', () => {
  it('returns zero counts on an empty DB', () => {
    const m = new Memory(':memory:');
    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    m.close();
  });

  it('marks an eligible row as kept when the file exists', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-kept-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, '# real dossier\n');
    const id = seedEligible(m, 'run-1', 'c1', dossierPath, Date.now() - 8 * 86_400_000);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 1, kept: 1, discarded: 0 });
    expect(readColumn(m, id)).toBe(1);
    m.close();
  });

  it('marks an eligible row as discarded when the file is missing', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-gone-'));
    const dossierPath = join(dir, 'does-not-exist.md');
    const id = seedEligible(m, 'run-2', 'c2', dossierPath, Date.now() - 8 * 86_400_000);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 1, kept: 0, discarded: 1 });
    expect(readColumn(m, id)).toBe(0);
    m.close();
  });

  it('skips rows that are too recent', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-recent-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, 'x');
    const id = seedEligible(m, 'run-3', 'c3', dossierPath, Date.now() - 1000);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    expect(readColumn(m, id)).toBeNull();
    m.close();
  });

  it('skips rows already swept', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-done-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, 'x');
    const id = seedEligible(m, 'run-4', 'c4', dossierPath, Date.now() - 8 * 86_400_000);
    (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET dossier_existed_at_7d=1 WHERE id=?').run(id);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    expect(readColumn(m, id)).toBe(1);
    m.close();
  });

  it('treats existsSync throws as discarded without propagating', () => {
    const m = new Memory(':memory:');
    // A path containing a literal null byte forces Node's fs validator to throw.
    const dossierPath = 'C:\\foo\0bar';
    const id = seedEligible(m, 'run-5', 'c5', dossierPath, Date.now() - 8 * 86_400_000);

    expect(() => runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS)).not.toThrow();
    expect(readColumn(m, id)).toBe(0);
    m.close();
  });
});
