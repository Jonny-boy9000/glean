# Glean Roadmap

> Single source of truth for planned work. Each entry links to the spec, dogfood doc, or critique that originated it. Update on every release and whenever an item is added, deferred, or completed.

**Last updated:** 2026-06-12 (v0.8.4 released: PRs #15–#19 merged; Terra Firma live test run)
**Current release:** **v0.8.5 published to npm** (`@jonny-boy9000/glean@0.8.5`, PRs #15–#23, tag `v0.8.5`) — the `glean serve` management dashboard + capacity panel, Linux beta (systemd user timers), drain-resilience fixes (honest dedup ledger + structured-429 short-circuit, ADR-0003), dossier read-scope (ADR-0002 Accepted), docs consolidation. 538 tests + 6 skips (4 Linux-gated).
**Branch state:** `main` at v0.8.5, clean.
**Live validation (2026-06-02):** first real `glean run` (4 tasks, 0 failed) + `--drain` tick both succeeded against `claude -p` on the logged-in machine; `glean schedule enable` registered the unattended drain (fires **Thu 2026-06-04 18:00**, Asia/Jerusalem → Thursday auto-detect). The drain will run unattended; the v0.8.2 **BLOCK-CAPTURE tripwire** auto-captures the real hard-block the first time the weekly cap is hit (closes ADR-0001 — see Up next #1).

---

## In progress

### v0.9 "capacity governor" — strategy locked 2026-06-12

Design: [`docs/design/2026-06-12-capacity-governor-strategy.md`](./design/2026-06-12-capacity-governor-strategy.md)
(office-hours session; analyzes the 2026-06-11 drain — it ran out of WORK, not capacity).
v0.9.0 scope: `glean usage` (self-relative weekly pacing via ccusage-style local JSONL
accounting), nightly schedule preset gated by pace tier, `--model sonnet` default on
drained tasks (Max plans: separate Sonnet weekly pool + Opus burns the shared cap
several times faster), `--max-turns` guard on every spawn, plus the two engine fixes
below. Later stages: utilization-aware admission control, estimate-vs-actual
calibration, triage pass, dossier→draft-impl chaining, `glean mcp` dossier server,
and the **project portfolio** (dashboard registry of every discovered project with
per-project priority dials steering allocation; a `discover-docs` pass mining each
project's roadmap/handoff docs as candidates; post-hoc overlap learning — compare
what glean prepped vs what the user actually advanced, recomputed from git/JSONL
each run, nudging allocation within the user's dial).
New CLI verbs planned: `resume`, `retry <run-id>`, `doctor` (`projects` and `usage` shipped — below).

**`glean usage` + pacing engine — BUILT 2026-06-13** (branch `feat/usage-pacing`):
the design's "Pacing definition" math, pinned and tested — `src/lib/usage.ts`
(internal JSONL loader; **deviation from the ccusage/data-loader plan recorded in
[ADR-0007](./decisions/0007-internal-usage-loader.md)**: ccusage v20 is binary-only,
v19 dropped the export, and its daily aggregation can't apply glean's cwd-based
own-session exclusion), `src/lib/pacing.ts` (pure, injectable clock: weighted
tokens per family per [ADR-0005](./decisions/0005-model-weight-multipliers.md),
4-complete-calendar-week per-weekday median baseline, pace ratio, tiers
skip/small/normal/large with config-overridable thresholds, cold-start +
zero-baseline pinned conservative, `pacing.haircut` + `pacing.enabled` config),
`glean usage [--json]` (week-vs-baseline table, tier + reasoning, blind-spot note,
last five_hour utilization). **`recommendTier()` is the wave-2 public API** the
nightly preset will consume. **Remaining for wave 2:** the nightly schedule preset
itself (second scheduled task gated by `glean usage --json`), morning anti-spill
(end N hours before typical first prompt), `--model sonnet` drain default +
`--max-turns`, dashboard pace panel.

**Project portfolio — registry + dials slice BUILT 2026-06-12** (branch
`feat/project-portfolio`): `scanProjectRegistry` (real paths from session-jsonl
`cwd`, slug never decoded; glean-spawn/worktree/temp noise filtered; deduped;
unioned with config), per-project `priority` dial in `config.json`
(`setProjectPriority` — opt-in add, atomic, `off` keeps the entry; unconfigured
= implicitly `off`), dashboard **Projects** tab (segmented dials, add-project,
per-row Run now), `GET /api/projects` + guarded `POST /api/projects/{add,priority}`,
`/api/run` refuses `off`, and `glean projects [set <path> <priority>]` CLI parity.
**Remaining from the portfolio design:** the multi-project drain allocator that
weights ranking/budget by dial (needs v0.9.0 multi-project), the `discover-docs`
pass, and post-hoc overlap learning (v0.10).

In-flight branches (2026-06-12 session):
- `fix/drain-rate-limit-resilience` — bug 1 (failed≠completed ledger) + bug 2 (429 short-circuit)
- `feat/dashboard-ux` — capacity/utilization panel, favicon, empty states, usability
- `feat/linux-support` — systemd user timers (Persistent=true) + POSIX process-group kill
- `docs/consolidate-state` — this consolidation (single live handoff, stale-state fixes)

### `glean serve` — local management dashboard — **BUILT 2026-06-12 (unreleased)**

A localhost web dashboard for viewing AND managing glean's operation: runs list
→ run detail (orchestrator timeline + task table + per-task stream) → retry
failed tasks; dossiers list → rendered OUT.md + discard/rate; overview with
drain-window health + STOP/schedule state + one-click Run/Stop/Resume. Built on
Node's `http` (no new deps) + a self-contained `templates/dashboard.html`;
127.0.0.1-only with CSRF/loopback/path-traversal guards. New files:
`src/lib/serve.ts`, `src/lib/dashboard-data.ts`, `templates/dashboard.html`,
`docs/design/glean-serve-dashboard.md`; +21 tests (436 total). Verified live
against the real `~/glean` (34 runs, 62 dossiers). **Remaining before release:**
version bump + CHANGELOG/README, and `glean serve` integration row in the
verification checklist.

---

## Bugs found in the 2026-06-11 drain (file before next release)

> Surfaced by reading the unattended 2026-06-11 drain (3 ticks: 18:00 productive,
> 19:00/20:00 no-ops). Both are real and verified; the dashboard *surfaces* them
> but the fixes belong in the drain engine.

1. **Failed tasks are recorded as completed and never retried.** All 7 tasks
   that died on a session-limit `429` (zero output) were added to
   `budget.json.completed_task_ids` and `summary.completed_evidence_hashes`
   (`pipeline.ts:~255` pushes the hash after *any* result, incl. failed), so
   later ticks `task.skip_completed` them forever. Fix: only record `ok`/
   `ok-fallback` outcomes in the dedup ledger; let failed/timeout/rate-limit
   re-enter discovery. (`glean serve`'s **Retry failed** button is a manual
   workaround — it removes those hashes from `completed_task_ids`.)
2. **No rate-limit short-circuit.** After the first `429` the orchestrator
   spawned 6 more doomed tasks (each rejected in ~2s) instead of detecting the
   session-limit signal (present as a structured `rate_limit_event` /
   `error:"rate_limit"` in the stream) and stopping or pausing until `resetsAt`.
   `orchestrator.log` logged no rate-limit event at all. Ties into ADR-0001 and
   the classifier work.

---

## Up next (recommended priority order)

> **Strategic lens (2026-06-01):** The load-bearing question was always "does the engine produce something you'd actually open?" v0.3–v0.6 built the telemetry to measure it; v0.7.0 shipped the `draft-impl` engine (AI-drafted branches in isolated worktrees) and v0.7.1 the `glean morning` receipt with verified test status. The **first real validation run** (2026-06-01, throwaway repo) produced keep-worthy code with `tests: pass` and main untouched — a positive first datapoint on the existential question, but only one, on a dependency-free repo. Two things move the needle most now: (1) make glean actually consume the *whole week* unattended (v0.8 drain core) so there's enough output to judge, and (2) real-repo dogfooding to turn that one datapoint into a trend. Published to npm as `@jonny-boy9000/glean@0.7.1` on 2026-06-01.

### 1. First real overnight/weekend drain run (validation gate — closes ADR-0001) — **ARMED**

**Status (2026-06-02):** the loop is now **validated in the wild AND armed to capture the block.** A real `glean run` (4 tasks, 0 failed) and a `--drain` tick both succeeded against `claude -p` on the logged-in machine, and `glean schedule enable` registered the unattended drain (fires **Thu 2026-06-04 18:00**). What remains is purely *waiting for a real weekly-cap hit*: the scheduled drain runs unattended across the window, and the v0.8.2 **BLOCK-CAPTURE tripwire** dumps the real hard-block signal to `~/glean/logs/<run>/<task>.BLOCK-CAPTURE.txt` the first time `claude -p` actually blocks. The only remaining work is the **hard-block** capture — the original framing below stands, minus the "set up a run" part (done). Per [ADR-0001](./decisions/0001-rate-limit-signal-source.md), every `rate_limit_event` ever captured is a *warning* (status `allowed`/`allowed_warning`); the actual block shape (what `claude -p` emits when it can't proceed) has never been observed, so `classify.ts`'s stderr block detector remains an honest guess. The v0.8.2 **self-capturing `BLOCK-CAPTURE` tripwire** now makes that capture automatic the first time it happens — so this gate closes itself on the next real block. **Needs user action** (a live multi-hour run that actually trips the weekly cap; can't be done inside a session). When it lands: drop the real fixture into `test/fixtures/captured-rate-limit/`, un-skip the ADR-0001 tripwire test, make `classify` parse the verified block shape, and supersede ADR-0001.

<details><summary>v0.8.0 design + build history (for context)</summary>

**Status:** the next major milestone (promoted to Up next 2026-06-01). Full design + rationale lives in **Tracked backlog → Deferred sub-projects** ("v0.8 drain core") — read it before starting.
**Why:** today glean stops on the first rate-limit and leaves most of the weekly allowance unused; the whole "drain your idle capacity" premise depends on fixing this. **Build it as exit-and-re-enter** (persist `next_eligible_at` + a resume cursor, idempotent re-entry guard, paired with Windows Task Scheduler) — **NOT an in-process multi-hour sleeper**: that dies at laptop lid-close/hibernate on Windows and forks control flow on the known-buggy reset timestamp; the v0.7 eng review + an adversarial pass rejected it. Resume state goes in a dedicated `state/budget.json`, NOT `candidates.json` (clobbered each run).
**How to start:** design is **locked** (2026-06-01 office-hours design doc `user-main-design-20260601-195916.md`, APPROVED, adversarially reviewed). Confirmed model: one weekly Thursday-evening Windows Task Scheduler trigger repeating ~hourly across a bounded ~60h window; re-entry guard handles the 5-hour session windows (the re-launch crosses 5h gaps, it is NOT "run all week"). **Split into v0.8.0** (signal classifier by 6h reset horizon + re-entry guard + resume cursor in `state/budget.json` + minimal no-progress backstop + `glean schedule` + honest reporting) **and v0.8.1** (configurable circuit breaker, first-class mid-weekend re-discovery, anti-spill margin). Two shipping-blockers caught in review: (1) **verify `claude -p` authenticates under a non-interactive Task Scheduler context FIRST** — could invalidate the mechanism; (2) `glean schedule` is Task Scheduler **XML generation** (battery + StartWhenAvailable + MultipleInstances flags `schtasks` can't set), not flag-passing. **Eng review CLEARED 2026-06-02** (7 decisions, 0 critical gaps): per-burst runIds with `morning` aggregating the window via `getRunsSince`; timestamp-scoped STOP; atomic `budget.json` (corrupt=fail-safe); lock-free early-exit guard; thin `runDrain()` wrapper keeping bare `glean run` unchanged; injected `now()` clock for tests. **New premise gate added: Spike 0 usage-probe** — if a headless `claude usage`/`--usage` query exists today, the stderr classifier is replaced by a usage-poll (exit-and-re-enter frame unchanged). v0.8.1 absorbs: circuit-breaker tuning, mid-weekend re-discovery, anti-spill margin, **and `today`/`peek` window-aware aggregation** (so all three surfaces match `morning` during a drain). Next: spike-first build (Spike 0 → Spike A → engine). **All of the above shipped in v0.8.0.**

</details>

### 2. API-key fallback when Pro/Max rate-limits

**Status:** smaller engine-durability win; second priority behind the drain core.
**Source:** [`docs/superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md`](./superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md) §8.
**Why:** When `claude -p` returns rate-limit stderr, fall back to `ANTHROPIC_API_KEY` (if the env var is set) for the rest of the budget. Doesn't change the subscription-arbitrage premise; just stops a single rate-limit signal from killing an overnight run. Note: overlaps with the v0.8 drain core's signal handling — sequence it with or after v0.8.
**Scope sketch:** ~75 LOC. Pure executor addition; deny-list and safety story unchanged.

### 3. Real-repo dogfooding of draft-impl

**Status:** ongoing validation, promoted 2026-06-01.
**Why:** v0.7's validation was one run on a dependency-free throwaway repo (`~/glean-validate`). The existential "would I keep what it drafts?" question needs draft-impl pointed at real projects with real TODOs, with `glean rate` verdicts collected over time, to become a trend rather than a single datapoint. Watch for the `tests: none` (deps-missing worktree) case — common on real Node repos until a per-project install step exists.

---

## Tracked backlog

### Deferred sub-projects (each needs its own brainstorm → spec → plan cycle)

These are the "real features" deferred from MVP. Each is substantial enough to deserve its own design. Originally documented in [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §14.

- **`draft-impl` worktree drafting** — Claude writes speculative code into `git worktree`-based `prep/*` branches. The `base_branch` field already in `config.json` for forward-compat. Biggest single feature by code volume (~1000–1500 LOC). Design sketch in `glean.md` §5.3.
- **Scheduling** — Windows Task Scheduler / launchd / cron integration so glean runs automatically Thursday evening. Design sketch in `glean.md` §5.5. ~400–600 LOC.
- **v0.8 drain core — weekly-capacity draining (exit-and-re-enter, NOT in-process sleep).** Make glean consume the whole week's idle subscription capacity instead of stopping on the first rate-limit. **Design locked by 2026-06-01 office-hours + eng review:** on a rate-limit, persist `next_eligible_at` + a resume cursor and **exit cleanly**; an idempotent re-entry guard (`if now < next_eligible_at → exit 0`) lets the **Scheduler** (above, built together) re-launch glean after each 5-hour/weekly window. **Do NOT build an in-process multi-hour sleeper** — it dies at laptop lid-close/hibernate on Windows (the target platform) and contradicts the "opened my laptop Monday" story; the eng review rejected it for exactly this. The exit-and-re-enter model also avoids forking control flow on the known-buggy displayed reset timestamp — it only needs "is there a reset roughly when," never the window *type*. Absorbs four sub-items that were briefly specced as a v0.7 "drain core": signal classification by reset horizon, the anti-spill margin (note: structurally blind on a run's *first* task because the weekly window is rolling-from-first-prompt — design around that), a consecutive-unproductive-resume circuit breaker, and mid-run candidate re-discovery (a multi-day run otherwise works from a stale day-1 snapshot). Pairs with **Scheduling**; build the two together. Resume state must NOT live in `candidates.json` (clobbered each run by `writeCandidatesJson`, pipeline.ts:121) — use a dedicated `state/budget.json`. Originated: 2026-06-01 office-hours design doc + plan-eng-review.
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
- **`fetch-docs` can't reach external doc tools under the deny-list (found live 2026-06-02).** In the first real run, every fetch-docs task degraded to model-knowledge docs because the spawned `claude -p` session had context7 (MCP), `WebFetch`, `WebSearch`, and `github.get_file_contents` all "permission not granted (declined)" — they aren't in the scoped allow-list, and the deny-list/no-broad-grant posture blocks them. The dossiers honestly report this (good), but fetch-docs can't do its actual job. Decide: either grant fetch-docs a narrow doc-fetch allow-list (context7 + WebFetch to known doc hosts), or relabel the candidate type to set expectations. Originated: v0.8.2 live validation run (`~/glean/dossiers/glean/2026-06-02/docs/OUT.md`).

### Distribution prep (deferred until telemetry validates the core)

These items unblock outside adoption but provide no signal about whether the engine is worth adopting. Deliberately deferred 2026-05-26 in favor of usefulness telemetry and compound-memory loop (the v0.3.0 sweep + v0.4.0 ratings + v0.5.0 surfacing + v0.6.0 peek — all shipped). Revisit once telemetry shows dossiers are being kept/actioned more often than discarded.

- **POSIX port (macOS / Linux support)** — was Up next #1 until 2026-05-26. Implementation outline in [GitHub issue #1](https://github.com/Jonny-boy9000/glean/issues/1). ~200–400 LOC, mostly path-separator cleanup; hard part is `jobobject.ts` POSIX child-tree-kill via `detached: true` + `process.kill(-pid)`. Source: [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./superpowers/specs/2026-05-23-glean-mvp-design.md) §2.
- **File this roadmap's tracked items as GitHub Issues** — was Up next #2 until 2026-05-26. ~1 hour. One issue per substantive Tracked item (~12 issues). Use `mcp__plugin_github_github__issue_write` or `gh issue create`. Adoption-shaped, not dogfood-shaped.

### Smaller v0.2-shaped features (promoted 2026-05-25 from "Deferred indefinitely")

A second-pass review of the third-party critique surfaced cheap-first-step versions of three items the original review dismissed wholesale. Each is roughly v0.2-scale: small, defensible, doesn't require any of the bigger product bets (web app, billing layer, OS hooks). Each needs its own brainstorm → spec → plan when prioritized.

- **Output adapters: Notion/Slack/email mirrors** (~100 LOC remaining) — the terminal slice (`glean today`) shipped in v0.2.1. What remains: optional adapters that mirror the same content to a Notion page, Slack channel, or email. Each adds OAuth + network surface — only worth doing once `glean today` proves useful in dogfood (telemetry now visible via v0.5.0 — start dogfooding). (Cheap first step toward what the critique called "inbox UI.")
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

- **v0.8.3** (2026-06-02, merge `7e08e3a`, PR #14, tag `v0.8.3`, **published to npm**) — **schedule status/disable fix, found in live validation.** `Register-ScheduledTask` accepts the combined `Glean\Drain` name (and creates the `\Glean` folder), but `Get-ScheduledTask`/`Get-ScheduledTaskInfo`/`Unregister-ScheduledTask` don't match it — they need `-TaskPath '\Glean\' -TaskName 'Drain'`. So `glean schedule status` reported a *registered, live* task as "not registered" (and `disable` wouldn't have removed it). Surfaced during the v0.8.2 validation run on the real Windows machine (the isolated `npx` install check can't catch this class). Fix: pure unit-tested `buildStatusScript()`/`buildUnregisterCommand()` using the split form + regression tests; verified live (`status` now reports `Ready`, next run Thu). 406 tests + 2 skips. The scheduled drain itself was always registered correctly.
- **v0.8.2** (2026-06-02, merge `f1ff650`, PR #13, tag `v0.8.2`, **published to npm**) — **drain robustness + honest rate-limit signal.** Five items across three file-disjoint lanes: configurable circuit-breaker (`config.drain_trigger.max_unproductive`, default 3) + richer `RunSummary.productive` signal (a burst that ran tasks but produced only empty/trivial output now counts as unproductive; rate-limit pauses + transient reasons never count); first-class mid-weekend re-discovery + stable `evidence_hash` dedup; per-burst anti-spill margin (new `runDrain` guard 3e, `config.drain_trigger.anti_spill_margin_minutes` default 15 — refuses to start a burst within the margin of a known weekly reset; `pipeline.ts` untouched); `today`/`peek` window-aware aggregation (own `TodayReport` aggregator over `getRunsWithCandidatesSince`, gated on an active window, byte-identical with no window); and the **honest rate-limit signal ([ADR-0001](./decisions/0001-rate-limit-signal-source.md))** — `classify` parses the *verified* structured `rate_limit_event.resetsAt` from `claude -p`'s stream-json as enrichment while the stderr block detector stays load-bearing/unchanged, plus a self-capturing `BLOCK-CAPTURE` tripwire. 402 tests + 2 documented skips (incl. integration `v22` cross-lane). Built via office-hours → plan-eng-review → parallel worktree TDD lanes (D-core/D-surfaces/D-signal) → 3 per-lane reviews (1 critical: a memory.db error could crash `glean today` instead of degrading — fixed) → final whole-impl review (no blockers). Also landed: `docs/PROJECT-MAP.md` (3-tree index), `docs/decisions/` ADR convention, `docs/open-work/06` rate_limit_event findings, `docs/design/` mirrored gstack docs. **Still pending:** one real overnight/weekend drain run to capture the true hard-**block** signal (ADR-0001 closes when the tripwire or a live run lands a real block — see Up next).

- **v0.8.0** (2026-06-02, merge `0e6a63d`, PR #6) — **the drain core (first slice).** `glean run --drain` consumes a weekend's leftover capacity via exit-and-re-enter: a bounded burst pauses on a 5-hour session limit, persists `next_eligible_at` + a stable-`evidence_hash` resume cursor to atomic `state/budget.json`, and exits; a Windows Task Scheduler trigger (`glean schedule enable`, PowerShell `Register-ScheduledTask`, battery-safe, run-only-when-logged-on, `node bin/glean.js` action) re-launches it across the Thursday→weekly-reset windows. A horizon-based rate-limit classifier (session <6h / weekly ≥6h / ambiguous) drives the loop; `glean morning` aggregates every burst in the window; `glean stop` is timestamp-scoped. Both make-or-break gates cleared empirically first (no headless `claude usage` query exists; `claude -p` authenticates under Task Scheduler). 343 tests incl. integration `v21` (real CLI session-pause→resume + weekly-stop). Built via parallel worktree agents (office-hours → plan-eng-review (7 decisions) → per-lane spec+quality reviews → final whole-impl review). Reviews caught + fixed: PowerShell `-Argument` quoting + read-only `.Repetition` bugs (live-PS tests), a dead resume cursor, and a session-pause-self-terminates-the-weekend backstop bug. **v0.8.1 deferred:** configurable circuit-breaker, mid-weekend re-discovery, anti-spill margin, `today`/`peek` window views; **+ one real overnight drain run** to capture true rate-limit stderr wording. Not yet npm-published.
- **v0.7.1** (2026-06-01, merge `8de2650`, PR #3) — `glean morning` receipt + verified draft-impl test status. New `glean morning` subcommand narrates the latest run (draft branches with diff stats + `tests: pass/fail/none`, dossiers, honest outcome line; silent-degrades with no run). After a draft commits, glean runs the per-project `test_command` inside the worktree, bounded by remaining `--budget` and skipped on STOP; environment/setup failures (bare worktree without `node_modules`) report `none`, never a misleading `fail`; salvaged partial drafts report `none`. Memory schema v5. Validated on two live `claude -p` runs (dep-free repo → `pass`; deps-missing repo → `none`, not a false `fail`). Adversarial review caught + fixed 6 test-capture issues (budget overrun, false-`fail`, quoted paths, salvaged drafts, branchless drafts, duration). 222 tests. **Remaining v0.7 distribution: demo GIF + `npm publish` (npm name `glean` is taken — needs a scoped/alternate name).**
- **v0.7.0** (2026-06-01, merge `186d977`, PR #2) — `draft-impl` engine. New candidate type that drafts code for the top-ranked TODO into a `git worktree` on a `prep/glean-*` branch off a per-project `base_branch`, spawning a headless `claude -p` scoped to that worktree; main checkout never touched. Safety boundary enforced by a scoped tool allow-list (bare `Bash` never granted), not just a deny-list. Adds `glean gc` (21-day worktree expiry, auto on each run), discriminated `TaskResult.output` (`file | branch`), memory schema v4. 183 tests. First of two v0.7 PRs — `glean morning` receipt + distribution land in v0.7.1. **In-process drain core was cut from v0.7 → v0.8** (exit-and-re-enter, not in-process sleep; see Tracked backlog). Reviewed via `/office-hours` → `/plan-eng-review` → adversarial pass (caught + fixed 2 criticals: deny-list bypass, worktree leak).
- **v0.6.0** (2026-05-26, tag `v0.6.0`) — `glean peek` subcommand + SessionStart hook recipe. CWD-scoped variant of `glean today` designed for hook use: walks up for `.git`, prints the matching project's today-dossier, exits 0 silent in every failure case. Closes the compound-memory-across-sessions loop. See [v0.6.0 spec](./superpowers/specs/2026-05-26-glean-peek-design.md), [v0.6.0 plan](./superpowers/plans/2026-05-26-glean-peek.md).
- **v0.5.0** (2026-05-26, tag `v0.5.0`) — `glean today` enriched with memory.db. Surfaces duration, output bytes, rate-limit hits, and user rating as an optional third line per entry. Read-only enhancement; engine and INDEX.md untouched. Silent degradation when memory.db is absent. Closes the telemetry feedback loop by making v0.3.0/v0.4.0 signals visible at the daily-rhythm surface. See [v0.5.0 spec](./superpowers/specs/2026-05-26-glean-today-enriched-design.md), [v0.5.0 plan](./superpowers/plans/2026-05-26-glean-today-enriched.md).
- **v0.4.0** (2026-05-26, tag `v0.4.0`) — `glean rate` subcommand for active usefulness telemetry. Writes `kept`/`discarded`/`actioned` verdicts to a new `user_rating` column; `glean rate --list` prints recent ratable dossiers. Schema migration v3. Pairs with the v0.3.0 passive sweep for complete dossier-quality measurement. See [v0.4.0 spec](./superpowers/specs/2026-05-26-glean-rate-design.md), [v0.4.0 plan](./superpowers/plans/2026-05-26-glean-rate.md).
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
5. **If the file/folder layout changed** (new module, moved file, new tree/location), update [`docs/PROJECT-MAP.md`](./PROJECT-MAP.md) too — it is the layout index future sessions read, and stale entries mislead.
6. Commit on `main` with message `docs(roadmap): <what changed>` — this file changes outside the brainstorm → spec → plan cycle.

The full vision (much broader than what's tracked here as actionable work) lives in [`glean.md`](../glean.md) at the repo root. This roadmap is the actionable subset. For *where everything lives* (incl. the machine-local gstack design docs and the `~/glean` runtime tree), see [`docs/PROJECT-MAP.md`](./PROJECT-MAP.md).
