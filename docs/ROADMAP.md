# Glean Roadmap

> Single source of truth for planned work. Each entry links to the spec, dogfood doc, or critique that originated it. Update on every release and whenever an item is added, deferred, or completed.

**Last updated:** 2026-05-26 (post-v0.3.0; dossier-existence sweep shipped)
**Current release:** [v0.3.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.3.0) (commit `21225d6`)
**Branch state:** `main` clean, no in-progress patch

---

## In progress

*(nothing currently)*

---

## Up next (recommended priority order)

> **Strategic lens (2026-05-26):** The most load-bearing critique of the project is that the engine has no measure of dossier usefulness — you don't know if you'd open what it produces. The passive half of that gap shipped in v0.3.0 (dossier-existence sweep). Items 1–2 close the active half (explicit ratings + surfacing telemetry back via `glean today`). Item 3 is the highest-leverage forward-momentum item that benefits from telemetry already being in place. Item 4 is engine durability. Distribution / adoption items (POSIX port, npm publish, GitHub issues, demo media) consciously deferred until telemetry validates that the core is worth distributing.

### 1. `glean rate` — active usefulness telemetry

**Status:** new (added 2026-05-26, post-analysis).
**Source:** Strategic analysis 2026-05-26 — the deliberate half of the feedback loop.
**Why:** Passive existence is a noisy signal (might keep a dossier you never opened). An explicit `glean rate <run-id|fingerprint> <kept|discarded|actioned>` takes 5 seconds per dossier you bother to rate and gives ground truth for the eventual ranker.
**Scope sketch:** ~100 LOC. Schema migration v3 adds `user_rating` column. New CLI subcommand. `glean today` annotates previously-rated dossiers so you don't re-rate what you already judged.

### 2. `glean today` enriched with memory.db

**Status:** new (added 2026-05-26, post-analysis).
**Source:** Strategic analysis 2026-05-26 — surfaces telemetry data in the human-facing view.
**Why:** Items 1 + 2 accumulate data; without surfacing it back to you, the loop never closes. `glean today` is the natural place — it already runs daily. JOIN against memory.db so each entry shows duration, rate-limit hits, bytes written, user rating, and the 7-day existence flag. Suspicious-looking dossiers (tiny bytes, repeated discards) get flagged.
**Scope sketch:** ~50 LOC delta in `today.ts` + `render-today.ts`. Read-only memory.db consumer.

### 3. `glean peek` + SessionStart hook integration

**Status:** new (added 2026-05-26, post-analysis). Previously listed under "Deferred sub-projects."
**Source:** Strategic analysis 2026-05-26 — the highest-leverage missing piece for actually USING dossiers.
**Why:** The compound-memory-across-sessions usage (dossiers as artifacts of prior thinking that next Claude session can `cat`) requires that the dossier actually lands in the next session's context. `glean peek` is a CWD-scoped variant of `glean today` that auto-detects the current repo, prints the relevant INDEX, exits silently when there's nothing. A one-line Claude Code SessionStart hook config calls `glean peek` and the dossier is loaded into every new session automatically. **Deliberately third, not first:** without telemetry first, you'd auto-print dossiers you don't even know are useful.
**Scope sketch:** ~50 LOC. Pure addition: new subcommand reusing the existing `today.ts` + `render-today.ts` modules.

### 4. API-key fallback when Pro/Max rate-limits

**Status:** promoted from "Smaller v0.2-shaped features" to Up next 2026-05-26.
**Source:** [`docs/superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md`](./superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md) §8.
**Why:** Engine durability. When `claude -p` returns rate-limit stderr, fall back to `ANTHROPIC_API_KEY` (if env var is set) for the rest of the budget. Doesn't change the subscription-arbitrage premise; just stops a single rate-limit signal from killing an overnight run. Doesn't help answer the existential question, but is the most defensible "make existing runs more useful" item once telemetry is in place.
**Scope sketch:** ~75 LOC. Pure executor addition; deny-list and safety story unchanged.

---

## Tracked backlog

### Deferred sub-projects (each needs its own brainstorm → spec → plan cycle)

These are the "real features" deferred from MVP. Each is substantial enough to deserve its own design. Originally documented in [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §14.

- **`draft-impl` worktree drafting** — Claude writes speculative code into `git worktree`-based `prep/*` branches. The `base_branch` field already in `config.json` for forward-compat. Biggest single feature by code volume (~1000–1500 LOC). Design sketch in `glean.md` §5.3.
- **Scheduling** — Windows Task Scheduler / launchd / cron integration so glean runs automatically Thursday evening. Design sketch in `glean.md` §5.5. ~400–600 LOC.
- **`glean discard` / `glean gc` subcommands** — discard a run by ID, garbage-collect dossiers older than 21 days. ~200 LOC. (`glean peek` and the SessionStart hook were split out and promoted to Up next #4 on 2026-05-26.)
- **Resume after crash** — currently a crash abandons the run; stale-lock recovery only lets you start a fresh one. Resume would pick up where the loop left off using `candidates.json` partial state. ~200 LOC.
- **Rate-limit back-off ladder + circuit breaker** — currently glean stops on first rate-limit signal. The original MVP design has a 60/300/900/1800s back-off ladder and a 3-hits-in-30-min circuit. Worth it for longer unattended runs.
- **Multi-project per run** — accept `--project` more than once, interleave candidates across projects, shared budget.
- **Parallelism** — currently `max_parallel=1` is hard-coded. Subscription sessions share a rate-limit bucket so parallelism mostly accelerates exhaustion, but `--parallel 2` is worth exposing as an opt-in.

### Hygiene / small fixes

Single self-contained tasks. Bundle into the next release or a doc-only patch.

- **`.gitattributes` for CRLF** — every commit on Windows emits LF→CRLF warnings. `* text=auto eol=lf` silences them. 5 min.
- **Stale SHA references in [`docs/open-work/03-dogfood-results.md`](./open-work/03-dogfood-results.md)** — names commits `e2a8857` / `2b4bfed` / `b63e7e0` which no longer exist after the GitHub history rewrite. Either update to rewritten SHAs (`b2ad1e7` / `33a047a` / `b655752`) or strip the SHAs entirely. 10 min.
- **(Optional) Rename `docs/superpowers/` → `docs/specs/`** — the `superpowers` naming is internal jargon from how the project was built; for outsiders, `docs/specs/` and `docs/plans/` would be more legible. Coordinated rename across ~6 internal references. Critique #12 from the launch review.
- **Verify GitHub Discussions is enabled** — README's CTA points at `https://github.com/Jonny-boy9000/glean/discussions` but Discussions is opt-in per-repo. Either toggle it on via Settings → Features, or change the CTA to issues-only. 2 min.

### Distribution prep (deferred until telemetry validates the core)

These items unblock outside adoption but provide no signal about whether the engine is worth adopting. Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + Up next #1–2). Revisit once telemetry shows dossiers are being kept/actioned more often than discarded.

- **POSIX port (macOS / Linux support)** — was Up next #1 until 2026-05-26. Implementation outline in [GitHub issue #1](https://github.com/Jonny-boy9000/glean/issues/1). ~200–400 LOC, mostly path-separator cleanup; hard part is `jobobject.ts` POSIX child-tree-kill via `detached: true` + `process.kill(-pid)`. Source: [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §2.
- **File this roadmap's tracked items as GitHub Issues** — was Up next #2 until 2026-05-26. ~1 hour. One issue per substantive Tracked item (~12 issues). Use `mcp__plugin_github_github__issue_write` or `gh issue create`. Adoption-shaped, not dogfood-shaped.

### Smaller v0.2-shaped features (promoted 2026-05-25 from "Deferred indefinitely")

A second-pass review of the third-party critique surfaced cheap-first-step versions of three items the original review dismissed wholesale. Each is roughly v0.2-scale: small, defensible, doesn't require any of the bigger product bets (web app, billing layer, OS hooks). Each needs its own brainstorm → spec → plan when prioritized.

- **Output adapters: Notion/Slack/email mirrors** (~100 LOC remaining) — the terminal slice (`glean today`) shipped in v0.2.1. What remains: optional adapters that mirror the same content to a Notion page, Slack channel, or email. Each adds OAuth + network surface — only worth doing once `glean today` proves useful in dogfood (the v0.3.0 sweep + the forthcoming `glean rate` will tell). (Cheap first step toward what the critique called "inbox UI.")
- **`draft-pr-reply` candidate type** (~200 LOC) — adds a third candidate type alongside `research-dossier` and `fetch-docs`. Was in the original MVP spec §7 template list but cut from scope. Drafts replies to unresolved PR review comments discovered via `gh api`. Pure code addition — no audience pivot required, but creates the *option* to pivot toward PR-heavy users (OSS maintainers, engineering managers) if signal emerges. (Cheap first step toward what the critique called "broader audience.")

*(API-key fallback was promoted from this section to Up next #5 on 2026-05-26.)*

### Needs user action (can't be automated from inside a session)

- **Demo media for README** — screenshot of a rendered `INDEX.md` and a ~20s terminal GIF of `glean run --dry-run`. README has `<!-- TODO -->` placeholders marking exactly where they go. The single biggest lever for landing-page conversion.
- **`npm publish`** — package.json builds correctly; needs the user's npm login. Reduces install from 5 commands to 1 (`npm i -g glean`).
- **POSIX port real-machine validation** — once the code is written (see "Distribution prep" in Tracked backlog), it needs testing on actual macOS/Linux machines. Windows-only sessions can write the code but can't validate it.

---

## Deferred indefinitely (third-party critique, unblocked by evidence)

These are valid long-term product directions identified in the v0.1.2 brainstorm's third-party critique review, but premature for current evidence. Revisit only when (a) the engine has proven product-market fit in its current shape, OR (b) real users ask for them. Documented in [`docs/superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md`](./superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md) §8.

A 2026-05-25 second-pass review extracted v0.2-shaped cheap first steps from 3 of these 5 items — see "Smaller v0.2-shaped features" above. The full-scale versions below remain deferred.

- **Inbox UI / web+mobile surface** — Re-theorization 1 from the critique. Folder-of-markdown is currently the consumption surface; a triaged inbox would be better UX for non-devs but is a 10x scope expansion. *Cheaper first step now in Tracked: `glean today` + Notion/Slack/email output adapters.*
- **Event-driven triggers** — laptop lid close, calendar event ended, PR webhook, etc. Replaces scheduled+manual triggering. All require deep OS/OAuth/webhook integration. *Already partially covered by the **Scheduling** item in Deferred sub-projects above; event-driven is the upgrade of scheduling, not a parallel concern. Do scheduling first.*
- **Blended capacity** — user API key + session-driven Pro/Max + included pool, opaque to user. 5x the auth/billing/fallback complexity for a benefit users mostly don't care about until pricing matters. *Cheaper first step now in Tracked: API-key fallback when Pro/Max rate-limits.*
- **Trust gradient (read-only → approve → autonomous)** — phased autonomy progression. Re-theorization 2 from the critique. *Not a standalone deliverable: emerges naturally from the persistent memory substrate (Up Next #1) plus `draft-impl` (Tracked sub-project) once both ship. The trust gradient is how you'd USE those two foundations together, not a separate thing to build.*
- **Solo-dev wedge → broader audience pivot** — engineering managers, OSS maintainers, founders, researchers as wider markets. Premature until the dev wedge itself is validated beyond one user. *Cheaper first step now in Tracked: `draft-pr-reply` candidate type — creates the option to pivot toward PR-heavy users without committing to the pivot itself.*

---

## Done (most recent first — for context only)

- **v0.3.0** (2026-05-26, tag `v0.3.0`) — dossier-existence sweep. Passive usefulness telemetry: every `glean run` checks whether candidate dossiers from 7+ days ago still exist on disk, writes the result to a new `dossier_existed_at_7d` column in `memory.db`. Schema migration v2. No CLI surface, no engine behavior change. First step in answering the strategic analysis's existential question about dossier usefulness. See [v0.3.0 spec](./superpowers/specs/2026-05-26-glean-dossier-sweep-design.md), [v0.3.0 plan](./superpowers/plans/2026-05-26-glean-dossier-sweep.md).
- **v0.2.1** (2026-05-26, tag `v0.2.1`) — `glean today` terminal subcommand. Scans `~/glean/dossiers/*/<today>/INDEX.md` and prints a grouped, ANSI-colored report to stdout. Read-only, no engine changes. Ships the terminal slice of "Output adapters" — Notion/Slack/email mirrors remain deferred. See [v0.2.1 spec](./superpowers/specs/2026-05-25-glean-today-design.md), [v0.2.1 plan](./superpowers/plans/2026-05-26-glean-today.md).
- **v0.2.0** (2026-05-25, tag `v0.2.0`) — persistent memory substrate. SQLite-backed run/candidate history at `%USERPROFILE%\glean\memory.db`. Pure infrastructure: no CLI surface, no behavior change. Enables three future learning loops (suppress duds, rank by realized value, adapt budgets). See [v0.2.0 spec](./superpowers/specs/2026-05-25-glean-memory-substrate-design.md), [v0.2.0 plan](./superpowers/plans/2026-05-25-glean-memory-substrate.md).
- **v0.1.2** (2026-05-25, tag `v0.1.2`) — `discover-deps` parser rewrite using full-file parsing at git boundaries with section-aware scoping. Fixed 32-spurious-candidate regression from v0.1.1 dogfood. See [v0.1.2 spec](./superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md), [v0.1.2 dogfood report](./open-work/05-v012-dogfood.md).
- **v0.1.1** (2026-05-24, tag `v0.1.1`) — quality patch: scanner noise filter, multi-signal JSONL discovery, `glean repair`, `--task-timeout`, executor cleanups (slug/timer/sentinel). 10 dogfood fixes. See [v0.1.1 spec](./superpowers/specs/2026-05-24-glean-v011-quality-patch-design.md), [v0.1.1 dogfood report](./open-work/04-v011-dogfood.md).
- **v0.1.0-mvp** (2026-05-23, tag `v0.1.0-mvp`) — initial MVP. Research-dossier + fetch-docs discovery and execution against a single Windows project. 58 tests, 1178 LOC. See [MVP spec](./superpowers/specs/2026-05-23-glean-mvp-design.md), [MVP dogfood report](./open-work/03-dogfood-results.md).

---

## How to update this file

When you finish a release or take/defer/complete an item:

1. Move completed items from **Up next** or **Tracked backlog** to **Done**, with the release tag and a one-line summary linking to the spec/dogfood doc.
2. Promote items from **Tracked backlog** to **Up next** as priorities clarify. Keep **Up next** at 3–5 items max.
3. Add new items as they surface from dogfood, user feedback, or strategic review. Link the originating doc.
4. Update the header date and current-release pointer.
5. Commit on `main` with message `docs(roadmap): <what changed>` — this file changes outside the brainstorm → spec → plan cycle.

The full vision (much broader than what's tracked here as actionable work) lives in [`glean.md`](../glean.md) at the repo root. This roadmap is the actionable subset.
