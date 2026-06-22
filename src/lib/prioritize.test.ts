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

  // v0.9 discover-docs: a doc item is explicit human intent (someone wrote it
  // into a roadmap), weighted just under a jsonl idle-session signal: below the
  // jsonl BASE of 30, above the floor that path-penalized todo noise sits at.
  it('doc evidence scores just under the jsonl base of 30', () => {
    const doc = c({ evidence: { kind: 'doc', file: 'ROADMAP.md', heading: 'Up next', item_text: 'Ship the governor', line: 3 } });
    const jsonlBase = scoreValue(c({ evidence: { kind: 'jsonl', session_id: 's', ai_title: 't', idle_hours: 0 } }), {});
    const v = scoreValue(doc, {});
    expect(v).toBeLessThan(jsonlBase);
    expect(v).toBe(28);
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

  it('weights draft-impl at 1.0 (>  fetch-docs at equal value)', () => {
    const d = c({ type: 'draft-impl', est_value: 30, est_tokens: 1000 });
    const f = c({ type: 'fetch-docs', est_value: 30, est_tokens: 1000, evidence: { kind: 'dep', manifest: 'package.json', package: 'p', added_at: 'now' } });
    const ranked = prioritize([f, d], 60 * 60_000, 0);
    expect(ranked[0].type).toBe('draft-impl');
  });

  it('keeps only fetch-docs when <5 min remains', () => {
    const r = c({ type: 'research-dossier' });
    const f = c({ type: 'fetch-docs', evidence: { kind: 'dep', manifest: 'package.json', package: 'p', added_at: 'now' } });
    const ranked = prioritize([r, f], 60 * 60_000, 56 * 60_000); // 4 min remains
    expect(ranked.every((c) => c.type === 'fetch-docs')).toBe(true);
  });

  // wave-2: the path penalty is now applied INSIDE score() rather than by
  // mutating est_value, so the raw est_value a vendor/ candidate carries is left
  // UNCHANGED (the 0.7 factor only affects ranking, never the stored value).
  it('does NOT mutate est_value for vendor/ TODO candidates (penalty lives in score)', () => {
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
    expect(noisy.est_value).toBe(100); // raw est_value untouched (penalty is in scoring only)
  });

  // wave-2 prerequisite: prioritize() must be IDEMPOTENT — callable multiple
  // times with identical results. Previously it mutated c.est_value *= penalty,
  // so a second call compounded the vendor penalty (0.7 → 0.49) and reordered.
  it('is idempotent: calling twice yields identical order and est_values', () => {
    const mk = () => [
      c({ id: 'a', type: 'research-dossier', est_value: 80, est_tokens: 1000, evidence: { kind: 'todo', file: 'vendor/lib.ts', todo_lines: [{ line: 1, text: 'TODO' }] } }),
      c({ id: 'b', type: 'research-dossier', est_value: 60, est_tokens: 1000, evidence: { kind: 'todo', file: 'src/x.ts', todo_lines: [{ line: 1, text: 'TODO' }] } }),
      c({ id: 'd', type: 'fetch-docs', est_value: 30, est_tokens: 1000, evidence: { kind: 'dep', manifest: 'package.json', package: 'p', added_at: 'now' } }),
    ];
    // Re-ranking the SAME array twice (the in-run re-rank path) must be stable.
    const arr = mk();
    const first = prioritize(arr, 60 * 60_000, 0).map((x) => ({ id: x.id, ev: x.est_value }));
    const second = prioritize(arr, 60 * 60_000, 0).map((x) => ({ id: x.id, ev: x.est_value }));
    expect(second).toEqual(first);
  });

  // The vendor penalty must still change RANKING (a vendor TODO loses to an
  // equal-raw-value non-vendor TODO), even though est_value is no longer mutated.
  it('still ranks a vendor/ TODO below an equal-value non-vendor TODO', () => {
    const noisy = c({ id: 'noisy', type: 'research-dossier', est_value: 100, est_tokens: 1000, evidence: { kind: 'todo', file: 'vendor/lib.ts', todo_lines: [{ line: 1, text: 'TODO' }] } });
    const clean = c({ id: 'clean', type: 'research-dossier', est_value: 100, est_tokens: 1000, evidence: { kind: 'todo', file: 'src/x.ts', todo_lines: [{ line: 1, text: 'TODO' }] } });
    const ranked = prioritize([noisy, clean], 60 * 60_000, 0);
    expect(ranked[0].id).toBe('clean');
  });
});
