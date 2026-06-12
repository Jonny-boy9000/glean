# Glean — Project Map (index of folders, files & layout)

> **Authoritative index of the whole glean project surface.** If you are a fresh session,
> read this after `CLAUDE.md` to know *where everything lives* — including the parts that are
> **not** in this git repo. Keep it current: see [How to keep this map current](#how-to-keep-this-map-current).
>
> **Last updated:** 2026-06-02 (v0.8.2 built + PR open; 406 tests + 2 documented skips).

---

## 0. The three trees (read this first)

glean's artifacts are split across **three physically separate locations**. Only the first is in
git. This split is the single most important thing to understand about the project layout — the
design history that drives every release lives partly *outside* the repo.

| Tree | Location | In git? | Holds | Portability |
|------|----------|---------|-------|-------------|
| **1. The repo** | `C:\Glean` | ✅ yes | source, tests, committed docs (`docs/`), specs+plans (`docs/superpowers/`) | clone-portable |
| **2. gstack project store** | `%USERPROFILE%\.gstack\projects\Jonny-boy9000-glean\` | ❌ no (machine-local) | office-hours **design docs**, **eng-review test plans**, review/task logs, cross-session **learnings** | **lost on a fresh machine** |
| **3. Runtime output** | `%USERPROFILE%\glean\` (`~/glean`) | ❌ no (generated) | `dossiers/`, `work/` worktrees, `logs/` (incl. real `claude -p` stream-json), `state/budget.json`, `memory.db`, `config.json` | regenerated per run |

> ⚠️ **Fragility:** Handoff docs (e.g. `docs/archive/v0.8.2-handoff.md`) reference Tree 2 by
> **absolute path**. A fresh clone on another machine cannot see the design docs / eng-review
> test plans. See [Strategic review → R1](#strategic-review--find--recommendations).
>
> 💡 **Tree 3 is where the real signal lives.** The actual `claude -p` rate-limit telemetry was
> found in `~/glean/logs/.../*.jsonl` (see [§6](#6-runtime-output-tree-3--glean) and
> [`docs/open-work/06-rate-limit-signal-findings.md`](./open-work/06-rate-limit-signal-findings.md)).

---

## 1. Repo root (`C:\Glean`)

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Load-bearing constraints + project state. **Read first.** |
| `glean.md` | The full product vision (§-numbered; broader than the roadmap). |
| `README.md` | Public-facing install + usage (npm `@jonny-boy9000/glean`). |
| `CHANGELOG.md` | Per-release notes (Keep-a-Changelog style). |
| `docs/PROJECT-MAP.md` | **This file** — the index of everything. |
| `docs/ROADMAP.md` | Single source of truth for *planned* work. Update every release. |
| `package.json` / `package-lock.json` | npm manifest; CLI bin = `bin/glean.js`; scripts: `build`/`test`/`lint`/`format`. |
| `tsconfig.json` | TS → `dist/` (the published artifact). |
| `vitest.config.ts` | Test glob: `src/**/*.test.ts` + `test/**/*.test.ts`. |
| `.eslintrc.cjs` / `.prettierrc` | Lint + format config. |
| `.gitattributes` | `* text=auto eol=lf` (silences Windows CRLF churn). |
| `.gitignore` | Ignores `node_modules/ dist/ *.log spike/ .claude/`. |
| `LICENSE` | MIT. |
| `.github/ISSUE_TEMPLATE/` | Issue templates: `bug_report.md`, `config.yml`, `drain-report.md` (feedback capture — ties to the launch plan). |
| `bin/glean.js` | Thin shim → `dist/cli.js`. |
| `dist/` | **Build output** (gitignored). `tsc` emits `dist/cli.js` + `dist/lib/*.js`. |
| `node_modules/` | Deps (gitignored). |
| `.claude/settings.local.json` | Local permission allowlist (gitignored). |

---

## 2. Source (`src/`) — module map

`src/cli.ts` — citty CLI: dispatches `run [--drain]`, `serve`, `schedule`, `projects [set]`,
`morning [--md]`, `today`, `peek`, `rate`, `gc`, `stop`, `repair`, `version`. Everything else
is `src/lib/*.ts` (one responsibility per file). Grouped by subsystem:

### Orchestration / drain state machine
| File | LOC | Responsibility |
|------|-----|----------------|
| `pipeline.ts` | 376 | `runPipeline` — ONE burst: lock → discover → dedup → rank → execute loop → finalize. The bare `glean run` path. |
| `runDrain.ts` | 246 | `runDrain` — thin exit-and-re-enter wrapper around a burst; guards (STOP/eligibility/no-progress), folds rate-limit classification into `DrainState`. **v0.8.2 lanes A/B/C live here.** |
| `state.ts` | 161 | `DrainState` type, atomic `state/budget.json` read/write, RUN.lock, STOP sentinel, summary/candidates writers. |

### Discovery (3 parallel read-only passes → candidates)
| File | LOC | Responsibility |
|------|-----|----------------|
| `discover-jsonl.ts` | 111 | Scan `~/.claude/projects/*.jsonl` session history for idle/unfinished signals. |
| `discover-git.ts` | 128 | `git grep TODO/FIXME`, stale branches, `gh pr list`. |
| `discover-deps.ts` | 226 | New-dependency detection at git boundaries (full-file, section-aware). |
| `jsonl-extract.ts` | 19 | Helper: pull fields from a session jsonl line. |
| `candidate-meta.ts` | 35 | `titleFor`/`sourceSignalFor`/`filePathFor`/`today` helpers. |

### Prioritize / dedup
| File | LOC | Responsibility |
|------|-----|----------------|
| `prioritize.ts` | 59 | Rank by `est_value / log(est_tokens+1)`, type weights, last-30-min restriction. |
| `dedup.ts` | 86 | **`evidenceHash`** (stable, timestamp-stripped) + `filterRecentlyProduced` (7-day skip). The drain skip-set keys on this. **v0.8.2 lane C.** |

### Execution
| File | LOC | Responsibility |
|------|-----|----------------|
| `executor.ts` | 789 | Per-candidate: provision (worktree/dossier), render template, spawn `claude -p` (stream-json + deny-list + timeout), capture output, classify rate-limit, draft-impl commit + test-status. Biggest file. |
| `jobobject.ts` | 58 | Child-tree kill on timeout/stop: `taskkill /T /F` on Windows; detached process group + `kill(-pid)` on POSIX. |
| `deny.ts` | 80 | The non-negotiable `--disallowedTools` deny-list applied to every spawn. |
| `model-routing.ts` | 97 | **v0.9 model routing (ADR-0006)**: pure `resolveModel`/`resolveMaxTurns` — pool-aware `sonnet` base → task-type default → config `models`/`max_turns` override → pace-tier override (wave-2 `paceTier` hook). Every spawn gets `--model` + `--max-turns`; `task.start` logs the resolved model. |
| `gc.ts` | 56 | 21-day `prep/glean-*` worktree expiry. |
| `classify.ts` | 154 | **Rate-limit signal classifier** (session<6h / weekly≥6h / ambiguous). ⚠️ Built on *stderr prose* — but the real signal is a stream-json `rate_limit_event` (see [§6](#6-runtime-output-tree-3--glean)). **v0.8.2 lane E.** |

### Persistence / telemetry
| File | LOC | Responsibility |
|------|-----|----------------|
| `memory.ts` | 490 | SQLite `memory.db`: runs + candidates + outcomes; `getRunsWithCandidatesSince` (window agg), enrichments, ratings. Schema v5. |
| `sweep.ts` | 36 | Passive dossier-existence sweep (7-day usefulness telemetry). |
| `rate.ts` | 78 | `glean rate` — kept/discarded/actioned verdicts. |
| `repair.ts` | 84 | `glean repair` — recover interrupted runs / stale state. |

### Surfaces (read-only reporting)
| File | LOC | Responsibility |
|------|-----|----------------|
| `today.ts` | 122 | `glean today` — today's dossiers across projects. **v0.8.2 lane D (window-aware).** |
| `peek.ts` | 27 | `glean peek` — CWD-scoped `today` for the SessionStart hook. **v0.8.2 lane D.** |
| `morning.ts` | 345 | `glean morning` — "while you slept" receipt; aggregates the whole drain window; writes `RECEIPT.md`. |

### Renderers (pure formatting)
| File | LOC | Responsibility |
|------|-----|----------------|
| `render.ts` | 149 | Dossier `INDEX.md` rendering. |
| `render-today.ts` | 117 | `glean today` terminal output. |
| `render-morning.ts` | 223 | `glean morning` terminal receipt; exports `PLAIN`/`outcomeLine` (single honesty switch). |
| `render-receipt.ts` | 95 | `RECEIPT.md` markdown (reuses `render-morning`'s data model). |

### Dashboard (`glean serve` — local management surface)
| File | Responsibility |
|------|----------------|
| `serve.ts` | Node `http` server (127.0.0.1 only): static page + JSON read API (+`/api/projects` registry) + guarded POST management API (stop/resume/run/retry-failed/discard/rate/schedule/projects-add/projects-priority). `/api/run` refuses priority-`off` projects. CSRF + loopback + path-traversal guards. |
| `dashboard-data.ts` | Pure-ish readers over `~/glean/`: `listRuns`, `getRunDetail` (orchestrator events + task table), `getTaskStream`, `listDossiers`, `readDossierBody`, `getOverview` (+health flags + `capacity`), `readCapacity` (last `rate_limit_event` from recent task streams), **`scanProjectRegistry`** (project portfolio: real paths from session-jsonl `cwd` — slug never decoded — noise-filtered via `isNoiseCwd`, deduped, unioned with config), and the two mutators `retryFailed` (un-dedup failed tasks) + `discardDossier`. |
| `templates/dashboard.html` | Self-contained SPA (vanilla JS, inline CSS, polls every 5s; render-on-change so the poll never clobbers in-progress interaction). Capacity gauge, relative timestamps, ok/failed ratio bars, guided empty states, **Projects tab** (registry table, segmented priority dials, add-project, per-row Run now). Shipped via the `templates` files-glob; read by `serve.ts` at runtime. |

### Scheduling / config / types
| File | LOC | Responsibility |
|------|-----|----------------|
| `schedule.ts` | 450 | Weekly drain schedule register/disable/status — Windows Task Scheduler + **Linux systemd user timer (crontab fallback)**; pure builders (`buildRegisterScript`, `buildSystemdUnit`/`buildTimerUnit`/`buildCrontabLine`); `defaultTriggerDay(tz)`. |
| `config.ts` | ~130 | Zod-validated `config.json` loader; per-project `priority` dial + `setProjectPriority` (opt-in add, atomic write, `off` keeps entry) + `effectivePriority` (configured-sans-dial = `normal`; unconfigured = `off`). |
| `types.ts` | ~135 | Shared types: `Candidate`, `RunSummary`, `RunReason`, `TaskOutput`, `GleanConfig`, `DrainTrigger`, `ProjectPriority`. |

> Each impl file has a co-located `*.test.ts` (vitest). 49 test files total.

---

## 3. Tests (`test/` + co-located `src/lib/*.test.ts`)

- **Unit specs:** co-located `src/lib/<mod>.test.ts` (e.g. `classify.test.ts`, `runDrain.test.ts`, `dedup.test.ts`, `schedule.test.ts`, `render-receipt.test.ts`).
- **Integration specs:** `test/integration/v01…v24-*.test.ts` — one per verification row (dry-run, full-task, budget, stop, rate-limit, dedup, lock, jobobject, gh-missing, stale-lock, repair, task-timeout, memory, today, rate, peek, draft-impl, gc, morning, **v21 drain**, **v22 drain-robustness** cross-lane, v23 dossier-read-access, **v24 projects CLI**).
- **Fixtures:** `test/fixtures/`
  - `fake-claude.{js,cmd,sh}` — stub `claude` binary driven by YAML scenarios.
  - `scenarios/*.yaml` — incl. `rate-limit`, `session-limit`, `weekly-limit`, `structured-429` (the real stream-json session block), `failed-exit`, `clean-exit-with-warning-event`, `wedged` (child stuck emitting past the timeout, ADR-0004), draft-impl variants.
  - `sessions*/` — sample `.jsonl` session histories for discovery tests.
  - **`captured-rate-limit/real-five-hour-events.jsonl`** — ⭐ REAL `claude -p` `rate_limit_event` WARNING lines harvested from `~/glean/logs` (2026-06-02); see [§6](#6-runtime-output-tree-3--glean).
  - **`captured-rate-limit/real-session-429-block.jsonl`** — ⭐ the REAL session-limit BLOCK (sanitized; run `2026-06-11-1800-d705f9`): `rate_limit_event` status `rejected` + message `error:"rate_limit"` + result `is_error/429`. Closed ADR-0001 → [ADR-0003](./decisions/0003-structured-stream-json-block-signal.md).
  - **`captured-rate-limit/real-capacity-event.jsonl`** — REAL sanitized `rate_limit_event` line from the 2026-06-11 drain run (`allowed_warning`, `utilization: 0.95`, `surpassedThreshold`); drives the dashboard `readCapacity` tests.

Run: `npm test` (builds first via `pretest`). Baseline @ v0.8.1: **352 pass, 1 skip**.

---

## 4. Committed docs (`docs/`)

| Path | Purpose |
|------|---------|
| `docs/ROADMAP.md` | Planned-work source of truth. |
| `docs/PROJECT-MAP.md` | This index. |
| `docs/handoff/post-v0.8.2-handoff.md` | **Live forward handoff** — the ONLY active handoff. **Read this to pick up cold.** Convention: exactly one live handoff in `docs/handoff/`; when superseded it moves to `docs/archive/`. |
| `docs/handoff/ORCHESTRATION-PROMPT.md` | Reusable paste-ready kickoff: gstack pipeline + Superpowers worktree subagents for a buildable roadmap item. |
| `docs/archive/` | Shipped/superseded handoffs (e.g. `v0.8.2-handoff.md`). Historical reference only — never read these to pick up work. |
| `docs/decisions/*.md` | **ADRs** — load-bearing decisions + unverified assumptions, tagged at the code site (`ASSUMPTION[ADR-NNNN]`). `0001` = rate-limit signal source (superseded by 0003); `0003` = structured stream-json block signal (session verified, weekly open); `0004` = wall-clock task deadline + bounded kill grace (the 2026-06-12 sleep/resume timeout overrun); `0006` = model routing pool-aware sonnet default (Pro pool-split assumption open). See its README. |
| `docs/superpowers/specs/*.md` | Per-release **design specs** (the "what") — MVP through v0.5/peek. |
| `docs/superpowers/plans/*.md` | Per-release **implementation plans** (the "how"). |
| `docs/open-work/01…05-*.md` | Findings + dogfood reports (jsonl format, job-object decision, dogfood results). |
| `docs/open-work/06-rate-limit-signal-findings.md` | ⭐ The `rate_limit_event` discovery (created 2026-06-02). |
| `docs/design/*.md` + `gstack-learnings.jsonl` | **Mirrored** gstack design docs + eng-review test plans (clone-portable copy of Tree 2 — see `docs/design/README.md`). |
| `docs/launch/LAUNCH-PLAN.md` | Launch + marketing plan. |
| `docs/launch/RUNBOOK-stages-1-3.md` | Launch execution runbook (stages 1–3). |
| `docs/assets/glean-morning.png` | README hero image. |

> **Naming note:** `docs/superpowers/` is internal jargon (how the project was built). ROADMAP
> hygiene item proposes renaming it `docs/specs/` + `docs/plans/` for outside legibility.

---

## 5. External gstack store (Tree 2 — `%USERPROFILE%\.gstack\projects\Jonny-boy9000-glean\`)

**Not in git** (the *working* copies). The output of `/office-hours`, `/plan-eng-review`, `/ship`,
and review skills. The substantive design docs + eng-review test plans are now **mirrored** into
`docs/design/` (R1 resolved) so a clone has them; the gstack store remains the live working copy.

| File pattern | What it is |
|--------------|-----------|
| `user-main-design-YYYYMMDD-*.md` | **Office-hours design docs.** `…195916.md` = v0.8.0 drain core (the canonical drain design); `…090419.md` = v0.8.1 polish (D7 = today/peek). |
| `user-main-eng-review-test-plan-*.md` | **Eng-review test plans** (latest = 2026-06-02, the v0.8 drain test plan). |
| `*-reviews.jsonl` | Per-branch review/ship logs (adversarial-review criticals, ship coverage, plan-eng-review verdicts). |
| `tasks-eng-review-*.jsonl` | Structured task breakdowns emitted by eng-review (T1…Tn with files/effort/findings). |
| `learnings.jsonl` | Cross-session **learnings** (e.g. the "no in-process sleep on laptop" pitfall). |

> Sibling dirs `dating-ops/`, `journal-ai/` under `.gstack/projects/` are **other projects** — ignore.

---

## 6. Runtime output (Tree 3 — `~/glean` = `%USERPROFILE%\glean`)

Generated by every run; **not in git**. Where the tool's real-world behavior is observable.

| Path | Holds |
|------|-------|
| `config.json` | Per-project `base_branch`/`test_command`, `claude_bin`, `drain_trigger`. |
| `memory.db` | SQLite telemetry (runs/candidates/outcomes/ratings). |
| `state/budget.json` | The atomic `DrainState` (drain window, next_eligible_at, completed evidence_hashes). |
| `state/RUN.lock`, `STOP` | Run lock + stop sentinel. |
| `dossiers/<slug>/<date>/INDEX.md` + `RECEIPT.md` | Per-run output the user opens. |
| `work/<…>` | `prep/glean-*` draft-impl worktrees (gc'd at 21 days). |
| `logs/<run>/<task>.{jsonl,stderr}` | Per-task `claude -p` capture. |

### ⭐ The rate-limit signal lives HERE, in the `.jsonl` (not stderr)

`claude -p --output-format stream-json` emits a discrete message:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed",            // also seen: "allowed_warning" (+ "utilization":0.94, "surpassedThreshold":0.9)
  "resetsAt":1779619200,          // epoch SECONDS
  "rateLimitType":"five_hour",    // verified; weekly value (likely "seven_day") NOT yet captured
  "overageStatus":"rejected","isUsingOverage":false}}
```

This is **more reliable than `classify.ts`'s stderr-prose regex** and was captured all along.
Full analysis + what's still unverified: [`docs/open-work/06-rate-limit-signal-findings.md`](./open-work/06-rate-limit-signal-findings.md).
Real lines preserved as a fixture (see [§3](#3-tests-test--co-located-srclibtestts)).

---

## Strategic review — findings & recommendations

| # | Finding | Recommendation | Status |
|---|---------|----------------|--------|
| **R1** | Design history (Tree 2) is **machine-local + referenced by absolute path** from in-repo handoffs. A fresh clone loses the canonical drain design + eng-review test plans. | Mirror the gstack design docs + eng-review test plans into the repo. | ✅ **resolved 2026-06-02** — mirrored into `docs/design/` (see its README). Re-mirror new docs each release. |
| **R2** | `docs/launch/LAUNCH-PLAN.md` + `RUNBOOK-stages-1-3.md` were a real deliverable but **untracked**. | Commit them. | ✅ **resolved 2026-06-02** — committed with the index. |
| **R3** | `.remember/` was leftover logs from the **disabled** `remember` plugin. | Delete the dir. | ⚠️ **superseded 2026-06-12** — the dir is back and is now **hook-managed** (a SessionStart hook writes session-continuity notes there; gitignored). Role clarified: `.remember/` = machine-local *session* memory (ephemeral, hook-owned, never authoritative); `docs/handoff/` = the *project* handoff (repo-owned, authoritative). Do not delete `.remember/` (the hook recreates it) and never treat its contents as project state. |
| **R4** | `classify.ts` is built on the **wrong premise** (stderr prose) — the real signal is the stream-json `rate_limit_event`, and was capturable from existing logs. | Reframe v0.8.2 item 5: parse `rate_limit_event.rate_limit_info` (session verified; weekly value still to capture); keep stderr regex as fallback. | ✅ captured in open-work/06 |
| **R5** | CLAUDE.md says "executor reacts to **stderr** signals" / "budget is indirect" — but a structured per-message `utilization`/`resetsAt`/`status` readout exists. | Update the load-bearing-constraint wording once the stream-json classifier lands; note proactive `allowed_warning` (90%) enables real anti-spill (item 3). | ⏳ |

---

## How to keep this map current

**This file is loaded by future sessions as the layout index — stale entries mislead.** Update it
whenever the structure changes (not behavior — that's the changelog's job):

1. **A file/dir is added, moved, deleted, or changes responsibility** → update the relevant table.
2. **A new tree/location appears** (new external store, new runtime dir) → update [§0](#0-the-three-trees-read-this-first).
3. **A strategic-review item (R#) is resolved** → flip its Status and add a one-line note.
3b. **A load-bearing or unverified decision is made/reversed** → add or supersede an ADR in `docs/decisions/` and tag the code site `ASSUMPTION[ADR-NNNN]` (see `docs/decisions/README.md`).
4. **On every release** → bump the "Last updated" line + reconcile LOC/test-count drift if material.
5. Commit map-only changes with `docs(map): <what changed>` (outside the brainstorm→spec→plan cycle, like ROADMAP).

> Keep it a **map, not a manual**: one line per file, link out for detail. If an entry needs a
> paragraph, that paragraph belongs in a spec/handoff this map links to.
