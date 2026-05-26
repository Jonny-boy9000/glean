# Changelog

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
