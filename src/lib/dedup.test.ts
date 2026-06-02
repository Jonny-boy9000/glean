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

  // v0.8.2 item 2: pin the cross-burst dedup guarantee. A TODO whose file + line +
  // text are identical across two independently-discovered Candidate objects MUST
  // hash the same, so a multi-day drain window does not re-draft work it already
  // did. (Candidate.id is a random uuid per discovery — only evidence_hash is the
  // stable cross-burst key.)
  it('is stable across two Candidates with identical todo evidence (cross-burst dedup)', () => {
    const day1: Candidate = {
      id: 'uuid-day1', evidence_hash: 'ignored', type: 'draft-impl', project_path: 'C:\\Glean',
      evidence: { kind: 'todo', file: 'src/fetch.ts', todo_lines: [{ line: 42, text: 'TODO: add retry' }] },
      est_value: 5, est_tokens: 100, status: 'pending',
    };
    const day2: Candidate = {
      id: 'uuid-day2-DIFFERENT', evidence_hash: 'ignored', type: 'draft-impl', project_path: 'C:\\Glean',
      evidence: { kind: 'todo', file: 'src/fetch.ts', todo_lines: [{ line: 42, text: 'TODO: add retry' }] },
      est_value: 9, est_tokens: 999, status: 'running',
    };
    // identical evidence (file + line + text) → identical hash despite different
    // id / est_value / est_tokens / status.
    expect(evidenceHash(day1)).toBe(evidenceHash(day2));
  });

  // v0.8.2 item 2 (documented limitation): a TODO whose TEXT is unchanged but
  // whose LINE NUMBER shifted (an edit above it) re-hashes. We deliberately do
  // NOT strip `line` from the hash (that would alter bare-run dedup — a
  // regression surface), so this yields a fresh candidate. Bounded by the
  // worktree already existing + 21-day gc → at worst a second branch, not
  // corruption. This test pins the known behavior so it can't change silently.
  it('a line-number shift yields a NEW hash (documented limitation)', () => {
    const before: Candidate = {
      id: 'x', evidence_hash: 'ignored', type: 'draft-impl', project_path: 'C:\\Glean',
      evidence: { kind: 'todo', file: 'src/fetch.ts', todo_lines: [{ line: 42, text: 'TODO: add retry' }] },
      est_value: 1, est_tokens: 1, status: 'pending',
    };
    const shifted: Candidate = {
      ...before,
      evidence: { kind: 'todo', file: 'src/fetch.ts', todo_lines: [{ line: 50, text: 'TODO: add retry' }] },
    };
    expect(evidenceHash(before)).not.toBe(evidenceHash(shifted));
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
