# Glean — Hardening Roadmap (development plan to close the 2026-06-23 assumption audit)

> The development plan that solves every issue in the [2026-06-23 assumption audit](./2026-06-23-assumption-audit.md).
> Produced by a 29-agent remediation workflow: 12 issue clusters → per-cluster remediation strategy → sequencing/
> realism critique → synthesis → a **completeness critic** (which ran the suite live, caught a stale baseline, an
> ADR-ID collision hazard, and past-tense overclaims) → a finalize pass. The companion **recommended improved
> CLAUDE.md** is at [`/CLAUDE.recommended.md`](../../CLAUDE.recommended.md) (strictly additive; review and
> `mv` to adopt). External facts re-verified live 2026-06-23.

## Executive summary

The audit confirmed the **business model is sound** (weekly window real, no rollover, headless `claude -p` still
subscription-pooled, metered billing paused — re-verified live 2026-06-23) and the cracks are in the
**safety/honesty kernel**. **PR #31 landed the BROKEN-class *framing* fixes** — ADR-0009 (Narrow spawn default +
`strict_spawn` + worktree hook-neuter), ADR-0010 (auth-failure detection → exit 50), and the honesty/hygiene
edits — but on native Windows the #1 BROKEN finding (the spawned-session filesystem boundary is not a *hard*
guarantee) remains **mitigated, not resolved** (the OS sandbox is mac/Linux/WSL2-only). This plan closes the
**remaining** items — the deferred legs of #31 plus the WEAKENED/HOLDS findings #31 deliberately did not touch.

Three things the completeness critic corrected, now baked in:
1. **Baseline (verified live):** the tree is **814 passed + 7 skipped (821)**, not 801. Every "801 + new"
   verification cell becomes "814 + new"; a Phase-0 step fixes the stale `801`/`806` doc sites.
2. **Duplicate-ADR-ID hazard:** every cluster proposed a literal `ADR-0011`; resolved with a **placeholder-token
   convention** (`ADR-{TOS}`, `ADR-{SANDBOX}`, …) + a pre-merge grep gate, so collision is structurally impossible.
3. **Windows honesty:** the done-definition states **loudly** that on native Windows the #1 finding stays
   mitigated (Narrow/`strict_spawn`) but is **never** resolved to HARD; the three hardware-gated proofs (sandbox
   enforcement, Spike-A auth, a real `seven_day*` capture) are a **tracked-pending** set, never silently "closed."

All changes stay **additive and gated**: the bare `glean run` argv is byte-identical on clean input;
subscription-auth/no-API-key holds; `max_parallel=1` becomes a *safety* invariant.

## Phases (sequenced; P0 docs/anti-drift → safety kernel → governor depth → operational)

### Phase 0 — Pure-docs / anti-drift (no code; land immediately, parallelizable)
0. **`docs-reconcile` (NEW, land FIRST)** — fix the four stale `801` sites (CLAUDE.md L7, handoff L9, PROJECT-MAP
   L7, ROADMAP L6) + the handoff's `806` → `~814` (live-verified). This cluster **owns the handoff**: add an
   "assumption-audit remediation in flight" status block listing the clusters + their ADR tokens, bumped by every
   later PR, so a cold pick-up sees the audit work and it never rots.
1. **`tos-basis`** — ADD a ToS-basis ADR (`{TOS}`): verbatim Consumer-Terms §3 (re-verified, eff. 2025-10-08),
   the not-OpenClaw analysis, the UNVERIFIED unattended-vs-interactive edge, the resolved VentureBeat "catch" (=
   paused Agent-SDK metered split → handed to ADR-0008). Tag `runDrain.ts` + `schedule.ts` `ASSUMPTION[ADR-{TOS}]
   UNVERIFIED`. Ship `docs/watchlist/tos-automation-drift.md` in the same change.
2. **`model-pool-note`** — ANNOTATE ADR-0006 (do NOT supersede, do NOT invert to Opus-only): affirm the
   Sonnet-only pool, flag the drain-both bug (#57875 + duplicate #57050, closed not-planned), name paused-metered
   as the dominant frame threat. Add a **distinct** `// ASSUMPTION[ADR-0006] drain-both …` code-site marker at
   `model-routing.ts:5-12` (the existing tag covers only the Pro-pool-split). Update CLAUDE.md L11 only.
3. **`thesis-honesty`** — ADD a conditional-thesis ADR (`{THESIS}`); reframe the README hero/FAQ + CLAUDE.md to
   "conditional free capacity" (point users at `glean usage`); append the opt-in extra-usage overage to
   `BLIND_SPOT_NOTE`. Engine untouched.

> **ADR-ID allocation = a mechanism, not a note.** Every cluster writes a UNIQUE symbolic token (`ADR-{TOS}`,
> `ADR-{SANDBOX}`, `ADR-{PRIVACY}`, `ADR-{TESTHONESTY}`, `ADR-{WEEKLYFUSION}`, `ADR-{VALIDITY}`, `ADR-{PARALLEL}`,
> `ADR-{WATCH}`, `ADR-{THESIS}`) in **all** artifacts (code tags, `0011-{token}.md` filenames, CLAUDE.md
> cross-refs, fixtures). At merge the orchestrator allocates the next free integer (the log stops at **0010**, so
> the first lander = 0011), find-replaces that one token across the PR, and renames the file. A **pre-merge grep
> gate rejects any literal `ADR-0011` (or any unallocated integer)** in a diff.

### Phase 1 — Safety-kernel completion (the deferred #31 legs; highest stakes)
4. **`sandbox-enforce`** (split into two PRs). **1a SHIPPED (PR #34, ADR-0013).** **1a (security)** — `sandbox.ts` availability detection +
   `buildSandboxSettings` (inline `--settings` JSON — web-confirmed it overrides per-session with **zero** global
   mutation), `sandbox.failIfUnavailable: true` (the hard-vs-fallback hinge) + `allowUnsandboxedCommands: false`,
   honest receipt warning when `enforce_spawn` is requested but unavailable, the argv regression lock, and the
   **REAL enforcement test** (`it.skipIf` no real claude / unsupported platform) — self-skipped on Windows.
   **1b (capability, gated follow-up)** — restore `node`/`npm run` test verbs *only* on the active-sandbox path,
   after enforcement is proven on a Mac/WSL2 runner. Supersede ADR-0009 → `{SANDBOX}`. **The ADR + the receipt
   state in those words: on native Windows this finding is mitigated but NEVER resolved to a HARD boundary.**
   *(The sandbox special-cases linked worktrees — auto-allows the shared `.git` for refs/index but keeps
   `hooks/`+`config` denied — which exactly complements our existing hook-neuter.)*
5. **`auth-token-path`** — **SHIPPED (PR #36; the live Spike-A re-validation stays tracked-pending).** Build the buildable parts first: `auth-token.ts` (`loadOAuthToken` +
   `applyScheduledAuthEnv` stripping `ANTHROPIC_API_KEY`+`ANTHROPIC_AUTH_TOKEN`+the cloud flags),
   `glean auth setup-token|status|clear` (0600, rejects `sk-`), the drain-only gate, the `--bare`-never INVARIANT
   test, the doctor line. **Then** the empirical Spike-A re-validation (token-less CONTROL drain → token-backed
   TREATMENT drain). **Promote ADR-0010 only after the live capture**; if no live window, the code ships and
   ADR-0010 stays "BUILT; Spike-A re-validation PENDING" on the **tracked-pending** list, not closed.

### Phase 2 — Honesty + capacity-governor depth (parallelizable)
6. **`test-honesty`** — ADR (`{TESTHONESTY}`) first; widen `DraftTestStatus` to a discriminated set;
   preamble-anchor the env-signature scan; **link `node_modules` post-spawn-death right before `runTestCommand`
   (`executor.ts` ~:318), NOT at worktree-add** (linking at :236 would expose base deps to the live spawn and
   re-open the ADR-0009 hole); register the link in `excludeFromWorktree` so it is never committed.
7. **`privacy-scope`** — `redact.ts` (anchored high-precision patterns + a no-op-on-clean golden test) into
   `discover-jsonl` title/`userMessageText` + `hydrateEvidence` excerpts; an `assertReadScopeConfined` chokepoint
   (confine `--add-dir` to the candidate's own `project_path`); ADR (`{PRIVACY}`) + `docs/PRIVACY.md`.
8. **`usage-weekly-signal`** — reframed (a literal pivot is impossible headless — the rich `rate_limits.seven_day`
   is statusLine-TUI-only, both web-confirmed): make `seven_day*` first-class in `classify.ts`/`dashboard-data.ts`;
   fuse an **opportunistic** observed weekly ceiling into `recommendTier` (`effective = max(jsonl, ceiling)`,
   caution-only, monotone-safe); reframe `BLIND_SPOT_NOTE`; supersede ADR-0007 → `{WEEKLYFUSION}`. The
   real-`seven_day*`-capture proof stays tracked-pending.
9. **`weekly-block-shape` (P2)** — read `rateLimitType` `seven_day*` as the first-class weekly classifier; demote
   the 6h cut to the type-absent/`five_hour` fallback; ANNOTATE ADR-0003 (keep OPEN, tripwire armed). Land before #8.

### Phase 3 — Operational surfacing + latent-landmine guards
10. **`watch-tripwires`** — `watch.ts` frozen register + pure `evaluateWatch(now)`; a `glean doctor` "Risk watch"
    group (**exit code unchanged**) + a dashboard panel; opt-in `--check-watch` network probe (never in any
    automated path; grep-proof `watch` is absent from run/drain/pipeline/executor/spawn-claude). New ADR (`{WATCH}`).
11. **`parallel-safety`** — **leg A first** (correct the docs + CLAUDE.md: `--parallel` is NOT exposed and
    same-project `draft-impl` is unsafe). **Leg B** (an inert `withProjectWorktreeLock` + ADR `{PARALLEL}` + a
    serialization test) is the documented gate any future `--parallel` must pass — lower-value (the loop is serial
    today), may be a tracked follow-up.
12. **`ranking-validity`** — the validity guard becomes a **title-quality DOWN-RANK, not a binary drop**; the
    TODO-committed-away + closed-PR legs ship as documented NO-OP guard-hooks (discovery re-greps the live tree
    every run, so nothing stale survives to validate today); the opt-in `--triage` pass is a single batched spawn
    and **a no-op on `tier === 'skip'`** (inside the pace gate). Annotate (don't contradict) `pacing.ts:12`. New
    ADR (`{VALIDITY}`).

> **Coverage ledger:** audit register row #10 has two halves — `--parallel 2` same-project race (cluster
> `parallel-safety`) AND the stale caching wording. **The caching half was already remediated in PR #31**
> (CLAUDE.md L46); recorded here so the "is every audit row addressed?" cross-check is complete.

## ADR actions

**SUPERSEDE (never edit in place):** ADR-0009 → `{SANDBOX}` (enforce_spawn / OS sandbox; records the verified
`sandbox.*` schema + worktree `.git` special-case + the per-invocation inline `--settings` + `failIfUnavailable`
hinge + the platform gate + the live enforcement test; **states Windows-never-HARD**). ADR-0007 → `{WEEKLYFUSION}`
(sparse-ceiling weekly fusion, NOT a primary pivot; reverse trigger = Anthropic ships full `rate_limits` in the
`-p` stream).

**PROMOTE:** ADR-0010 → "scheduled-auth BUILT + Spike-A re-validated `<date>`" **only after** the live capture
(else "BUILT; re-validation PENDING").

**ANNOTATE (nothing overturned):** ADR-0006 (affirm Sonnet pool; flag drain-both #57875/#57050; **bold DO NOT
INVERT to Opus-only**; add the distinct drain-both code marker). ADR-0003 (`seven_day*` first-class; weekly BLOCK
shape still UNVERIFIED; keep OPEN).

**ADD:** ToS-basis `{TOS}` · test-status-honesty `{TESTHONESTY}` · privacy/data-minimization `{PRIVACY}` ·
conditional-thesis `{THESIS}` · watchlist-as-surface `{WATCH}` · parallel-safety `{PARALLEL}` (leg B) ·
validity-guard + opt-in-triage `{VALIDITY}`. **Index hygiene:** `docs/decisions/README.md` gets a row for each
newly-allocated integer in the SAME PR that creates the file.

## Watchlist (operationalize as shipped data: `docs/watchlist/` → `src/lib/watch.ts`)

Each item: canonical URL, cadence, maintainer-bumped `last_checked` (a stale date IS the overdue signal), a
verbatim BROKEN-trigger, a severity flag. Surfaced via `glean doctor` (WARN when overdue, exit code unchanged) +
a dashboard panel; **offline by default**, network only via opt-in `glean doctor --check-watch`.

- **(WEEKLY — EXISTENTIAL) Metered `claude -p` un-pause** — `support.claude.com/en/articles/15036540`. BROKEN
  when it stops saying *"still draw from your subscription's usage limits"* OR a changelog gives an effective
  date. **The ADR-0008 API-hedge build trigger.** Verified SAFE (paused) 2026-06-23.
- **(WEEKLY — safety) claude-code sandbox/permission semantics** — `code.claude.com/docs/sandboxing` +
  `/permissions`. BROKEN on an out-of-box Windows sandbox (lets Windows flip to HARD — the `{SANDBOX}` supersede
  trigger), `--allowedTools` semantic change, or `sandbox.*` key renames (schema drift silently no-ops
  `buildSandboxSettings` — the exact-JSON test + `failIfUnavailable` are the mitigations).
- **(WEEKLY) ToS / Usage-Policy automation drift** — `anthropic.com/legal/consumer-terms` §3. BROKEN on any new
  "interactive use only" / "no unattended automated subscription use" clause, or §3 narrowing "explicitly permit it."
- **(WEEKLY) claude-code auth/credential changes** — a print-mode OAuth-refresh fix (relaxes the 401 risk) or a
  `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` precedence change.
- **(MONTHLY) `rate_limit_event` schema drift** — bucket names `seven_day`/`seven_day_opus`/`seven_day_sonnet`.
- **(MONTHLY) Model-pool mechanics** — the Sonnet drain-both fix, Opus/Sonnet equalization, or a shipping headless
  `usage` subcommand (Spike-0 flip → pivot `{WEEKLYFUSION}` to primary).
- **(MONTHLY) Weekly rollover/banking + extra-usage default** — any carry-over kills the "expires" premise. Today:
  no rollover; extra usage off by default.

## Definition of done (when is the audit "closed"?)

The audit is closed when every register row + watchlist + stale-recheck item is either (a) remediated in code
with an ADR + a code-site tag, (b) a dated UNVERIFIED assumption with an armed capture tripwire **on the
tracked-pending list**, or (c) a tracked watch tripwire — and the code↔ADR anti-drift link is live for each.

1. **No load-bearing assumption is stated as an unconditional fact** without an ADR / `ASSUMPTION[ADR-NNNN]` tag.
2. **The bare `glean run` argv is byte-identical** on clean input (per-commit golden snapshot). `--settings`,
   OAuth-token injection, redaction, the validity guard, and triage are all no-ops when their gate is absent.
3. **Load-bearing constraints intact:** no API key in the core path; read-only-against-main is *strengthened*
   (sandbox + read-scope confinement) **where the sandbox runs**; deny-list + scoped allow-list on every spawn
   (triage included); `max_parallel=1` is a documented *safety* invariant.
4. **Baseline stated as the CURRENT live-verified count** everywhere (CLAUDE.md, handoff, PROJECT-MAP, ROADMAP,
   every cluster's verification cell) — re-verify with `npx vitest run` and bump on each change. **850 passed +
   8 skipped** as of the setup-token auth path (PR #36); was 836+8 at sandbox-enforce 1a, 801 at the v0.10.0 release. A "green"
   claim cites the current number, never a stale literal.
5. **PROJECT-MAP, ROADMAP, the decisions index, AND the handoff** are updated in the same change that adds/moves
   files; the handoff carries the per-cluster remediation status block.
6. **The audit is split into CLOSED and TRACKED-PENDING, stated loudly.** TRACKED-PENDING (never claimed closed):
   (i) the live sandbox-enforcement proof, (ii) the live Spike-A auth re-validation, (iii) a captured REAL
   `seven_day*` event. Each either **passes on a Mac/WSL2/real-`claude` runner** (then the ADR flips
   UNVERIFIED→ENFORCED/BUILT, archived, → CLOSED) or **ships visibly self-skipped**. **On native Windows the #1
   BROKEN finding is mitigated by Narrow/`strict_spawn` but NEVER resolved to HARD — the ADR and the CLAUDE.md
   constraint say so in those words.** A green CI that *skipped* these is never claimed as one that *proved* them.
7. **`npm test` green (the current baseline + new — 850 + 8 as of PR #36), `tsc` + `lint` clean,** no skip-count
   regression except the intentional new live-test skips (kept visible and explained — e.g. `v30`).

## Top actions (prioritized)

| # | Action | Target | Pri | Effort |
|---|---|---|---|---|
| 1 | Reconcile the test baseline 801→814 + give the handoff an "audit remediation in flight" status block | CLAUDE.md, handoff, PROJECT-MAP, ROADMAP | P1 | S |
| 2 | Adopt the per-cluster ADR placeholder-token convention + a pre-merge grep gate (collision-proof) | decisions/README + CI gate + every cluster | P1 | S |
| 3 | OS-sandbox security PR (1a): `sandbox.ts` + inline `--settings` (`failIfUnavailable`) + the real enforcement test; supersede ADR-0009 → `{SANDBOX}`; state Windows-never-HARD | `sandbox.ts` (new), `spawn-claude.ts`, `config.ts`, sandbox test, ADR-0009 | P1 | L |
| 4 | `setup-token` scheduled-auth + the `--bare`-never INVARIANT; live CONTROL+TREATMENT drains; promote ADR-0010 only after capture | `auth-token.ts` (new), `cli.ts`, `doctor.ts`, ADR-0010 | P1 | M |
| 5 | Make draft test-status honest: widen `DraftTestStatus`, preamble-anchor the env scan, link base `node_modules` post-spawn-death | `executor.ts`, `draft-test.ts`, `types.ts`, new ADR | P1 | M |
| 6 | Privacy layer: `redact.ts` into discover/excerpt + the `assertReadScopeConfined` chokepoint; ADR + `PRIVACY.md` | `redact.ts` (new), `discover-jsonl.ts`, `executor.ts`, `docs/PRIVACY.md` | P1 | M |
| 7 | Fuse the opportunistic weekly ceiling + make `seven_day*` first-class; supersede ADR-0007 → `{WEEKLYFUSION}` (land the P2 weekly-block hardening first) | `classify.ts`, `pacing.ts`, `dashboard-data.ts`, ADR-0007 | P1 | M |
| 8 | Watchlist as a feature: `watch.ts` + doctor Risk-watch group + dashboard panel + opt-in `--check-watch`; new ADR; grep-proof it's off the hot path | `watch.ts` (new), `doctor.ts`, `dashboard-data.ts`, dashboard template | P1 | M |
| 9 | Annotate ADR-0006 (DO NOT invert to Opus-only) + add a distinct drain-both code-site marker | ADR-0006, `model-routing.ts`, CLAUDE.md | P2 | S |
| 10 | Ranking validity guard (down-rank, not drop) + opt-in `--triage` (no-op on `tier==='skip'`); new ADR | `validity.ts` (new), `pipeline.ts`, `triage.ts` (new), new ADR | P1 | M |
