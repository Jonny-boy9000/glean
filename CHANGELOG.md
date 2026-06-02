# Changelog

## v0.8.1 — 2026-06-02

Drain UX polish: the scheduler is correct out of the box wherever you are, a run's outcome is now a durable shareable artifact, and the README finally matches the tool you'd install today.

### Added
- **Work-week-aware schedule default.** `glean schedule enable` now derives the trigger day from your system timezone — Thursday for Israel's Sun–Thu work week, Friday otherwise — and prints the resolved choice plus the one-flag override. `--day` and `config.drain_trigger.day` still win. (Was hardcoded Thursday.)
- **Shareable `RECEIPT.md`.** Every run/drain window now writes a durable Markdown receipt (project + capacity outcome + totals: N branches / M dossiers / +X/−Y / minutes drained, then per-item detail) to the date-dossier dir, so the "while you slept" result survives the terminal and pastes cleanly into a PR/Slack. `glean morning --md` prints it to stdout.

### Changed
- README rewritten to v0.8 reality: npm install (`npm i -g @jonny-boy9000/glean`), a commands table, the drain core + draft-impl + scheduler in "How it works", corrected FAQs (drain pause/resume, draft-impl shipped, scheduling shipped), and the real `base_branch`/`test_command`/`drain_trigger` config.

### Internal
- `defaultTriggerDay(tz)` is a pure, timezone-injected unit; `PLAIN`/`outcomeLine` exported from render-morning so the markdown receipt reuses the one honesty switch (only a real weekly-limit signal claims "drained weekly capacity"). 352 tests passing. Independent review: PASS, no critical/important findings.

## v0.8.0 — 2026-06-02

The drain core (first slice). `glean` can now consume a whole weekend's leftover Claude capacity unattended, instead of stopping on the first rate-limit. It works by **exit-and-re-enter**: each run is a bounded burst that, on a 5-hour session limit, saves its place and exits; a Windows Task Scheduler trigger re-launches it after the window reopens, across the several 5-hour windows between Thursday evening and the weekly reset. The Monday `glean morning` receipt aggregates the whole weekend. (Robustness polish — circuit-breaker tuning, mid-weekend re-discovery, anti-spill margin, `today`/`peek` window views — is deferred to v0.8.1.)

### Added
- **`glean run --drain`.** Wraps a normal run in the drain window state machine: a lock-free eligibility guard (a no-op tick exits before any side effect), a classified rate-limit fold, a stable-`evidence_hash` resume cursor so a re-entry never redoes completed work, and a no-progress backstop. The bare `glean run` path is unchanged.
- **`glean schedule enable|disable|status`.** Registers one Windows Scheduled Task (`Glean\Drain`) via PowerShell `Register-ScheduledTask`: weekly Thursday-evening trigger repeating across the drain weekend, battery-safe (`AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries`), `StartWhenAvailable`, `MultipleInstances IgnoreNew`, "run only when logged on". The scheduled action invokes `node bin/glean.js` directly (not the `.cmd` shim). Off by default. Configurable via `drain_trigger` in `config.json`.
- **Rate-limit signal classifier.** Reads the reset horizon from `claude -p` stderr and classifies session (<6h, pause and resume) vs weekly (>=6h, stop and report "drained weekly capacity") vs ambiguous (fail-safe). Horizon-first, so it degrades gracefully on an unrecognized format.
- **`glean morning` window aggregation.** The receipt now stitches every burst in the drain window into one summary (branches + dossiers across the weekend) and reports honest coverage ("woke for N bursts"). Only a real weekly-limit signal may claim "drained weekly capacity".

### Changed
- Drain state persists in a single atomic `state/budget.json` (`next_eligible_at`, `week_exhausted`, resume cursor). `glean stop` is timestamp-scoped, so it halts the current weekend without permanently disabling future ones. `acquireLock` now reclaims a lock older than 20 minutes. All drain timestamps are UTC.

### Verified
- Both make-or-break gates cleared empirically before building: no headless `claude usage` query exists (so the stderr classifier is required), and `claude -p` authenticates under a Task Scheduler context (so the re-launch model works). Integration test `v21` drives the real CLI through a session pause -> no-op tick -> resume loop and a weekly stop. Load-bearing constraints unchanged: subscription-auth only, read-only against `main`, deny-list on every spawn.

## v0.7.1 — 2026-06-01

`glean morning` — a "while you slept" receipt that narrates the most recent run (draft branches with diff stats and a verified test status, dossiers, and an honest outcome line). Second of the two v0.7 PRs.

### Added
- **`glean morning` subcommand.** Renders the latest run as a terminal receipt: each draft-impl branch shows its diff stat, a deterministic test status, the `cd`-to-review command, the worktree-remove discard command, and a "your main was never touched" line. Dossiers render today-style. Silent-degrades to a friendly message when there is no recent run.
- **Deterministic draft-impl test status.** After a draft commits, glean runs the project's per-project `test_command` inside the worktree itself and records `pass`/`fail`/`none`. The test run is bounded by the remaining `--budget` and skipped on the STOP sentinel, so it can never overrun the run. Environment/setup failures (e.g. a fresh worktree with no `node_modules`) are reported as `none`, never a misleading `fail`; only a suite that genuinely ran and failed shows `fail`. A salvaged partial draft (session killed by timeout/rate-limit) is not trusted — reported as `none`.

### Changed
- Memory schema migrated to v5 (`draft_tests` column; idempotent).
- `.gitattributes` added (`* text=auto eol=lf`) to normalize line endings.

### Honesty
- The receipt reports only test status glean verified itself, and never claims it "drained your weekly capacity" — the weekly-drain engine is deferred to v0.8 (exit-and-re-enter), not v0.7.

## v0.7.0 — 2026-06-01

`draft-impl` — glean can now write speculative *code* into an isolated branch you review, not just research dossiers. The top-ranked TODO in a project with a configured `base_branch` gets implemented in a `git worktree` on a `prep/glean-*` branch; your main checkout is never touched.

### Added
- **`draft-impl` candidate type.** For the highest-value TODO, glean provisions a `git worktree` on `prep/glean-<id>` off the project's `base_branch`, spawns a headless `claude -p` session scoped to that worktree, and captures the resulting diff. Review by `cd`-ing into the worktree; the dossier `INDEX.md` prints the review and discard commands. Requires `base_branch` set per project in `config.json` — skipped with a warning otherwise.
- **`glean gc`** subcommand — prunes draft-impl worktrees and their `prep/glean-*` branches older than 21 days. Also runs automatically at the start of each `glean run`.

### Changed
- draft-impl `claude -p` sessions run under a scoped tool allow-list (Edit/Write plus `git add`/`commit`/`status`/`diff` and the project's test command only) instead of broad Bash. A draft session can stage, commit, and test inside its worktree and nothing else. The test command is configurable per project via `test_command` in `config.json`.
- `TaskResult.output` is now a discriminated `file | branch` union so a draft branch is represented explicitly rather than overloaded onto a file path. Memory schema migrated to v4 with draft-impl diff-stat columns (migration is idempotent against half-applied databases).

### Safety
- The draft-impl trust boundary is enforced by the tool allow-list, not just a deny-list: bare `Bash` is never granted, so a draft session cannot run `git -C <main> …`, `git push`, or raw filesystem writes outside its worktree. The deny-list (`git -C`/`--git-dir`/`--work-tree`, push, switch, branch, reset, worktree, `gh pr` create/merge) is retained as defense-in-depth.

## v0.6.0 — 2026-05-26

`glean peek` subcommand plus a SessionStart hook recipe — closes the compound-memory-across-sessions loop.

### Added
- `glean peek` subcommand. CWD-scoped variant of `glean today`. Walks up from the current directory to find the enclosing git repo, slugs the root, and prints just that project's today-dossier using the existing renderer. Silent exit (0) when nothing applies — no `.git`, no matching dossier, any error: all degrade to empty stdout + exit 0.
- New module `src/lib/peek.ts` exporting `findGitRoot(start)` and `findPeekDossier(gleanRoot, cwd)`.
- `projectSlug` helper extracted from inline copies in `pipeline.ts` and `executor.ts` to a single shared export in `src/lib/state.ts`. No behavior change.

### SessionStart hook recipe
Add this to `~/.claude/settings.json` (or merge into your existing `hooks` object):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "glean peek" }
        ]
      }
    ]
  }
}
```

Whenever you start a new Claude Code session inside a repo with a recent dossier, the hook runs `glean peek` and the dossier lands in the session's initial context. No dossier = empty output = no injection.

### Why
v0.5.0 made telemetry visible via `glean today`. v0.6.0 closes the dossier-as-compound-memory loop: every new Claude session in a repo with a recent dossier starts pre-loaded with that context. The user no longer has to remember to `cat` an INDEX file.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. No schema change, no engine change. The `projectSlug` refactor is behaviorally identical (both inline copies were byte-identical). Peek's exit-0-silent contract is unconditional — any error in walk-up, scan, or render produces empty stdout, never a hook failure.

### Tests
- Suite: 136 + 1 skip → 143 + 1 skip.
- 4 new tests in `src/lib/peek.test.ts` (findGitRoot walk-up × 2, findPeekDossier match + no-match).
- 3 new tests in `test/integration/v17-peek.test.ts` (in-repo with dossier, no .git, no matching dossier).

## v0.5.0 — 2026-05-26

`glean today` enriched with telemetry from `memory.db`. Closes the feedback loop: v0.3.0's passive sweep and v0.4.0's active ratings now become visible at the same place the user looks every day.

### Added
- Optional third line per entry in `glean today` output. Surfaces: duration (e.g. `12m`), output bytes (e.g. `4.2KB`), rate-limit hits (only when > 0, e.g. `1 rate-limit hit`), and user rating (e.g. `rated: kept` / `rated: discarded`). Bullet-separated, dim by default, with green/red color for the rating segment.
- New `Memory.findEnrichmentsBySlugs(slugs)` method — single batched lookup keyed by candidate slug.
- `task_id` is now preserved on `IndexEntry` (from the existing INDEX.md frontmatter). Used as the join key with memory.db.

### Why
Until this release, the data from v0.3.0 (dossier-existence sweep) and v0.4.0 (`glean rate`) accumulated silently in `memory.db` with no daily-rhythm surface. `glean today` now shows what the engine knows about each dossier without changing the existing two-line layout — the third line only appears when there's something to show.

### Compatibility
Non-breaking. Same CLI surface, same exit codes, same empty-case message. Silent degradation when `memory.db` is missing or unreadable — entries render as in v0.2.1 with no warning. Failed/no-output entries get no enrichment line (timing without context is misleading). The `dossier_existed_at_7d` column is still populated by the v0.3.0 sweep but is NOT shown in this release — it's always NULL for today's brand-new entries; a future historical-viewer subproject will surface it for past dates.

INDEX.md entries without a `task_id` field are now silently skipped at parse time. In practice every entry written since v0.1.0-mvp has had `task_id` — this is a defensive guard against corrupt files.

### Tests
- Suite: 126 + 1 skip → 136 + 1 skip.
- 2 new tests in `src/lib/memory.test.ts` (`findEnrichmentsBySlugs` matching and empty-input).
- 4 new tests in `src/lib/today.test.ts` (task_id preservation × 2; enrichment merge × 2).
- 4 new tests in `src/lib/render-today.test.ts` (enrichment line plain × 2; color × 1; no-output exclusion × 1).
- Existing `test/integration/v15-today.test.ts` extended to seed memory.db and assert the enrichment line.

## v0.4.0 — 2026-05-26

Active usefulness telemetry. Closes the active half of the dossier-quality feedback loop, complementing v0.3.0's passive sweep.

### Added
- `glean rate <id> <kept|discarded|actioned>` subcommand. Writes an explicit user verdict to a new `user_rating` column in `memory.db`. Ratings are mutable — re-rating overwrites the previous value, and `user_rating_at` tracks the latest write.
- `glean rate --list` flag. Prints the last 20 ratable dossiers (settled candidates with dossier paths) so the user can find what to rate. ANSI-colored when interactive, plain when piped.
- Schema migration `v3` (auto-applied on first open): adds `user_rating TEXT` and `user_rating_at INTEGER` columns to `candidates`.
- New module `src/lib/rate.ts` exporting the pure `renderRateList` formatter.
- Two new `Memory` methods: `setUserRating(candidateId, rating)` and `listRecentRatableCandidates(limit)`.

### Why
The v0.3.0 sweep captures a passive signal — "did the dossier file still exist after 7 days." That's slow (7-day latency) and noisy (you might keep files you never opened). `glean rate` adds the explicit, immediate ground truth. The two telemetry types are complementary: passive = default behavior, active = deliberate verdict. The eventual ranker will combine both.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. Schema migration is automatic and idempotent on first open. Ratings are mutable; the latest rating wins, previous values are not retained. To wipe ratings only: `sqlite3 %USERPROFILE%\glean\memory.db "UPDATE candidates SET user_rating = NULL, user_rating_at = NULL"`.

### Tests
- Suite: 115 + 1 skip → 126 + 1 skip.
- 6 new tests in `src/lib/memory.test.ts` (migration v3 fresh + v2→v3 upgrade, setUserRating success + failure, re-rating, listRecentRatableCandidates filtering/ordering).
- 3 new tests in `src/lib/rate.test.ts` (empty, plain, color).
- 2 new tests in `test/integration/v16-rate.test.ts` (round-trip, invalid verdict exits 1).

## v0.3.0 — 2026-05-26

Passive usefulness telemetry — first step in closing the dossier-quality feedback loop.

### Added
- Dossier-existence sweep. Every `glean run` now starts with a pass over historical `candidates` rows (7+ days old, `dossier_path` set). For each, `existsSync` checks whether the dossier file is still on disk and writes the result to a new `dossier_existed_at_7d` column. Captures the implicit kept-vs-discarded signal with zero user action.
- Schema migration `v2` (auto-applied on first open): `ALTER TABLE candidates ADD COLUMN dossier_existed_at_7d INTEGER`.
- New module `src/lib/sweep.ts` exporting `runDossierExistenceSweep` and `SWEEP_AGE_MS`.
- Two new `Memory` methods: `findCandidatesNeedingSweep(beforeMs)` and `markDossierExists(candidateId, exists)` (write-once guarded).
- Sweep results logged to the existing orchestrator log via `appendOrchestratorLog({evt: 'sweep.done', checked, kept, discarded})`.

### Why
The engine has accumulated run history since v0.2.0 but has no measure of whether the dossiers it produces are actually useful. This release captures the cheapest possible signal — does the file still exist 7 days later — without asking anything of the user. Pairs with the forthcoming `glean rate` (Up next #1) for explicit ratings, and `glean today` enriched with memory.db (Up next #2) to surface both signals back.

### Compatibility
Non-breaking. Same CLI surface, same config schema. Schema migration is automatic and idempotent on first open. Sweep failures emit `[memory] warning: sweep failed: ...` to stderr and do not affect the run. Pre-v0.3.0 candidate rows that have already passed the 7-day mark stay `NULL` forever — no retroactive sweep. To wipe sweep data only (keep substrate): `sqlite3 %USERPROFILE%\glean\memory.db "UPDATE candidates SET dossier_existed_at_7d = NULL"`.

### Tests
- Suite: 105 + 1 skip → 115 + 1 skip.
- 4 new tests in `src/lib/memory.test.ts` covering migration v2 and the two new methods.
- 6 new tests in `src/lib/sweep.test.ts` covering the orchestrator (empty, kept, discarded, too-recent, already-swept, existsSync-throws).

## v0.2.1 — 2026-05-26

Read-only terminal view for daily dossiers.

### Added
- `glean today` subcommand. Scans `~/glean/dossiers/*/<today>/INDEX.md` across all projects, parses each YAML frontmatter, and prints a grouped report to stdout. ANSI-colored when interactive (`process.stdout.isTTY`), plain when piped or redirected. No flags in this release.
- New modules `src/lib/today.ts` (scanner — returns a structured `TodayReport`) and `src/lib/render-today.ts` (formatter — takes report + `useColor`, returns the string to print). Pure, side-effect-free, fully unit-tested.

### Why
The previous consumption surface was "open `~/glean/dossiers/<project>/<date>/INDEX.md` in an editor." `glean today` collapses that to a single command. This is the terminal slice of the broader "Output adapters" Tracked item; the Notion / Slack / email mirrors remain deferred.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. No engine changes — `pipeline.ts`, `executor.ts`, discovery modules, and `memory.db` are untouched. Empty-case (`No glean dossiers for <date>.`) exits 0.

### Tests
- Suite: 95 + 1 skip → 105 + 1 skip.
- 4 new scanner unit tests in `src/lib/today.test.ts`.
- 4 new formatter unit tests in `src/lib/render-today.test.ts`.
- 2 new CLI integration tests in `test/integration/v15-today.test.ts`.

## v0.2.0 — 2026-05-25

Persistent memory substrate. Pure infrastructure release — no CLI surface, no behavior change to discovery/prioritization/execution.

### Added
- SQLite-backed run/candidate history store at `%USERPROFILE%\glean\memory.db`. Every `glean run` now records run metadata (project, budget, exit reason, timing) and per-candidate outcomes (rank, fingerprint, status, dossier size, duration).
- New module `src/lib/memory.ts` exporting the `Memory` class and the `fingerprintCandidate` pure function. Stable cross-run identity via SHA-256 over project + type + file + normalized title.
- Schema migration `v1` creates `runs` and `candidates` tables with indexes on `fingerprint`, `run_id`, and `started_at`. Designed for breadth: supports three future learning loops (suppress recurring duds, rank by realized value, adapt budgets/timeouts) without committing to any of them now.
- `better-sqlite3` runtime dependency. Prebuilt Windows x64 + Node 20 binaries install cleanly via `npm install`.

### Why
Every `glean run` previously rebuilt context from scratch and discarded everything. The substrate must exist *before* any learning loop is built on top, because retrofitting memory after-the-fact requires re-running historical data that will have already been discarded.

### Compatibility
Non-breaking. Same CLI surface, same config schema. Existing runs continue to work; memory accumulation begins from `0.2.0` forward. If `memory.db` cannot be opened (locked, corrupt, permissions), a `[memory] warning:` is logged to stderr and the run continues normally — the engine never regresses on a memory failure. To wipe history, delete `%USERPROFILE%\glean\memory.db`.

### Tests
- Suite: 81 + 1 skip → 95 + 1 skip.
- 10 new unit tests in `src/lib/memory.test.ts` cover fingerprint stability, schema migration, run lifecycle, and candidate lifecycle.
- 1 new test in `src/lib/executor.test.ts` verifies the optional `recordOutcome` callback fires exactly once per task.
- 1 new test in `src/lib/pipeline.test.ts` verifies end-to-end DB writes through `runPipeline`.
- 1 new integration test `test/integration/v13-memory.test.ts` spawns the full CLI and asserts `runs`/`candidates` rows.
- 1 new integration test `test/integration/v14-memory-failure.test.ts` verifies an unwritable `memory.db` produces a warning but does not break the run.

## v0.1.2 — 2026-05-25

Single-issue quality patch from the v0.1.1 dogfood findings.

### Fixed
- `discover-deps` no longer emits spurious `fetch-docs` candidates for top-level manifest fields like `name`, `version`, `description`, `scripts`, `bin`. The parser is rewritten to use full-file parsing at git boundaries: it loads the manifest at the pre-window and current commits, parses both with proper parsers (JSON.parse for `package.json`, `smol-toml` for `Cargo.toml`/`pyproject.toml`, regex for `go.mod`/`requirements.txt`), and emits candidates for packages present in current dependency sections that weren't there at window-start. Fixes 32 of 35 spurious candidates from the v0.1.1 dogfood.

### Added
- `smol-toml` runtime dependency (~10KB) for `Cargo.toml` and `pyproject.toml` parsing.

### Tests
- Suite: 78 + 1 skip → 81 + 1 skip.
- 3 new tests verify section scoping for `package.json`, `Cargo.toml`, `pyproject.toml`.

## v0.1.1 — 2026-05-24

Quality patch driven by the v0.1.0 dogfood findings.

### Added
- `glean repair [--run-id <id>] [--days <n>]` subcommand — recovers empty OUT.md files by re-extracting assistant text from the matching JSONL log. No Claude spawn, no capacity burn.
- `--task-timeout` flag on `glean run` (default `8m`). Accepts `s`, `m`, `h` suffixes (e.g. `30s`, `8m`, `1h`).
- Multi-signal JSONL discovery: in addition to TODO-titled sessions, a candidate is now emitted when the last assistant turn is an unfinished tool use, OR when a session has >10 assistant turns and >24h idle.
- Auto-repair pass: every `glean run` now scans the last 7 days of dossiers for empty OUT.md and recovers them silently before discovery.
- Soft path-weighting in prioritizer: TODOs in `vendor/`, `third_party/`, `*.config.*`, and `*.lock` files now score at 70% of equivalents in normal source paths.

### Changed
- Scanner excludes more noise paths: TODOs in `*.md`, `*.test.*`, `docs/**`, `test/**`, `**/fixtures/**`, `*.min.*`, `*.generated.*`, `*-lock.*`, and `*.lock` are no longer emitted as candidates.

### Fixed
- Executor no longer leaks `setTimeout` handles on early task exit (timer cleared via try/finally).
- Executor no longer collides "child exited with code -2" with "task timed out" — the sentinel is now a typed flag, not a magic number.
- Slug collisions when multiple TODOs share a file: dossier dirs now include the line number (`research-handle-todo-in-foo-ts-L42` vs `…-L99`).
- `discover-deps` now picks up packages from manifests that were ADDED (not just modified) in the last 14 days — the `git log --diff-filter` was overly strict.
- `glean repair` now correctly resolves absolute output paths stored in INDEX.md (v0.1.0 wrote absolute paths; `path.join` on Windows silently produced wrong paths as a subpath instead of using the absolute path directly).

### Tests
- v03-budget integration test revived using the new `--task-timeout 2s` (was `.skip` due to 8-min runtime).
- New `jobobject.test.ts` unit test asserts `taskkill /T /F` is invoked with correct args on Windows.
- v08-jobobject integration test stays skipped (heuristic process-list assertion); comment updated to point at the new unit test.
- New `repair.test.ts` (6 cases) and integration tests `v11-repair.test.ts` and `v12-task-timeout.test.ts`.
- Suite: 58 + 2 skip → 78 + 1 skip.

## v0.1.0-mvp — 2026-05-23

Initial MVP. Research-dossier + fetch-docs discovery and execution against a single Windows project. See `docs/superpowers/specs/2026-05-23-glean-mvp-design.md`.
