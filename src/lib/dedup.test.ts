import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterRecentlyProduced, evidenceHash } from './dedup.js';
import type { Candidate } from './types.js';

function dossierRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-dedup-'));
}

function writeIndex(root: string, proj: string, date: string, hashes: string[]): void {
  const dir = join(root, proj, date);
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'run_id: r',
    'project_path: x',
    `generated_at: ${new Date().toISOString()}`,
    'entries:',
    ...hashes.map((h) => `  - { task_id: t, evidence_hash: ${h}, type: research-dossier, title: t, output: o, status: ok }`),
    '---',
    '# index',
  ].join('\n');
  writeFileSync(join(dir, 'INDEX.md'), fm);
}

function candidate(hash: string): Candidate {
  return {
    id: 'x', evidence_hash: hash, type: 'research-dossier', project_path: 'C:\\Glean',
    evidence: { kind: 'todo', file: 'a', todo_lines: [] },
    est_value: 1, est_tokens: 1, status: 'pending',
  };
}

describe('evidenceHash', () => {
  it('is stable for same evidence', () => {
    const c1 = candidate('ignored');
    const c2 = { ...c1 };
    expect(evidenceHash(c1)).toBe(evidenceHash(c2));
  });

  it('differs when evidence differs', () => {
    const c1 = candidate('ignored');
    const c2 = { ...c1, evidence: { ...c1.evidence, file: 'b' as string } as any };
    expect(evidenceHash(c1)).not.toBe(evidenceHash(c2));
  });
});

describe('filterRecentlyProduced', () => {
  it('skips candidates whose hash appears in a recent INDEX', () => {
    const root = dossierRoot();
    const today = new Date().toISOString().slice(0, 10);
    writeIndex(root, 'C-Glean', today, ['hash-a']);
    const cands: Candidate[] = [{ ...candidate('hash-a') }, { ...candidate('hash-b') }];
    const { kept, skipped } = filterRecentlyProduced(cands, root, 'C-Glean');
    expect(kept.map((c) => c.evidence_hash)).toEqual(['hash-b']);
    expect(skipped).toEqual(['hash-a']);
  });

  it('does not skip from indexes older than 7 days', () => {
    const root = dossierRoot();
    const oldDate = new Date(Date.now() - 8 * 86400_000).toISOString().slice(0, 10);
    writeIndex(root, 'C-Glean', oldDate, ['hash-a']);
    const cands = [candidate('hash-a')];
    const { kept } = filterRecentlyProduced(cands, root, 'C-Glean');
    expect(kept.length).toBe(1);
  });

  it('returns all when no index exists', () => {
    const root = dossierRoot();
    const cands = [candidate('hash-a')];
    const { kept, skipped } = filterRecentlyProduced(cands, root, 'C-Glean');
    expect(kept.length).toBe(1);
    expect(skipped.length).toBe(0);
  });
});
