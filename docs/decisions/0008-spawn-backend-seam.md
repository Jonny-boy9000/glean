# ADR-0008 — Spawn-backend seam (subscription-only stays the headline; an API mode is a designed-but-unbuilt hedge)

- Status: **Accepted** (seam designed, NOT implemented — 2026-06-22)
- Date: 2026-06-22
- Enforced at: `src/lib/spawn-claude.ts` (the `SpawnBackend` interface + `subscriptionBackend`
  conformance, tagged `SEAM[ADR-0008]`). Strategy: [`docs/strategy/2026-06-22-next-wave-strategy.md`](../strategy/2026-06-22-next-wave-strategy.md),
  landscape: [`…-competitive-landscape.md`](../strategy/2026-06-22-competitive-landscape.md).

## Context

Glean's load-bearing constraint (CLAUDE.md) is **subscription auth, no API key**: capacity is consumed
by spawning `claude -p` subprocesses against the user's logged-in session. The 2026-06-22 strategic
review (verified competitive research + a codebase coupling audit) asked whether to add an opt-in
API-key mode. Findings:

- **The pitch evaporates under an API key.** Glean's value is "consume capacity you already paid for at
  zero marginal cost." An API key is pay-per-token — a *different economic category* (the metered camp:
  Cursor, Copilot, OpenHands BYO-key), serving a *different user* (pooled org quota), and it steps toward
  the reselling line Anthropic's ToS prohibits (which Glean deliberately avoids). The closest tools to
  Glean are subscription-only; Anthropic's own Claude Code Routines *rejects* an API key outright.
- **But there is a real exogenous risk to hedge.** Anthropic *paused* (did not cancel) a 2026-06-15
  change that would move `claude -p` / Agent-SDK usage onto separate **metered credits**. If un-paused,
  the free-idle-capacity thesis is directly undercut. An opt-in API mode is the *insurance* for that day.
- **Coupling audit:** the spawn is already cleanly isolated behind `runClaude(c, ctx, opts) → SpawnOutcome`
  in `spawn-claude.ts` (Phase 2c split). But an API backend is NOT a drop-in: it would need different
  rate-limit semantics (no 5-hour/weekly *session* windows — API has per-minute/quota limits), and the
  pacing/usage engine (`usage.ts`, `pacing.ts`) reads `~/.claude/projects/*.jsonl` session history that
  an API path does not produce. So an API mode is a *distinct path*, not a toggle.

## Decision

**Keep subscription-only as the headline and the only implemented backend. Design the seam now; do not
build the API backend.**

Concretely, `spawn-claude.ts` defines a `SpawnBackend` interface and a `subscriptionBackend` that conforms
(the current `runClaude`). This marks — and type-checks — exactly where an API backend would slot in,
without restructuring the safety-critical spawn path or shipping unused code paths. The deny-list / allow-
list safety boundary (the unconditional `--disallowedTools`) is unchanged and still argv-asserted (F2).

**What "building it" would entail later (deliberately deferred):**
1. An `apiKeyBackend: SpawnBackend` (Anthropic SDK / Messages API) implementing the same contract.
2. A backend selector in the executor (`ctx.backend === 'api-key' ? apiKeyBackend : subscriptionBackend`),
   gated on an explicit opt-in (`ANTHROPIC_API_KEY` set **and** a config flag) — never the default.
3. Adapt `classify.ts` (API rate-limit shape ≠ `rate_limit_event` stream-json) and make the
   pacing/usage engine degrade gracefully when there is no session-JSONL (treat pace as `normal`, or
   query an API usage endpoint if one ever exists).

## Status / what would change this

Promote to "build" **only if** Anthropic un-pauses metered `claude -p` billing (watch weekly) or a
concrete user need for pooled-quota/cloud execution emerges. **Multi-LLM is explicitly out of scope** —
it is structurally incompatible with the capacity thesis (per-token billing) and would be a separate
product, not a backend of this one. If built, supersede this ADR with the verified API rate-limit shape.
