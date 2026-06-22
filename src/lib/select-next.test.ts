import { describe, it, expect } from 'vitest';
import { pickNext, estCostMs, DOWNWEIGHT_THRESHOLD } from './select-next.js';
import type { Candidate } from './types.js';

function c(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'x', evidence_hash: 'h', type: 'research-dossier', project_path: 'p',
    evidence: { kind: 'todo', file: 'src/a.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
    est_value: 50, est_tokens: 1000, status: 'pending',
    ...over,
  };
}

const AMPLE = 60 * 60_000; // remaining wall-clock budget
const TIMEOUT = 8 * 60_000; // per-task timeout

describe('estCostMs (budget-fit cost heuristic)', () => {
  it('is clamped to the per-task timeout (a task can never be estimated to cost more than its timeout)', () => {
    const big = c({ est_tokens: 10_000_000 });
    expect(estCostMs(big, TIMEOUT)).toBe(TIMEOUT);
  });
  it('scales below the timeout for small token estimates', () => {
    const small = c({ est_tokens: 1000 });
    expect(estCostMs(small, TIMEOUT)).toBeLessThan(TIMEOUT);
    expect(estCostMs(small, TIMEOUT)).toBeGreaterThan(0);
  });
});

describe('pickNext — no-pressure ordering (regression pin)', () => {
  it('with ample budget + no failures, picks the SAME first candidate prioritize() would', () => {
    const hi = c({ id: 'hi', est_value: 90, est_tokens: 1000 });
    const lo = c({ id: 'lo', est_value: 20, est_tokens: 1000 });
    const r = pickNext([lo, hi], { remainingMs: AMPLE, taskTimeoutMs: TIMEOUT, typeFailures: new Map() });
    expect(r.pick?.id).toBe('hi');
    expect(r.deferred).toEqual([]);
  });

  it('never defers anything while remaining >= taskTimeoutMs (deferral only under pressure)', () => {
    // 'a' has a huge token estimate (cost clamps to the timeout); at the boundary
    // remaining == timeout, so even the most expensive task fits → nothing deferred.
    const a = c({ id: 'a', est_value: 90, est_tokens: 5_000_000 });
    const b = c({ id: 'b', est_value: 50, est_tokens: 1000 });
    const r = pickNext([a, b], { remainingMs: TIMEOUT, taskTimeoutMs: TIMEOUT, typeFailures: new Map() });
    expect(r.pick).toBeDefined();
    expect(r.deferred).toEqual([]); // the load-bearing assertion: no deferral at/above the timeout
  });
});

describe('pickNext — budget-fit deferral', () => {
  it('defers a candidate too big to finish and runs a smaller one that fits', () => {
    // remaining is BELOW the timeout but still >= the 5-min fetch-docs floor, so
    // research-dossier candidates survive ranking. `big` carries a high enough
    // est_value (90) that despite its huge token cost it RANKS FIRST — but its
    // clamped cost (timeout = 8 min) doesn't fit 6 min, so it's deferred and the
    // lower-ranked `small` (cheap, fits) is picked instead.
    const big = c({ id: 'big', est_value: 90, est_tokens: 5_000_000 });   // ranks first, cost ≈ 8m
    const small = c({ id: 'small', est_value: 20, est_tokens: 1000 });    // ranks second, cost ≪ timeout
    const remainingMs = 6 * 60_000; // 6 min — below timeout, above the 5-min floor
    const r = pickNext([big, small], { remainingMs, taskTimeoutMs: TIMEOUT, typeFailures: new Map() });
    expect(r.pick?.id).toBe('small');
    expect(r.deferred.map((x) => x.id)).toEqual(['big']);
  });

  it('returns no pick when NOTHING fits the remaining budget', () => {
    const big = c({ id: 'big', est_value: 90, est_tokens: 5_000_000 }); // cost = timeout (8m)
    const remainingMs = 6 * 60_000; // 6 min: above the floor (survives ranking) but below big's cost
    const r = pickNext([big], { remainingMs, taskTimeoutMs: TIMEOUT, typeFailures: new Map() });
    expect(r.pick).toBeUndefined();
    expect(r.deferred.map((x) => x.id)).toEqual(['big']);
  });
});

describe('pickNext — adaptive type-downweighting', () => {
  it('downweights a type that has failed >= threshold times, letting a lower-scored other-type win', () => {
    // draft-impl 'di' (env failures this run) and research-dossier 'rd' share the
    // same 1.0 type weight, so di's higher value makes it win normally. After
    // draft-impl fails >= threshold times, its score is multiplied by
    // DOWNWEIGHT_FACTOR and the lower-scored research-dossier now precedes it.
    const di = c({ id: 'di', type: 'draft-impl', est_value: 50, est_tokens: 1000 });
    const rd = c({ id: 'rd', type: 'research-dossier', est_value: 30, est_tokens: 1000 });

    // sanity: with no failures, di wins (higher value, equal weight).
    const before = pickNext([rd, di], { remainingMs: AMPLE, taskTimeoutMs: TIMEOUT, typeFailures: new Map() });
    expect(before.pick?.id).toBe('di');

    // after >= threshold draft-impl failures, the other-type rd now wins.
    const failures = new Map<Candidate['type'], number>([['draft-impl', DOWNWEIGHT_THRESHOLD]]);
    const after = pickNext([rd, di], { remainingMs: AMPLE, taskTimeoutMs: TIMEOUT, typeFailures: failures });
    expect(after.pick?.id).toBe('rd');
  });

  it('does NOT hard-skip a downweighted type — a high-value item of a failing type can still win', () => {
    // draft-impl failed twice, but a very high-value draft-impl item still
    // outscores a low-value research-dossier even after the 0.3 multiplier.
    const diHigh = c({ id: 'diHigh', type: 'draft-impl', est_value: 100, est_tokens: 1000 });
    const rdLow = c({ id: 'rdLow', type: 'research-dossier', est_value: 5, est_tokens: 1000 });
    const failures = new Map<Candidate['type'], number>([['draft-impl', DOWNWEIGHT_THRESHOLD]]);
    const r = pickNext([rdLow, diHigh], { remainingMs: AMPLE, taskTimeoutMs: TIMEOUT, typeFailures: failures });
    expect(r.pick?.id).toBe('diHigh');
  });

  it('does not downweight a type that has failed FEWER than the threshold', () => {
    const di = c({ id: 'di', type: 'draft-impl', est_value: 50, est_tokens: 1000 });
    const rd = c({ id: 'rd', type: 'research-dossier', est_value: 30, est_tokens: 1000 });
    const failures = new Map<Candidate['type'], number>([['draft-impl', DOWNWEIGHT_THRESHOLD - 1]]);
    const r = pickNext([rd, di], { remainingMs: AMPLE, taskTimeoutMs: TIMEOUT, typeFailures: failures });
    expect(r.pick?.id).toBe('di'); // still wins — not yet at threshold
  });
});
