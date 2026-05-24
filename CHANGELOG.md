# Changelog

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

### Tests
- v03-budget integration test revived using the new `--task-timeout 2s` (was `.skip` due to 8-min runtime).
- New `jobobject.test.ts` unit test asserts `taskkill /T /F` is invoked with correct args on Windows.
- v08-jobobject integration test stays skipped (heuristic process-list assertion); comment updated to point at the new unit test.
- New `repair.test.ts` (5 cases) and integration tests `v11-repair.test.ts` and `v12-task-timeout.test.ts`.
- Suite: 58 + 2 skip → 77 + 1 skip.

## v0.1.0-mvp — 2026-05-23

Initial MVP. Research-dossier + fetch-docs discovery and execution against a single Windows project. See `docs/superpowers/specs/2026-05-23-glean-mvp-design.md`.
