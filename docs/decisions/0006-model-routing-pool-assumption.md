# ADR-0006 — Model routing: pool-aware Sonnet default, --max-turns guard, and the unverified Pro pool split

- Status: **Accepted** (default verified benign; the Pro pool-split remains an open assumption)
- Date: 2026-06-13
- Enforced at: `src/lib/model-routing.ts` (`resolveModel`/`resolveMaxTurns`, the
  `ASSUMPTION[ADR-0006]` tag at the pool-aware default), `src/lib/executor.ts` (`runClaude`
  spawn-arg assembly: `--model` + `--max-turns`), `src/lib/pipeline.ts` (`task.start` logs the
  resolved model), `src/lib/config.ts` (`models` / `max_turns` / `pacing_promote` keys); tests:
  `src/lib/model-routing.test.ts` (full resolution matrix), the three model-routing argv-spy
  tests in `src/lib/executor.test.ts`, the orchestrator-log/argv test in `src/lib/pipeline.test.ts`.

## Context

Until v0.9, glean spawned `claude -p` with **no `--model` flag**, inheriting the account default.
Max accounts default to Opus — so an unrouted drain burned the *most expensive* capacity
available, against the tool's whole premise of consuming leftover capacity efficiently.

Research findings (verified 2026-06-12, recorded in the capacity-governor design doc's
"Model routing" section):

- `--model` is documented for `-p` (print) mode, accepting aliases (`sonnet|opus|haiku|fable`)
  and full model ids. `--fallback-model` exists but explicitly does **not** trigger on
  rate-limit errors — it cannot be used to dodge the cap.
- Anthropic's help center: **"Opus costs several times more per turn than Sonnet, and Sonnet
  more than Haiku"** — no published numeric multiplier.
- **Since the Nov 2025 limit change, Max plans carry TWO weekly limits: an all-models cap plus
  a separate Sonnet-only pool.** A Sonnet-routed drain therefore (a) burns the shared cap
  several times slower than Opus and (b) draws from a pool that otherwise goes entirely unused
  on Opus-defaulting accounts.
- Community-validated lesson from overnight-runner tools: pass **`--max-turns`** on every
  spawned print-mode session as a runaway-loop guard, orthogonal to the wall-clock timeout
  (`--max-budget-usd` is a no-op under subscription auth — don't rely on it).

## Decision

1. **Every spawned task gets an explicit `--model`**, resolved in layers (base → top):
   pool-aware built-in default **`sonnet`** → task-type default
   (`fetch-docs → haiku`, `research-dossier → sonnet`, `draft-impl → sonnet`) → config
   per-type override (`config.json` `models` map; alias or full id, passed verbatim) →
   pacing override. The pacing override is the **only** layer that may promote, and only as
   the design allows: `large` (under-pace) promotes one ladder tier
   (haiku → sonnet → opus) for the types in `pacing_promote` (default `["draft-impl"]` —
   "route up" is never blanket); `small`/`skip` demote everything to haiku. The pace tier is a
   wave-2 hook: `resolveModel(type, cfg, paceTier)` accepts it today, the pacing engine
   (`feat/usage-pacing`) wires the real value later; absent → `'normal'`.
2. **Every spawned task gets `--max-turns`** (defaults: fetch-docs 8, research-dossier 24,
   draft-impl 50; `config.json` `max_turns` map overrides per type).
3. **The resolved model string is logged per task** on the orchestrator log's `task.start`
   event (`model:`). This is the alias-drift mitigation: `sonnet` points at a different
   concrete model across generations, so the receipt of what actually ran must be recorded at
   run time, not reconstructed from config later.

## ASSUMPTION (what is verified vs. guessed)

- **Verified:** the Max-plan separate Sonnet pool and the Opus-burns-several-times-faster
  cost ordering (Anthropic help center, Nov 2025 limit change — see the design doc's research
  section). `--model`/`--max-turns` are documented print-mode flags.
- **ASSUMPTION[ADR-0006] — unverified:** whether **Pro** plans split the pool the same way.
  The `sonnet` default is benign either way: if Pro has no separate Sonnet pool, the only
  effect is a slower burn of the single shared cap (still strictly better than Opus for
  speculative background work). Confirm empirically via the `rateLimitType` values glean
  already captures in `~/glean/logs/<run>/<task>.jsonl`.
- **Assumed, low-stakes:** the one-tier promotion ladder treats only the three cost aliases
  (`haiku < sonnet < opus`); a configured full model id (or any other alias) is never
  promoted — an explicit id is an explicit choice.

## What would change this

- A captured `rate_limit_event` showing a Sonnet-pool `rateLimitType` (or its absence) on a
  Pro account closes the open assumption — update this ADR's status note, don't supersede.
- If Anthropic publishes per-model weekly multipliers or a queryable per-pool usage endpoint,
  the routing default should be revisited against real numbers (and the pacing weights in the
  concurrent pacing ADR recalibrated).
- If `--model` ever stops being honored in `-p` mode (CLI regression), the spawn-argv tests
  fail loudly; the orchestrator-log `model:` field tells you what each historical run actually
  requested.

## Status note — 2026-06-23 (assumption audit #9 cross-check)

**AFFIRMED:** the separate **Sonnet-only** weekly pool is documented-correct (Anthropic Nov-24-2025
"Sonnet now has its own limit"; the Max-plan page "another for Sonnet models only";
`anthropics/claude-code` #55663/#12487). **DO NOT INVERT to "Opus-only."** A sub-auditor proposed exactly
that and it was *disproved* in the audit cross-check; inverting would re-introduce the ADR-0001 failure
mode in reverse (a wrong "correction" stated as fact). **Keep `--model sonnet` as the default** — this is
the verified-correct decision; the routing is sound.

**WEAKENED (leg-(b) only):** the *"draws from an otherwise-unused pool"* benefit (clause **(b)** in Context)
is currently **degraded by a live Anthropic bug** — Sonnet drains **BOTH** the all-models cap AND the
Sonnet-only pool (`anthropics/claude-code` **#57875** + closer-duplicate **#57050**, CLOSED not-planned).
The **leg-(a)** benefit (clause **(a)**: Opus burns the shared cap several times faster, so Sonnet conserves
it) is **unaffected** and remains the load-bearing reason for the default. Re-verify via a captured
`rateLimitType` on a real drain. The **paused metered-billing change** ([ADR-0008](./0008-spawn-backend-seam.md)
/ [ADR-0011](./0011-tos-basis-for-scheduled-claude-p.md)) is the dominant frame threat to the whole routing
rationale, watched weekly. Status: still **Accepted**; do not supersede.
