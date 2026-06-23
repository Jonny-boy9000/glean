import type { CandidateType } from './types.js';

// v0.9 model routing + --max-turns guards (capacity governor, stage 1).
//
// ASSUMPTION[ADR-0006]: the pool-aware default is 'sonnet' because Max plans
// (since Nov 2025) carry a SEPARATE Sonnet-only weekly pool on top of the
// all-models cap, and Opus burns the shared cap several times faster than
// Sonnet. Whether Pro plans split the pool the same way is UNVERIFIED — the
// default is benign either way (worst case: a slower shared-cap burn). Aliases
// drift across model generations, so the resolved model is logged per task
// (orchestrator log `task.start.model`). Read docs/decisions/0006-* before
// "correcting" any of this.
//
// ASSUMPTION[ADR-0006] drain-both (distinct from the Pro-pool-split above): the
// leg-(b) benefit ("Sonnet draws from an otherwise-unused pool") is currently
// ERODED by a live Anthropic bug — Sonnet drains BOTH buckets (claude-code #57875
// + #57050, closed not-planned). leg-(a) (Opus burns the shared cap several times
// faster, so Sonnet conserves it) is unaffected and IS the load-bearing reason for
// the default. Do NOT invert to opus — the audit's #9 cross-check disproved that.



// Pacing tier handed down by the pacing engine (wave 2 — feat/usage-pacing).
// Until that engine is wired in, callers pass nothing and resolution behaves
// as 'normal'.
export type PaceTier = 'skip' | 'small' | 'normal' | 'large';

export type ModelsConfig = Partial<Record<CandidateType, string>>;
export type MaxTurnsConfig = Partial<Record<CandidateType, number>>;

// The slice of GleanConfig that model routing reads. A full GleanConfig is
// assignable to this, so callers can pass the loaded config verbatim.
export type ModelRoutingConfig = {
  models?: ModelsConfig;
  max_turns?: MaxTurnsConfig;
  pacing_promote?: readonly CandidateType[];
};

// Task-type defaults (design doc "Model routing", verbatim).
export const DEFAULT_MODELS: Readonly<Record<CandidateType, string>> = {
  'fetch-docs': 'haiku',
  'research-dossier': 'sonnet',
  'draft-impl': 'sonnet',
};

// Pool-aware built-in default for any type without a task-type default
// (ASSUMPTION[ADR-0006] above).
const POOL_AWARE_DEFAULT = 'sonnet';

// Only draft-impl routes up under an under-pace week, never blanket.
const DEFAULT_PACING_PROMOTE: readonly CandidateType[] = ['draft-impl'];

// Alias cost ladder for one-tier promotion. A configured FULL model id is not
// on the ladder and is never promoted (an explicit id is an explicit choice).
const TIER_LADDER = ['haiku', 'sonnet', 'opus'] as const;

// --max-turns runaway-loop guard defaults (orthogonal to the 8-min timeout).
export const DEFAULT_MAX_TURNS: Readonly<Record<CandidateType, number>> = {
  'fetch-docs': 8,
  'research-dossier': 24,
  'draft-impl': 50,
};

/**
 * Resolve the `--model` value for a spawned task. Layered, base-to-top:
 *   1. pool-aware built-in default ('sonnet'),
 *   2. task-type default (DEFAULT_MODELS),
 *   3. config per-type override (alias or full model id, verbatim),
 *   4. pacing override — the ONLY layer that may promote:
 *      - 'large' promotes one ladder tier, only for types in pacing_promote
 *        (default ['draft-impl']);
 *      - 'small' demotes EVERYTHING to haiku;
 *      - 'skip' resolves like 'small' (the pacing engine should not spawn at
 *        all under skip; if asked anyway, be maximally conservative).
 * Pure function — unit-tested exhaustively in model-routing.test.ts.
 */
export function resolveModel(
  type: CandidateType,
  cfg: ModelRoutingConfig = {},
  paceTier: PaceTier = 'normal',
): string {
  const base = cfg.models?.[type] ?? DEFAULT_MODELS[type] ?? POOL_AWARE_DEFAULT;
  if (paceTier === 'small' || paceTier === 'skip') return TIER_LADDER[0];
  if (paceTier === 'large') {
    const promote = cfg.pacing_promote ?? DEFAULT_PACING_PROMOTE;
    if (promote.includes(type)) return promoteOneTier(base);
  }
  return base;
}

function promoteOneTier(model: string): string {
  const i = (TIER_LADDER as readonly string[]).indexOf(model);
  if (i === -1) return model;                       // full id / unknown alias — leave as-is
  return TIER_LADDER[Math.min(i + 1, TIER_LADDER.length - 1)];
}

/**
 * Resolve the `--max-turns` value for a spawned task: config per-type override,
 * else the built-in default.
 */
export function resolveMaxTurns(type: CandidateType, cfg: ModelRoutingConfig = {}): number {
  return cfg.max_turns?.[type] ?? DEFAULT_MAX_TURNS[type];
}
