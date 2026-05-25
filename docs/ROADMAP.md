# Glean Roadmap

> Single source of truth for planned work. Each entry links to the spec, dogfood doc, or critique that originated it. Update on every release and whenever an item is added, deferred, or completed.

**Last updated:** 2026-05-25 (post-v0.2.0; memory substrate shipped)
**Current release:** [v0.2.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.2.0) (commit `<TBD>`)
**Branch state:** `main` clean, no in-progress patch

---

## In progress

*(nothing currently)*

---

## Up next (recommended priority order)

### 1. POSIX port (macOS / Linux support)

**Status:** [GitHub issue #1](https://github.com/Jonny-boy9000/glean/issues/1) open, implementation outline filed.
**Source:** [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §2 (Windows-first decision) — `glean.md` §10 also constrains this.
**Why:** Unblocks the largest audience segment for any real OSS adoption. Most of the implementation is ~80% path-separator cleanup; the hard part is making `jobobject.ts` POSIX child-tree-kill work via `detached: true` + `process.kill(-pid)`.
**Scope sketch:** ~200–400 LOC. See the issue body for the file-by-file breakdown.

### 2. File this roadmap's tracked items as GitHub Issues

**Status:** new (added 2026-05-25).
**Why:** Right now ROADMAP.md is the only place these items are tracked. For outside contributors and discoverability, each substantive item should be a real GitHub issue with labels (`enhancement`, `bug`, `help wanted`, etc.) and prose context. Issues also let people +1, comment, and signal demand.
**Scope:** ~1 hour. Use the existing `mcp__plugin_github_github__issue_write` tooling (or `gh issue create` if installed). One issue per "Up next" item and one per "Deferred sub-projects" item — about 12 issues total. Link each issue back to its originating doc.
**Don't file:** hygiene items (those are self-contained tasks for whoever's already in the repo), deferred-indefinitely items (those signal noise, not direction).

---

## Tracked backlog

### Deferred sub-projects (each needs its own brainstorm → spec → plan cycle)

These are the "real features" deferred from MVP. Each is substantial enough to deserve its own design. Originally documented in [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §14.

- **`draft-impl` worktree drafting** — Claude writes speculative code into `git worktree`-based `prep/*` branches. The `base_branch` field already in `config.json` for forward-compat. Biggest single feature by code volume (~1000–1500 LOC). Design sketch in `glean.md` §5.3.
- **Scheduling** — Windows Task Scheduler / launchd / cron integration so glean runs automatically Thursday evening. Design sketch in `glean.md` §5.5. ~400–600 LOC.
- **`glean discard` / `glean gc` / `glean peek` subcommands** — discard a run by ID, garbage-collect dossiers older than 21 days, peek at today's INDEX from inside a session hook. ~300 LOC.
- **SessionStart hook** — auto-print today's INDEX when `cd`-ing into a repo that has a recent dossier. Pairs with `glean peek`.
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

### Smaller v0.2-shaped features (promoted 2026-05-25 from "Deferred indefinitely")

A second-pass review of the third-party critique surfaced cheap-first-step versions of three items the original review dismissed wholesale. Each is roughly v0.2-scale: small, defensible, doesn't require any of the bigger product bets (web app, billing layer, OS hooks). Each needs its own brainstorm → spec → plan when prioritized.

- **Output adapters: `glean today` + Notion/Slack/email** (~150 LOC) — addresses "folder is a bad consumption surface" without building a web app. `glean today` pretty-prints the latest INDEX.md inline in the terminal. Optional adapters mirror the same content to a Notion page, Slack channel, or email. Engine unchanged; just adds output surfaces beyond the local folder. (Cheap first step toward what the critique called "inbox UI.")
- **API-key fallback when Pro/Max rate-limits** (~75 LOC) — adds an `ANTHROPIC_API_KEY` env-var path so glean keeps going when the subscription window closes. Doesn't change the subscription-arbitrage story; just extends the runway for users who happen to have both. Today, a single rate-limit signal halts the entire run; with fallback, longer overnight runs become possible. (Cheap first step toward what the critique called "blended capacity.")
- **`draft-pr-reply` candidate type** (~200 LOC) — adds a third candidate type alongside `research-dossier` and `fetch-docs`. Was in the original MVP spec §7 template list but cut from scope. Drafts replies to unresolved PR review comments discovered via `gh api`. Pure code addition — no audience pivot required, but creates the *option* to pivot toward PR-heavy users (OSS maintainers, engineering managers) if signal emerges. (Cheap first step toward what the critique called "broader audience.")

### Needs user action (can't be automated from inside a session)

- **Demo media for README** — screenshot of a rendered `INDEX.md` and a ~20s terminal GIF of `glean run --dry-run`. README has `<!-- TODO -->` placeholders marking exactly where they go. The single biggest lever for landing-page conversion.
- **`npm publish`** — package.json builds correctly; needs the user's npm login. Reduces install from 5 commands to 1 (`npm i -g glean`).
- **POSIX port real-machine validation** — once the code is written (Up Next #2), it needs testing on actual macOS/Linux machines. Windows-only sessions can write the code but can't validate it.

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
