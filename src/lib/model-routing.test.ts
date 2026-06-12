import { describe, it, expect } from 'vitest';
import { resolveModel, resolveMaxTurns, DEFAULT_MODELS, DEFAULT_MAX_TURNS } from './model-routing.js';
import type { CandidateType } from './types.js';

// v0.9 model routing (ADR-0006). Layered resolution, base-to-top:
//   1. pool-aware built-in default ('sonnet'),
//   2. task-type default (fetch-docs → haiku, research-dossier → sonnet,
//      draft-impl → sonnet),
//   3. config per-type override (alias or full model id),
//   4. pacing override — the ONLY layer that may promote, and only for the
//      types listed in pacing_promote (default ['draft-impl']) under 'large';
//      'small'/'skip' demote everything to haiku.
describe('resolveModel', () => {
  const ALL_TYPES: CandidateType[] = ['fetch-docs', 'research-dossier', 'draft-impl'];

  // ── defaults (no config, normal tier) ──────────────────────────────────────
  it('applies the task-type defaults under the normal tier', () => {
    expect(resolveModel('fetch-docs', {}, 'normal')).toBe('haiku');
    expect(resolveModel('research-dossier', {}, 'normal')).toBe('sonnet');
    expect(resolveModel('draft-impl', {}, 'normal')).toBe('sonnet');
  });

  it('omitting paceTier behaves as normal', () => {
    for (const t of ALL_TYPES) {
      expect(resolveModel(t, {})).toBe(resolveModel(t, {}, 'normal'));
    }
  });

  it('omitting cfg behaves as an empty config', () => {
    for (const t of ALL_TYPES) {
      expect(resolveModel(t)).toBe(resolveModel(t, {}, 'normal'));
    }
  });

  // The exported default map mirrors the design doc verbatim.
  it('exports the design-doc default models map', () => {
    expect(DEFAULT_MODELS).toEqual({
      'fetch-docs': 'haiku',
      'research-dossier': 'sonnet',
      'draft-impl': 'sonnet',
    });
  });

  // ── config per-type override ───────────────────────────────────────────────
  it('config models map overrides the task-type default (alias)', () => {
    const cfg = { models: { 'fetch-docs': 'sonnet' } };
    expect(resolveModel('fetch-docs', cfg, 'normal')).toBe('sonnet');
    // other types keep their defaults
    expect(resolveModel('research-dossier', cfg, 'normal')).toBe('sonnet');
    expect(resolveModel('draft-impl', cfg, 'normal')).toBe('sonnet');
  });

  it('config models map accepts a full model id string verbatim', () => {
    const cfg = { models: { 'research-dossier': 'claude-sonnet-4-5-20250929' } };
    expect(resolveModel('research-dossier', cfg, 'normal')).toBe('claude-sonnet-4-5-20250929');
  });

  // ── pacing tier: small / skip demote EVERYTHING to haiku ──────────────────
  it("'small' demotes every type to haiku, overriding config", () => {
    const cfg = { models: { 'draft-impl': 'opus', 'research-dossier': 'sonnet' } };
    for (const t of ALL_TYPES) {
      expect(resolveModel(t, cfg, 'small')).toBe('haiku');
    }
  });

  it("'skip' resolves like 'small' (maximally conservative — the pacing engine should not spawn at all under skip)", () => {
    for (const t of ALL_TYPES) {
      expect(resolveModel(t, {}, 'skip')).toBe('haiku');
    }
  });

  // ── pacing tier: large promotes ONE tier, only for pacing_promote types ───
  it("'large' promotes draft-impl one tier (sonnet → opus) by default", () => {
    expect(resolveModel('draft-impl', {}, 'large')).toBe('opus');
  });

  it("'large' never promotes types outside pacing_promote (no blanket route-up)", () => {
    expect(resolveModel('fetch-docs', {}, 'large')).toBe('haiku');
    expect(resolveModel('research-dossier', {}, 'large')).toBe('sonnet');
  });

  it("'large' + config haiku draft-impl promotes one tier to sonnet (not straight to opus)", () => {
    const cfg = { models: { 'draft-impl': 'haiku' } };
    expect(resolveModel('draft-impl', cfg, 'large')).toBe('sonnet');
  });

  it("'large' + config opus draft-impl stays opus (top of ladder)", () => {
    const cfg = { models: { 'draft-impl': 'opus' } };
    expect(resolveModel('draft-impl', cfg, 'large')).toBe('opus');
  });

  it("'large' leaves a full model id unchanged (an explicit id is not on the alias ladder)", () => {
    const cfg = { models: { 'draft-impl': 'claude-sonnet-4-5-20250929' } };
    expect(resolveModel('draft-impl', cfg, 'large')).toBe('claude-sonnet-4-5-20250929');
  });

  it('pacing_promote config controls WHICH types promote under large', () => {
    const cfg = { pacing_promote: ['research-dossier' as const] };
    expect(resolveModel('research-dossier', cfg, 'large')).toBe('opus');
    expect(resolveModel('draft-impl', cfg, 'large')).toBe('sonnet'); // no longer listed
  });

  it('an empty pacing_promote disables promotion entirely', () => {
    const cfg = { pacing_promote: [] as const };
    for (const t of ALL_TYPES) {
      expect(resolveModel(t, cfg, 'large')).toBe(resolveModel(t, cfg, 'normal'));
    }
  });

  // ── exhaustive matrix: every (type × tier) with no config is a defined,
  // non-empty model string (resolution can never come back blank). ───────────
  it('every type × tier combination resolves to a non-empty string', () => {
    for (const t of ALL_TYPES) {
      for (const tier of ['skip', 'small', 'normal', 'large'] as const) {
        const m = resolveModel(t, {}, tier);
        expect(typeof m).toBe('string');
        expect(m.length).toBeGreaterThan(0);
      }
    }
  });
});

// --max-turns per spawn: runaway-loop guard orthogonal to the 8-min timeout.
describe('resolveMaxTurns', () => {
  it('applies the built-in defaults per task type', () => {
    expect(resolveMaxTurns('fetch-docs', {})).toBe(8);
    expect(resolveMaxTurns('research-dossier', {})).toBe(24);
    expect(resolveMaxTurns('draft-impl', {})).toBe(50);
  });

  it('exports the design-doc default max-turns map', () => {
    expect(DEFAULT_MAX_TURNS).toEqual({
      'fetch-docs': 8,
      'research-dossier': 24,
      'draft-impl': 50,
    });
  });

  it('config max_turns map overrides the default per type', () => {
    const cfg = { max_turns: { 'fetch-docs': 4, 'draft-impl': 100 } };
    expect(resolveMaxTurns('fetch-docs', cfg)).toBe(4);
    expect(resolveMaxTurns('research-dossier', cfg)).toBe(24); // untouched default
    expect(resolveMaxTurns('draft-impl', cfg)).toBe(100);
  });

  it('omitting cfg behaves as an empty config', () => {
    expect(resolveMaxTurns('research-dossier')).toBe(24);
  });
});
