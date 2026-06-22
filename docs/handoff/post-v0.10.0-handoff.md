# Post-v0.10.0 handoff — what's next after the strategy-driven moat wave

> Self-contained handoff so a **fresh session** can pick up cold. Everything needed is here or linked.
> This is the **only live handoff** (convention: exactly one live handoff in `docs/handoff/`; superseded
> ones move to `docs/archive/` — the previous one is at [`docs/archive/post-v0.9.0-handoff.md`](../archive/post-v0.9.0-handoff.md)).

**As of:** 2026-06-22. **v0.10.0 is published** (`@jonny-boy9000/glean@0.10.0`, merge `0c86ebf`, tag
`v0.10.0`), built on **v0.9.0** (published the same day: capacity-governor wave-1 + the full-project-review
hardening). `main` is clean at v0.10.0. **801 tests + 7 skips.** Build ✅, eslint ✅. Install:
`npm i -g @jonny-boy9000/glean`.

> **🧭 STRATEGY IS NOW PINNED (2026-06-22).** A verified competitive review + a codebase coupling audit
> set the project's direction — read before any "where should this go" work:
> [`docs/strategy/2026-06-22-next-wave-strategy.md`](../strategy/2026-06-22-next-wave-strategy.md) +
> [`…-competitive-landscape.md`](../strategy/2026-06-22-competitive-landscape.md). Headline: **Anthropic now
> ships first-party scheduled Claude agents** (Routines + Desktop tasks), so the *scheduling shell* is
> commodity — but **Glean's local cross-project discovery + idle-capacity-drain economics are uncontested.**
> Decisions: **stay narrow** (capacity governor + local discovery), **subscription-only headline**,
> **Claude-native**. An opt-in API mode is a *designed-but-unbuilt hedge* ([ADR-0008](../decisions/0008-spawn-backend-seam.md));
> multi-LLM is explicitly out of scope (a separate product).

> **🟢 SAFETY POSTURE (updated 2026-06-23 — honest, post-audit).** No Anthropic API-key path exists in `src/`;
> **every** spawn funnels through one `runClaude()` that unconditionally appends the deny-list (asserted at the
> **argv** level); built-in Edit/Write are bounded to the worktree via `--add-dir`; research/fetch-docs get no
> write/interpreter verbs. **ADR-0009 (the load-bearing correction):** the draft-impl allow-list bounds tool
> *names*, not what an allow-listed interpreter (`node`/`npm run`/a test runner) then writes — and native Windows
> has **no OS sandbox** — so that layer is *defense-in-depth, not a hard guarantee on Windows*. Now **Narrowed by
> default** (no `node`/`npm run`) + opt-in `config.strict_spawn` **hard-close** + worktree **hook-neuter**.
> `max_parallel` is hardcoded 1; the dashboard is `127.0.0.1`-only with CSRF + anti-rebinding + path-traversal
> guards. Review: [`docs/reviews/2026-06-21-full-project-review.md`](../reviews/2026-06-21-full-project-review.md);
> audit: [`docs/strategy/2026-06-23-assumption-audit.md`](../strategy/2026-06-23-assumption-audit.md).

## 2026-06-23 — assumption audit + GTM research + safety hardening (this session)

Two multi-agent research passes + a partial implementation. **806 tests + 7 skips, build ✅.**
- **New docs:** [`docs/strategy/2026-06-23-assumption-audit.md`](../strategy/2026-06-23-assumption-audit.md)
  (red-team of every CLAUDE.md load-bearing assumption → risk-ranked register) and
  [`docs/strategy/2026-06-23-go-to-market-distribution.md`](../strategy/2026-06-23-go-to-market-distribution.md)
  (GTM/distribution plan; **builds on** `docs/launch/`, doesn't replace it).
- **Landed:** [ADR-0009](../decisions/0009-spawned-session-trust-boundary.md) + the spawned-session safety fix
  (Narrow default + `strict_spawn` + hook-neuter); honesty edits (README "Is this allowed?" → dated/conditional,
  "verified tests: pass" → "best-effort", the false "resets Saturday" calendar copy, the Job-Object mislabel;
  the `est_tokens` "×1.3" doc-lie corrected in CLAUDE.md + glean.md; caching-rationale precision); repo/npm
  discoverability hygiene (GitHub topics + description + homepage set live; npm keywords expanded).
- **Still open (from the audit, NOT yet done):**
  1. **401/`authentication_error` detection** on the `glean morning` receipt + adopt `claude setup-token` →
     `CLAUDE_CODE_OAUTH_TOKEN` as the scheduled-auth path (subscription, no API key) → write **ADR-0010**.
  2. **A real enforcement test** against the live `claude` binary (a spawn that attempts an out-of-worktree
     `fs.writeFileSync` and asserts refusal) — the fake-claude stub can't prove the boundary (ADR-0009).
  3. **Enable the OS sandbox on macOS/Linux/WSL2** to restore safe in-session code execution (ADR-0009 deferred).
  4. **`docs/launch/*` staleness patch** (406→806 tests, v0.8.1→v0.10.0, add dashboard/Linux/`glean usage`) +
     the GTM **launch DIFF**; the hero GIF + 1280×640 social-preview PNG **need the user** (recording/asset).
  5. **Pivot pacing onto the server-truthful weekly signal** (`rate_limits.seven_day`, ADR-0007 follow-up) and
     teach `classify.ts` the `seven_day*` weekly shape first-class (cheap ADR-0003 hardening).

## Read first (orient a cold session)
- `CLAUDE.md` — load-bearing constraints + current state + the "Decision records & assumptions" section
  (ADRs in `docs/decisions/`, tagged at the code site as `ASSUMPTION[ADR-NNNN]` / `SEAM[ADR-NNNN]`).
- `docs/strategy/2026-06-22-*.md` — **the pinned direction** (above). Don't relitigate narrow-vs-broad /
  subscription-vs-API / Claude-vs-multi-LLM without reading these; they're grounded in real research.
- `docs/PROJECT-MAP.md` — the index of where everything lives across the three trees.
- `docs/ROADMAP.md` — planned-work source of truth.

## What v0.10.0 delivered (the moat wave)

**Capacity governor — wave-2:**
- **User-input subscription week anchor.** Optional `config.json` `pacing.week_anchor: { day, time }`
  (e.g. Saturday 03:00). Pacing previously hardcoded a Monday calendar week and only learned the real reset
  reactively; the anchor threads into the pacing week boundary + baseline + the drain weekly-reset fallback.
  Absent → byte-identical to before. (`config.ts`, `pacing.ts`, `runDrain.ts`)
- **Morning anti-spill margin.** Opt-in `config.json` `pacing.morning_buffer_hours` (default 0 = off) —
  refuses to *start* a burst within N hours before the user's **typical first-prompt time** (median local
  time-of-day of the first human message per active day, from session history — `src/lib/activity.ts`,
  glean's own sessions excluded; no-ops on < ~5 active days). Drain reason `morning-anti-spill`.
- **Nightly pace-gated drain.** When `pacing.enabled`, the drain consults `recommendTier()` at burst start
  and exits cleanly (`pace-skip`) when ahead of pace — a nightly schedule can fire daily but only spends on
  slack. `glean schedule {enable|disable|status} --nightly` (Windows full; Linux registration is a clear
  "Windows-only for now" message — the gate itself is cross-platform).

**Discovery / looping optimization** (`src/lib/select-next.ts`, `prioritize.ts`, `pipeline.ts`):
- **Idempotent ranking** — `prioritize()` no longer mutates `est_value` (penalty moved into `score()`),
  fixing a footgun that double-penalized on re-rank.
- **Budget-fit in-run re-ranking** — the loop re-ranks the remaining pool each tick and defers tasks too
  large to finish in the remaining budget (no-pressure order is regression-pinned identical).
- **Adaptive type-downweighting** — a type that fails ≥ 2× in a run is soft-downweighted (×0.3, not skipped)
  so the budget tail isn't burned on a type that's clearly failing. Pure/in-memory. No `claude -p` triage
  probe (heuristic-only ranking, per CLAUDE.md).

**Spawn-backend seam** ([ADR-0008](../decisions/0008-spawn-backend-seam.md)) — a type-checked
`SpawnBackend` interface + `subscriptionBackend` conformance in `spawn-claude.ts` marking where an opt-in
API backend would slot in. Designed, not built.

**Hygiene** — `npm audit fix` cleared js-yaml; the remaining 10 are dev-only deps (see next items).

## Highest-value next items

1. **⚠️ WATCH WEEKLY: Anthropic un-pausing metered `claude -p` billing.** Anthropic *paused* (did not
   cancel) a 2026-06-15 change to move headless/Agent-SDK usage onto separate metered credits. If it
   un-pauses, Glean's free-idle-capacity thesis is directly undercut — and that is the trigger to **build**
   the API-key backend hedge (the seam is ready, ADR-0008). This is the single biggest exogenous risk.
2. **Close ADR-0001 — the weekly-block capture (still open).** The **weekly** hard-block shape has never
   been observed (every captured `rate_limit_event` is a warning or a *session* block, ADR-0003). The
   BLOCK-CAPTURE tripwire auto-dumps it the first time a real weekly cap is hit. **Needs user action** (a
   live multi-hour drain that trips the weekly cap). When captured: fixture it, teach `classify.ts` the
   weekly shape, supersede the ADR.
3. **Dev-tooling vuln bumps (own PR).** The 10 remaining `npm audit` advisories are all **dev-only** deps
   (esbuild←vite←vitest, minimatch←@typescript-eslint) that never ship in the published package
   (`files: bin/dist/templates`). Their fixes need **major** dev-tooling bumps — **vitest 1→4** and
   **@typescript-eslint 6→8** — which are breaking and deserve a focused PR with a full re-gate (the vitest
   bump especially: the pool-cap config in `vitest.config.ts` may need migration).
4. **`feat/discover-docs-dirs`** (still-open WIP branch) — discover-docs directory expansion / configurable
   doc globs (the Terra Firma follow-up where planning content lives in non-conventional subdirs).
5. **Skill-reuse-in-spawned-sessions spike** — the one optimization lever from the strategy review *not*
   taken this wave: inject Claude Code skill-invocation patterns into the spawned-session templates to lift
   output quality. High upside, needs real-spawn validation before committing.

## Housekeeping
- **`feat/nightly-mode` is SUPERSEDED** — the v0.10.0 nightly pace-gate (`feat/wave2-capacity-governor`,
  merged) implements this. Verify nothing unique remains on the old WIP branch, then prune it + its locked
  worktree under `.claude/worktrees/`.
- The lone `v27-serve-install` "foreground-singleton" integration test flakes under heavy *ambient* machine
  load (this box runs ~28 MCP node processes); it passes 4/4 in isolation. Not a regression. The vitest pool
  is capped (`maxForks: 4`) to mitigate; don't remove that cap.

## Load-bearing constraints (from CLAUDE.md — non-negotiable, unchanged)
Subscription-auth only (no API key in the core path — the ADR-0008 seam is *unbuilt*); read-only against the
user's `main` checkout (drafts to `prep/glean-*` worktrees, never push/merge); deny-list on **every**
`claude -p` spawn; default `max_parallel=1`; Windows-first; atomic `state/budget.json`; **bare `glean run`
stays byte-identical** (additive + gated). Discipline: **a finding that overturns a prior decision is a
hypothesis to disprove** — verify the negative case before asserting.

## How this session built v0.9.0 + v0.10.0 (the working pattern)
v0.9.0 = a 7-dimension multi-agent review (`docs/reviews/2026-06-21-…`) → phased TDD fixes. v0.10.0 = a
verified competitive-research workflow + a codebase coupling audit → a strategy memo → AskUserQuestion
decisions → three sequential TDD subagent workstreams (capacity-governor / looping / API-seam), each
independently re-gated against the full suite → merge → bump → publish → tag. Both followed superpowers
`verification-before-completion` (evidence before assertions) and the gstack planning skills.
