# Glean MVP — Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-23
**Author:** yonijhw@gmail.com (via brainstorming session)
**Scope:** First sub-project of the `glean` vision (see `glean.md`). This spec covers only the MVP slice described in `glean.md` §6. Worktree drafting, scheduling, GC, hooks, multi-project, and parallelism are out of scope and will get their own specs.

---

## 1. Goal and success criteria

Build the smallest end-to-end `glean` CLI that proves the concept: during the idle tail of the weekly Claude Pro/Max rate-limit window, consume spare capacity by spawning headless `claude -p` sessions to produce a curated "prep folder" of research dossiers and pre-fetched library docs for one project.

**MVP is done when:**

1. All 10 verification rows in §10 pass on Windows 11.
2. One real `glean run --project C:\Glean --budget 30m` produces ≥1 useful `OUT.md` against this very repo (dogfood).
3. Total LOC ≤ 1200.
4. README covers install, `config.json` setup, `glean run`, `glean stop`, where outputs land, manual discard.

## 2. Locked decisions (from prior brainstorm rounds)

These supersede any conflicting language in `glean.md`:

- **OS target:** Windows-first. macOS/Linux is post-MVP.
- **Language:** Node + TypeScript. `bin/glean` is a Node CLI; all `lib/*` are `.ts`. Shell-out only for `git` and `gh`.
- **Base branch resolution:** per-project, explicit, in `%USERPROFILE%\glean\config.json`. Unused in MVP (no `draft-impl`) but the config schema accepts it so v2 doesn't break.

**`config.json` schema (zod-validated):**

```ts
{
  claude_bin?: string;                 // path or binary name; defaults to "claude" on PATH
  projects?: {
    [absoluteProjectPath: string]: {
      base_branch?: string;            // accepted but UNUSED in MVP
    }
  };
}
```

Missing file → empty defaults. Schema violations → exit 1 with the zod error path.
- **Ranking:** heuristic-only for MVP (no upfront `claude -p` triage pass).
- **Process shape:** one command (`glean run`). `candidates.json` is a side-effect for debugging, not a separate stage.
- **Rate-limit policy:** stop the whole run immediately on first detected hit. No back-off ladder, no circuit breaker.
- **Dedup:** evidence-keyed, skip candidates whose `evidence_hash` matches a dossier output younger than 7 days.
- **Templates:** bundled in npm package, copied to `%USERPROFILE%\glean\templates\` on first run, user-editable thereafter. Missing template → fall back to bundled default.
- **`gh` CLI:** graceful skip with one-line warning if missing/unauthenticated. PR signals disappear; TODO + JSONL + deps signals still work.
- **`fetch-docs` source:** recently-added/touched dependencies in `package.json` / `requirements.txt` / `go.mod` / `Cargo.toml` / `pyproject.toml` over the last 14 days (per `git log`).
- **Cancellation:** Ctrl-C *and* STOP sentinel both supported. Both kill the entire child process tree via Windows Job Object.

## 3. Architecture overview

MVP CLI surface:

| Command | Purpose |
|---|---|
| `glean run --project <path> [--budget 60m] [--dry-run]` | Discovery + execution pipeline. `--dry-run` stops after `candidates.json` is written, before any `claude -p` spawn. |
| `glean stop` | Writes `%USERPROFILE%\glean\STOP`. Any active `glean run` notices between tasks and exits 30. No-op if no run is active. Idempotent. |
| `glean version` | Prints version, exits 0. |

`glean run` executes a single in-process pipeline:

```
parse-args → load-config → acquire-lock → discover → dedup → prioritize
                                                                ↓
                                       ┌── execute(serial) ────┘
                                       ↓
                            check STOP / budget / rate-limit between each task
                                       ↓
                                  write-summary → release-lock
```

**Module structure (option B from approach selection — per-spec §7 modular):**

- `bin/glean` — thin CLI entrypoint, dispatches to subcommand handlers
- `lib/types.ts` — shared TypeScript types
- `lib/config.ts` — load/validate `config.json`
- `lib/discover-jsonl.ts` — Claude Code session-history signals
- `lib/discover-git.ts` — `git grep` TODO/FIXME + `gh pr list`
- `lib/discover-deps.ts` — recently-touched package manifest entries
- `lib/dedup.ts` — evidence-hash skip against last 7 days of dossiers
- `lib/prioritize.ts` — rank by `est_value / log(est_tokens + 1)` × type weight
- `lib/executor.ts` — render template, spawn `claude -p`, capture output
- `lib/jobobject.ts` — Windows Job Object wrapper (quarantined OS-specific code)
- `lib/state.ts` — lock, sentinel, INDEX append, summary write
- `lib/render.ts` — tiny mustache-subset template renderer
- `templates/research-dossier.md`, `templates/fetch-docs.md` — bundled templates

## 4. Discovery

Three modules run in parallel via `Promise.all`. Each returns `Candidate[]`.

### 4.1 `discover-jsonl.ts`

- Compute the dash-encoded form of `--project` (Windows: `C:\Glean` → `C--Glean`). Glob `%USERPROFILE%\.claude\projects\<encoded>\*.jsonl`.
- For each file, stream-read to extract the *last non-empty line* without loading the whole file.
- Match the entry's `aiTitle` (when present) against `/\b(TODO|FIXME|fix|finish|continue|later|reminder)\b/i`.
- Emit `research-dossier` candidates with evidence `{kind: "jsonl", session_id, ai_title, idle_hours}`.

**Pre-implementation verification task:** read 2–3 real session files from `%USERPROFILE%\.claude\projects\` to confirm the fields we rely on (`aiTitle`, last-record shape, `cwd`). 10-min spike before coding this module.

### 4.2 `discover-git.ts`

- `git -C <project> grep -nE '(TODO|FIXME|XXX|HACK)\b' -- ':!node_modules' ':!dist' ':!build'`, capped at 200 hits via `| head -200` (we'll do this in Node, not shell).
- Group hits by file. Each unique file → one candidate with evidence `{kind: "todo", file, todo_lines: [{line, text}, ...]}`. Co-located hits in one file boost `est_value`, not candidate count.
- Probe `gh auth status`. If ok:
  - `gh pr list --author @me --state open --json number,title,url,updatedAt`.
  - For each PR, attempt to fetch unresolved review comments via `gh api repos/.../pulls/<n>/comments` (filtered to `in_reply_to_id == null` and no resolution). On per-PR failure (rate limit, network, missing perms) → emit the candidate anyway with `review_comments: []` and a warn log; do not block other PRs.
  - Each PR → one candidate with evidence `{kind: "pr", number, title, url, updated_at, review_comments: [...]}`.
- If `gh` missing/unauth: log `[warn] gh not available — skipping PR signals` once, return TODO candidates only.

### 4.3 `discover-deps.ts`

- For each supported manifest type (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml`), locate via glob.
- `git -C <project> log --since=14.days --oneline -- <manifest>` — skip if zero commits.
- `git -C <project> log -p --since=14.days -- <manifest>` — parse added lines per format:
  - `package.json` — JSON diff against the `dependencies` and `devDependencies` keys
  - `requirements.txt` — first whitespace-token of each added line
  - `go.mod` — entries inside `require ( ... )` blocks
  - `Cargo.toml` — entries under `[dependencies]` and `[dev-dependencies]`
  - `pyproject.toml` — entries under `[project.dependencies]` and `[tool.poetry.dependencies]`
- Emit one candidate per `(manifest_type, package_name)` with evidence `{kind: "dep", manifest, package, added_at}`.

## 5. Dedup, prioritization, budget

### 5.1 Evidence hash

```ts
evidence_hash = sha256(canonical_json({type, project_path, evidence_normalized}))
```

`evidence_normalized` strips volatile fields (timestamps, idle_hours) to keep the hash stable across runs.

### 5.2 `dedup.ts`

Reads INDEX.md frontmatter from `%USERPROFILE%\glean\dossiers\<proj>\*\INDEX.md` files within the last 7 days. Collects all `evidence_hash` values. Returns `{kept: Candidate[], skipped: string[]}` where `skipped` is hashes for the run summary.

### 5.3 `prioritize.ts`

- Per-type `est_value` heuristic:
  - `research-dossier` from TODO: `min(100, todo_count_in_file * 20 + file_recency_score)` where `file_recency_score = max(0, 30 - days_since_mtime)`
  - `research-dossier` from JSONL: `min(100, 30 + assistant_turn_count + idle_hours_bonus)` (idle_hours_bonus = `min(20, idle_hours)`)
  - `research-dossier` from PR: `min(100, 40 + unresolved_review_comments * 15 + days_open_capped)` (days_open capped at 14)
  - `fetch-docs`: fixed 30 (low precision, low cost)
- `est_tokens` = `template_bytes + evidence_excerpt_bytes * 1.3 / 4` (rough chars→tokens estimate, fine for ranking)
- Type weight: `research-dossier: 1.0`, `fetch-docs: 0.2`
- Score: `weight * (est_value / Math.log(est_tokens + 1))`, sort desc

### 5.4 Budget gates

- Wall-clock budget: `--budget 60m` default. Configurable via CLI flag.
- Per-task timeout: 8 min, terminated via Job Object.
- Last 30 min of budget → only `fetch-docs` candidates eligible (drain cheap work).
- Between every task, check: `budget_remaining > 0`, STOP sentinel absent, rate-limit circuit not tripped.

## 6. Executor

### 6.1 Per-task flow

1. Mark candidate `running` in `state/<run-id>/candidates.json`.
2. Determine `work_dir`:
   - `research-dossier` → `dossiers/<proj>/<date>/research-<slug>/`
   - `fetch-docs` → `dossiers/<proj>/<date>/docs/` (single shared dir, files named `<library>.md`)
3. **Hydrate evidence** with the heavy fields that discovery deliberately left empty:
   - `evidence.kind == "todo"` → read `±100 lines around the first TODO` from `evidence.file` (capped at 200 lines total) into `evidence.file_excerpt`.
   - `evidence.kind == "jsonl"` → tail the last 3 assistant turns from the session file into `evidence.recent_turns`, trimming each to 1KB.
   - `evidence.kind == "pr"` → already populated at discovery time (review_comments).
   - `evidence.kind == "dep"` → nothing extra to read.
   - Discovery stays cheap by skipping these reads; the executor hydrates only the candidates it's actually about to run.
4. Render template via `lib/render.ts` with hydrated evidence + a fixed safety footer.
5. Write `prompt.md` into `work_dir` (so it's archived alongside output).
6. Spawn `claude -p` (see §6.2) with stdout → `logs/<run-id>/<task-id>.jsonl` and stderr → `logs/<run-id>/<task-id>.stderr` (also tee'd through a rate-limit pattern stream).
7. On clean exit:
   - `research-dossier` → expect `OUT.md` in `work_dir`. If missing or <100 bytes, fall back to extracting the last assistant text from the stream-json log; mark `status: "ok-fallback"`.
   - `fetch-docs` → expect `docs/<library>.md`. Same fallback rules.
   - Append entry to date's `INDEX.md`.
8. On timeout: kill Job Object, mark `status: "timeout"`, continue.
9. On rate-limit pattern: kill Job Object, set circuit, mark `status: "rate-limit"`, halt loop.
10. On non-zero exit without rate-limit: mark `status: "failed"`, log last 50 stderr lines, continue.

### 6.2 `claude -p` invocation

```
<claude_bin> -p "<prompt>" \
  --output-format stream-json --include-partial-messages \
  --add-dir "<work_dir>" \
  --permission-mode acceptEdits \
  --disallowedTools "Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*)" \
  --session-id <uuid>
```

`claude_bin` defaults to `claude` on PATH; overridable in `config.json` (`claude_bin`). Spawned via `child_process.spawn`, attached to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so the child tree dies with the orchestrator.

### 6.3 Rate-limit detection

Regex on stderr stream (matches first occurrence):

```
/(rate limit|429|usage limit|5-hour limit|weekly limit)/i
```

First match → kill Job Object, set `circuit_tripped = true`, return `{status: "rate-limit"}` to caller, executor halts loop. `summary.json.reason = "rate-limit"`, exit code 20.

## 7. File layout

```
%USERPROFILE%\glean\
  config.json                        # per-project base_branch (v2-ready), claude_bin override
  STOP                               # sentinel: presence = halt between tasks
  templates\                         # copied from package on first run
    research-dossier.md
    fetch-docs.md
  state\
    RUN.lock                         # JSON: {pid, started_at, run_id} — exclusive
    <run-id>\
      candidates.json                # discovered + ranked; written before execute loop
      summary.json                   # RunSummary; written on every exit path incl. crash
  logs\
    <run-id>\
      orchestrator.log               # ndjson event log
      <task-id>.jsonl                # raw claude -p stream-json output
      <task-id>.stderr               # raw stderr (rate-limit signal source of truth)
  dossiers\
    <project-slug>\<YYYY-MM-DD>\
      INDEX.md                       # human-facing menu, frontmatter has evidence_hashes
      research-<slug>\
        prompt.md                    # rendered prompt that was sent
        OUT.md                       # produced output
      docs\
        <library>.md                 # one file per fetch-docs task
```

`<project-slug>` = `basename(--project).toLowerCase().replace(/[^a-z0-9]+/g, '-')`. Collisions get a `-<short-hash>` suffix recorded in `candidates.json`.

### 7.1 INDEX.md format

```markdown
---
run_id: 2026-05-23-1830-abc
project_path: C:\Glean
generated_at: 2026-05-23T18:47:11-04:00
entries:
  - task_id: 8e7c…
    evidence_hash: a3f1…
    type: research-dossier
    title: "Handle null in lib/foo.ts"
    output: research-lib-foo-ts-null/OUT.md
    status: ok
---

# Glean dossier — 2026-05-23

1. **Handle null in lib/foo.ts** (research-dossier) — est. value 72
   - Evidence: TODO at `lib/foo.ts:42`
   - Read: `research-lib-foo-ts-null/OUT.md` (3-line abstract pulled from OUT.md)
   - Discard: `rmdir /s /q "%USERPROFILE%\glean\dossiers\C-Glean\2026-05-23\research-lib-foo-ts-null"`
```

### 7.2 Event log format

`logs/<run-id>/orchestrator.log` — one JSON object per line:

```json
{"t":"2026-05-23T18:30:00Z","evt":"run.start","run_id":"…","project":"C:\\Glean","budget_ms":3600000}
{"t":"2026-05-23T18:30:02Z","evt":"discover.done","jsonl":4,"git":12,"deps":3}
{"t":"2026-05-23T18:30:02Z","evt":"dedup.done","kept":11,"skipped":8}
{"t":"2026-05-23T18:30:02Z","evt":"rank.done","top":[{"id":"…","score":4.2}]}
{"t":"2026-05-23T18:30:03Z","evt":"task.start","task_id":"…","type":"research-dossier"}
{"t":"2026-05-23T18:37:41Z","evt":"task.end","task_id":"…","status":"ok","elapsed_ms":458000}
{"t":"2026-05-23T18:37:41Z","evt":"halt.check","stop_sentinel":false,"budget_remaining_ms":3140000,"circuit":false}
{"t":"2026-05-23T18:42:55Z","evt":"rate_limit.detected","pattern":"5-hour limit","task_id":"…"}
{"t":"2026-05-23T18:42:55Z","evt":"run.end","reason":"rate-limit","ran":2,"timed_out":0,"failed":0}
```

### 7.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | `completed` or `no-candidates` |
| 10 | `budget-exhausted` |
| 20 | `rate-limit` |
| 30 | `stop-sentinel` |
| 40 | `lock-busy` |
| 1 | uncaught/unexpected (still writes `summary.json`) |

## 8. Templates

Bundled in the npm package under `templates/`. On first run, if `%USERPROFILE%\glean\templates\` is empty/missing, glean copies the bundled defaults. Users may edit thereafter; missing/broken templates fall back to bundled.

### 8.1 Template syntax

A tiny mustache subset implemented in `lib/render.ts`:

- `{{path.to.value}}` — looks up nested values; missing values render as literal `{{path.to.value}}` and log a warn
- `{{#if expr}} … {{else if expr}} … {{/if}}` — basic conditional (`expr` is `path == "literal"` only)
- Filters: `{{x | join_lines}}`, `{{x | bullet_list}}`, `{{x | quote}}`, `{{x | slug}}` — fixed allowlist

No code execution, no shelling out, no loops over arrays (filters handle the arrays we care about).

### 8.2 `templates/research-dossier.md`

```markdown
# Research dossier: {{title}}

You are doing speculative prep work between Claude Code sessions. Produce a
focused research note that will save the user time when they next sit down
to work on this.

## Context
- Project: {{project_path}}
- Evidence type: {{evidence.kind}}
{{#if evidence.kind == "todo"}}
- TODO source: `{{evidence.file}}` (lines: {{evidence.todo_lines | join_lines}})
- Surrounding code (≤200 lines):
```
{{evidence.file_excerpt}}
```
{{else if evidence.kind == "pr"}}
- Open PR #{{evidence.number}}: {{evidence.title}} ({{evidence.url}})
- Unresolved review comments:
{{evidence.review_comments | bullet_list}}
{{else if evidence.kind == "jsonl"}}
- Last session title: {{evidence.ai_title}}
- Session was idle {{evidence.idle_hours}}h
- Recent assistant turns (last 3, trimmed):
{{evidence.recent_turns | quote}}
{{/if}}

## Task
Write `OUT.md` in the current working directory with these sections:
1. **One-paragraph summary** — what this is and what the user should do next.
2. **Findings** — 3–7 concrete observations from reading the code/context.
3. **Suggested next actions** — ranked, each with the specific file/line.
4. **Open questions** — what you couldn't determine without running the code.

## Rules
- Speculative work only. Do NOT make production-affecting changes.
- Do NOT run `git push`, `git checkout main`, or any `gh pr` mutation.
- Read freely; write only `OUT.md` in the current working directory.
- If you cannot do useful work, write a one-paragraph `OUT.md` explaining why.
```

### 8.3 `templates/fetch-docs.md`

```markdown
# Pre-fetch docs: {{evidence.package}}

The user recently added `{{evidence.package}}` to `{{evidence.manifest}}`
({{evidence.added_at}}). Pre-fetch the most useful documentation so they
can read it offline next session.

## Task
1. Use the context7 MCP: resolve the library id, then fetch docs.
2. Write the docs to `docs/{{evidence.package | slug}}.md` in the current
   working directory.
3. Add a 5-line "what's covered" preamble at the top.

## Rules
- Read-only operation. No code edits.
- If context7 cannot resolve the library, write a one-paragraph note in
  `docs/{{evidence.package | slug}}.md` explaining the failure.
```

## 9. Error handling matrix

| Failure | Where caught | Behavior |
|---|---|---|
| `claude` binary not on PATH | startup probe | exit early with install hint, no run state created |
| Lock held by live process | `acquireLock` | exit code 40, no state mutation |
| Lock held by dead PID | `acquireLock` | log `lock.stale_recovered`, take lock, continue |
| `--project` path doesn't exist or isn't a git repo | startup | exit 1 with message |
| `~/.claude/projects/<encoded>/` missing | `discover-jsonl` | empty array, info log |
| `gh` missing/unauthenticated | `discover-git` | warn once, return TODO candidates only |
| Manifest exists but no git history | `discover-deps` | empty array, no warn |
| Discovery returns zero candidates | after dedup | `summary.json.reason = "no-candidates"`, exit 0 |
| Template file missing after first-run copy | `executor` | warn, re-copy bundled default, retry once |
| Job Object spawn fails | `executor` | mark task `failed`, log, continue to next task |
| `claude -p` exits non-zero, no rate-limit signal | `executor` | mark task `failed`, log last 50 stderr lines, continue |
| 8-min task timeout | `executor` | kill job, mark `timeout`, continue |
| Rate-limit pattern in stderr | `executor` | kill job, set circuit, halt loop, exit 20 |
| STOP sentinel appears | between tasks | halt loop, exit 30 |
| Budget exhausted | between tasks | halt loop, exit 10 |
| Uncaught exception | `process.on('uncaughtException')` | write `summary.json` with `reason: "crashed"`, release lock, exit 1 |
| `process.on('exit')` | always | best-effort release lock, flush `orchestrator.log` |

### 9.1 Edge cases

1. **Same TODO appears in 5 files** → 5 candidates (one per file). Acceptable.
2. **Dash-encoded path collision** (`C:\foo-bar` vs `C:\foo\bar`) → read first JSONL record's `cwd` to disambiguate; skip non-matching session files. Documented caveat.
3. **`OUT.md` written outside `--add-dir`** → deny-list doesn't restrict by path; executor logs warn, INDEX entry shows empty.
4. **Concurrent same-day runs** → prevented by `RUN.lock`. Stale-lock recovery checks PID liveness.
5. **User-edited template references unknown variable** → renderer leaves `{{var}}` literal, logs warn; Claude still produces output.
6. **Empty `OUT.md`** → executor treats <100 bytes as failure, falls back to last assistant text from stream-json log, marks `status: "ok-fallback"`.

### 9.2 Deliberate non-features

- **No resume-after-crash.** Stale-lock recovery only lets you re-run; the old run is abandoned. Resume is v2.
- **No back-off / circuit breaker beyond first hit.** First rate-limit → stop.
- **No `--parallel` flag.** `max_parallel` is hard-coded to 1.
- **No `glean discard` / `glean gc` / `glean schedule` / `glean peek`** in MVP.

## 10. Verification plan

| # | Verification | How | Burns capacity? |
|---|---|---|---|
| 1 | Discovery + ranking produce sane candidates | `glean run --project C:\some-repo --dry-run`; inspect `candidates.json` | No |
| 2 | One full task end-to-end | `glean run --project C:\some-repo --budget 15m`; expect ≥1 `OUT.md` ≥100 bytes | Yes (small) |
| 3 | Budget self-termination | `glean run --project ... --budget 2m`; expect `summary.json.reason == "budget-exhausted"`, exit 10 | Yes (small) |
| 4 | STOP sentinel | Start run; `glean stop` from another shell; expect exit 30 within one task duration | Yes (small) |
| 5 | Rate-limit simulation | Point `claude_bin` to a stub that prints `5-hour limit` to stderr; expect exit 20, `summary.json.reason == "rate-limit"`, no further spawns | No |
| 6 | Dedup skips recent outputs | Run twice; second `candidates.json` shows `skipped_dedup` = first run's emitted count | Yes (first run) |
| 7 | Lock prevents concurrent runs | Start long run; second `glean run` exits 40 immediately, doesn't touch state | No |
| 8 | Job Object kills children | Start run; `taskkill /PID <node-pid> /F`; expect no orphan `claude.exe` after 10s | Yes (small) |
| 9 | `gh` missing degrades cleanly | Rename `gh.exe` on PATH; run; expect one-line warn, non-PR candidates still produced | Yes (small) |
| 10 | Crash recovery via stale-lock | Kill node mid-run with `/F`; re-run; expect `lock.stale_recovered` event, fresh run | Yes (small) |

### 10.1 `claude -p` test stub

`test/fixtures/fake-claude.cmd` (Windows) and `.sh` mirror reads a YAML scenario: `{exit_code, stdout_stream_json, stderr_lines, sleep_ms}`. Tests point `claude_bin` at the stub via tmpdir config. No real Anthropic calls in test suite.

## 11. Dependencies

**Runtime:**

- `citty` — CLI arg parsing
- `fast-glob` — filesystem globbing
- `yaml` — INDEX.md frontmatter
- `zod` — config + candidates.json schema validation
- `uuid` — task ids
- (No templating library — `lib/render.ts` is ~30 lines of mustache subset.)
- (No `execa` — raw `child_process.spawn` so Job Object attaches cleanly.)

**Native (decision deferred to implementation plan):**

- `windows-kill` *or* a small custom N-API job-object module *or* shelling to `taskkill /T /F` as a last-resort fallback. 30-min spike picks one.

**Dev:**

- `typescript`, `tsx` (dev-time TS execution), `vitest`, `eslint`, `prettier`

## 12. Build and distribution

- TypeScript compiled to `dist/` via `tsc`. `bin/glean` is a thin JS shim that `require`s `dist/cli.js`. Windows `.cmd` shim is auto-generated by npm on install.
- MVP install: `npm install -g .` from the repo. No npm publish in MVP.

## 13. Open work before implementation

1. **JSONL format spike** (10 min) — read 2–3 real session files to confirm `aiTitle`, last-record shape, `cwd` fields exist as expected.
2. **Job Object approach spike** (30 min) — choose `windows-kill` vs custom N-API vs `taskkill /T` fallback.

## 14. Out of scope (sub-projects for later specs)

- `draft-impl` candidate type + worktree machinery
- `glean schedule` + Windows Task Scheduler
- `glean discard`, `glean gc`, `glean peek` subcommands
- SessionStart hook
- Rate-limit back-off ladder + circuit breaker
- Resume-after-crash
- Notion / external dossier mirroring
- macOS/Linux scheduling primitives
- Multi-project per run
- Parallelism

Each of these gets its own spec → plan → implementation cycle.

---

*Brainstorm session: 2026-05-23. Five-section design walkthrough approved before this doc was written.*
