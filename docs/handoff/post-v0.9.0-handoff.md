# Post-v0.9.0 handoff — what's next after the capacity governor + review hardening

> Self-contained handoff so a **fresh session** can pick up cold. Everything needed is here or linked.
> This is the **only live handoff** (convention: exactly one live handoff in `docs/handoff/`; superseded
> ones move to `docs/archive/` — the previous one is at [`docs/archive/post-v0.8.2-handoff.md`](../archive/post-v0.8.2-handoff.md)).

**As of:** 2026-06-22. **v0.9.0 is prepped on branch `chore/full-review-improvements`** (off `main`),
**not yet published** — npm is still publicly at `@jonny-boy9000/glean@0.8.5`; the user publishes 0.9.0
as a separate step. The branch carries two buckets of work, all merged into it: **v0.9 capacity-governor
wave-1** (built earlier and previously parked under CHANGELOG "Unreleased") and the **2026-06-22
full-project-review hardening** (this session's commits `f8fa382`, `fe39b77`, `197d440`, `c74e00f`,
`959388a`). **739 tests + 7 skips.** Build ✅, eslint ✅.

> **🟢 SAFETY POSTURE (from the full review).** The thing that matters most for a tool that spawns
> autonomous `claude -p` sessions — its safety enforcement — was independently verified and holds:
> no Anthropic API-key path exists anywhere in `src/`; **every** spawn funnels through one
> `runClaude()` that unconditionally appends the deny-list (now also asserted at the **argv** level, not
> just as a constant); draft-impl pairs deny-list + scoped allow-list + `--add-dir` worktree confinement;
> `max_parallel` is hardcoded 1; the localhost dashboard is `127.0.0.1`-only with CSRF + anti-rebinding +
> path-traversal guards. **No Critical and no surviving High findings.** Full review:
> [`docs/reviews/2026-06-21-full-project-review.md`](../reviews/2026-06-21-full-project-review.md).

## Read first (orient a cold session)
- `CLAUDE.md` — load-bearing constraints (do not violate) + current state. Read the
  **"Decision records & assumptions"** section: load-bearing/unverified decisions live in
  `docs/decisions/` as ADRs and are tagged at the code site (`ASSUMPTION[ADR-NNNN]`).
- `docs/PROJECT-MAP.md` — **the index of where everything lives**, across all three trees (the repo,
  the machine-local gstack design store, the `~/glean` runtime). Keep it current on any layout change.
- `docs/ROADMAP.md` — planned-work source of truth ("In progress" / "Up next" / "Tracked backlog").
- `docs/reviews/2026-06-21-full-project-review.md` — the 7-dimension review that drove the hardening
  bucket; the residual low/nice-to-have items live in its §3.

## What v0.9.0 delivered

**Capacity-governor wave-1** (the v0.9 milestone):
- **`glean usage` + the pacing engine.** Self-relative weekly pacing read straight from
  `~/.claude/projects/**/*.jsonl` (`src/lib/usage.ts`, an internal loader — [ADR-0007](../decisions/0007-internal-usage-loader.md);
  glean deliberately does *not* depend on `ccusage`). `src/lib/pacing.ts` is the pure engine
  (per-family weights in [ADR-0005](../decisions/0005-model-weight-multipliers.md), 4-week per-weekday
  median baseline, pace ratio, tiers skip/small/normal/large). `recommendTier()` is the **wave-2 API**
  the nightly preset will consume.
- **Per-spawn model routing** ([ADR-0006](../decisions/0006-model-routing-pool-assumption.md)) +
  `--max-turns` guards — every `claude -p` spawn now carries an explicit `--model` (pool-aware Sonnet
  default) and a per-type turn cap.
- **`discover-docs`** — a 4th parallel discovery pass mining the project's own ROADMAP/TODO/handoff
  "up next" items + unchecked `- [ ]` tasks.
- **Project portfolio** (`glean projects`) + the always-on dashboard (`glean serve install|uninstall|status`).

**2026-06-22 review hardening:**
- **Fixed:** `glean gc` leaked `prep/glean-*` branches forever (UUID-with-hyphens mis-parse) — now
  resolves the real branch from `git worktree list --porcelain`.
- **Fixed:** cross-day dedup suppressed FAILED/timeout candidates for 7 days — now only successful
  outcomes suppress re-attempts.
- **Fixed:** a latent IPv6-loopback (`[::1]`) hole in the dashboard's DNS-rebinding host check.
- **Security:** PowerShell scheduled-task registration hardened against `day`/`time`/path injection.
- **Robustness:** `better-sqlite3` lazy-loaded — a missing native binding no longer kills
  `glean version`/`doctor`/etc.; telemetry degrades to a one-line warning.
- **Added:** `glean doctor` preflight (Node ≥ 20, `claude` on PATH, git, gh optional, config,
  better-sqlite3) — exits non-zero if a hard requirement fails.
- **Internal:** dropped the `uuid` dependency (Node's `crypto.randomUUID`); split the 1070-line
  `executor.ts` into `executor.ts`+`spawn-claude.ts`+`draft-git.ts`+`draft-test.ts` (behavior-preserving);
  single-sourced `RATE_LIMIT_RE`; one `homeDir()` helper (fixed reversed HOME/USERPROFILE precedence);
  zod-validated `budget.json`; `tsconfig` `NodeNext`; capped the vitest fork pool; added argv-level
  deny-list regression tests + dashboard rebinding tests.

## Highest-value next items

1. **Publish 0.9.0** (needs the user — npm login). `package.json` is already bumped to `0.9.0`; the
   CHANGELOG has the dated `v0.9.0` section. Tag and `npm publish` after a final `npm test`/`npm run build`.
2. **Capacity-governor wave 2** — two features are already started on **unmerged WIP branches in locked
   worktrees** (don't mistake them for stale noise): `feat/nightly-mode` (the nightly pace-gated schedule
   preset — a second scheduled task gated by `glean usage --json` via `recommendTier()`) and
   `feat/discover-docs-dirs` (discover-docs directory expansion / configurable doc globs — the Terra Firma
   follow-up where planning content lives in non-conventional subdirs). Wave 2 also wants the **morning
   anti-spill margin** (end a drain N hours before the typical first prompt) and utilization-aware
   admission control.
3. **Close ADR-0001 — the weekly-block capture (still open).** Every `rate_limit_event` glean has captured
   is a *warning* or a *session* block (ADR-0003); the **weekly** hard-block shape has never been observed.
   The v0.8.2 BLOCK-CAPTURE tripwire auto-dumps it to `~/glean/logs/<run>/<task>.BLOCK-CAPTURE.txt` the
   first time a real weekly cap is hit. Needs a live multi-hour drain that actually trips the weekly cap
   (user action). When captured: fixture it, teach `classify.ts` the verified weekly shape, supersede the
   relevant ADR.
4. **Triage the 11 pre-existing `npm audit` vulnerabilities** — they predate this work (transitive dev
   deps); worth a pass to see which are reachable vs. dev-only noise before publishing.

## Load-bearing constraints (from CLAUDE.md — non-negotiable, unchanged)
Subscription-auth only (no API key in the core path); read-only against the user's `main` checkout
(drafts to `prep/glean-*` worktrees, never push/merge); deny-list on **every** `claude -p` spawn;
default `max_parallel=1`; Windows-first; atomic `state/budget.json`; **the bare `glean run` path stays
byte-identical** (additive + gated on drain state). And the discipline: **a finding that overturns a
prior decision is a hypothesis to disprove, not a conclusion** — verify the negative case before asserting.

## How v0.9.0 was built (the working pattern, for reference)
The wave-1 features each shipped from their own `feat/*` branch (usage-pacing, model-routing,
discover-docs, project-portfolio, serve-autostart) via the gstack office-hours → plan-eng-review →
Superpowers worktree-isolated TDD lanes pipeline. The 2026-06-22 hardening was a 7-dimension multi-agent
review (`docs/reviews/2026-06-21-full-project-review.md`) → phased fixes on `chore/full-review-improvements`
(Phase 1 correctness/safety, Phase 2 DRY/lazy-sqlite/doctor/executor-split, Phase 3 these docs).
