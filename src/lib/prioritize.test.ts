import { describe, it, expect } from 'vitest';
import { prioritize, scoreValue } from './prioritize.js';
import type { Candidate } from './types.js';

function c(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'x', evidence_hash: 'h', type: 'research-dossier', project_path: 'p',
    evidence: { kind: 'todo', file: 'a', todo_lines: [{ line: 1, text: 'TODO' }] },
    est_value: 50, est_tokens: 1000, status: 'pending',
    ...over,
  };
}

describe('scoreValue', () => {
  it('computes value from todo evidence', () => {
    const cand = c({
      evidence: { kind: 'todo', file: 'a', todo_lines: [{ line: 1, text: 'TODO' }, { line: 2, text: 'TODO' }] },
    });
    const v = scoreValue(cand, { fileMtime: Date.now() - 5 * 86400_000 });
    // 2 todos * 20 = 40, file recency = 30 - 5 = 25, total 65, capped 100
    expect(v).toBe(65);
  });

  it('caps todo value at 100', () => {
    const cand = c({
      evidence: { kind: 'todo', file: 'a', todo_lines: Array.from({ length: 10 }, (_, i) => ({ line: i, text: 'TODO' })) },
    });
    expect(scoreValue(cand, { fileMtime: Date.now() })).toBe(100);
  });

  it('fixed value 30 for fetch-docs', () => {
    expect(scoreValue(c({ type: 'fetch-docs', evidence: { kind: 'dep', manifest: 'package.json', package: 'x', added_at: 'now' } }), {})).toBe(30);
  });
});

describe('prioritize', () => {
  it('ranks higher score first', () => {
    const a = c({ est_value: 80, est_tokens: 1000 });
    const b = c({ est_value: 20, est_tokens: 1000 });
    const ranked = prioritize([b, a], 60 * 60_000, 0);
    expect(ranked[0].est_value).toBe(80);
  });

  it('applies type weights (research-dossier > fetch-docs at equal value)', () => {
    const r = c({ type: 'research-dossier', est_value: 30, est_tokens: 1000 });
    const f = c({ type: 'fetch-docs', est_value: 30, est_tokens: 1000, evidence: { kind: 'dep', manifest: 'package.json', package: 'p', added_at: 'now' } });
    const ranked = prioritize([f, r], 60 * 60_000, 0);
    expect(ranked[0].type).toBe('research-dossier');
  });

  it('keeps only fetch-docs when <5 min remains', () => {
    const r = c({ type: 'research-dossier' });
    const f = c({ type: 'fetch-docs', evidence: { kind: 'dep', manifest: 'package.json', package: 'p', added_at: 'now' } });
    const ranked = prioritize([r, f], 60 * 60_000, 56 * 60_000); // 4 min remains
    expect(ranked.every((c) => c.type === 'fetch-docs')).toBe(true);
  });

  it('soft-weights TODO candidates in vendor/ paths to 70%', () => {
    const normal = c({
      type: 'research-dossier',
      est_value: 100,
      est_tokens: 1000,
      evidence: { kind: 'todo', file: 'src/foo.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
    });
    const noisy = c({
      type: 'research-dossier',
      est_value: 100,
      est_tokens: 1000,
      evidence: { kind: 'todo', file: 'vendor/lib.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
    });
    prioritize([noisy, normal], 60 * 60_000, 0);
    expect(normal.est_value).toBe(100);
    expect(noisy.est_value).toBe(70);
  });
});
