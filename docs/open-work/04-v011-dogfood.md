# v0.1.1 Dogfood Results — 2026-05-24

**Run command:** `glean run --project C:\Glean --budget 15m`
**Run ID:** `2026-05-24-1647-70c352`
**Outcome:** `budget-exhausted`
**Exit code:** 10

## Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | 78 tests pass, 1 skipped | yes (78 passed, 1 skipped) |
| 2 | <30% candidates from docs/, test/, *.md | yes — 0% (0 of 35 ranked candidates) |
| 3 | `glean repair` scanned and reported correctly on historical OUT.md | yes — 36 scanned, 0 repaired, 11 skipped (extraction-too-short). See notes. |
| 4 | >=1 fetch-docs / dep candidate emerged | yes — 32 dep candidates, 3 todo candidates |
| 5 | npm test, build, lint exit 0 | yes |
| 6 | CHANGELOG.md documents user-visible changes | yes |
| 7 | README has Changelog link | yes |

Note on AC3: The v0.1.0 dossiers had 22-byte `_(no output produced)_` placeholder files. The repair
command now correctly resolves them (absolute path fix discovered and patched during this dogfood).
However, the 11 empty OUT.md from the v0.1.0 run cannot be recovered because the v0.1.0 executor wrote
raw text (not JSONL) to the `.jsonl` log files — `extractLastAssistantText` finds nothing parseable.
This is expected and documented; the skip reason is `extraction-too-short`.

Note on test count: v0.1.1 shipped with 77+1skip, but the absolute-path repair fix discovered during
dogfood added one test, bringing the final suite to 78+1skip.

## Counts

- Candidates discovered: 35 (3 todo, 32 dep)
- Ran: 11
- Failed: 0
- Timed out: 0
- Skipped (dedup): 1
- Elapsed: ~17 min wall-clock (budget was 900s/15 min; budget-exhausted exit)

## Notable observations

**Noise reduction is dramatic.** The v0.1.0 dogfood run (2026-05-24-1153-2e42df) produced 25 candidates,
of which the vast majority were from test files, integration test fixtures, docs markdown, and templates —
effectively ~80% noise by inspection (e.g. `test/integration/v01-dry-run.test.ts`,
`templates/research-dossier.md`, `docs/superpowers/specs/...`, `test/fixtures/...`). The v0.1.1 run
against the same project produced 35 candidates with 0% from docs/test/md paths. The scanner exclusion
filters and `.test.*` / `docs/**` path rules landed exactly as intended.

**Slug collision fix is visible.** The live run produced `research-handle-todo-in-src-lib-discover-git-ts-L28`
and `research-handle-todo-in-src-lib-executor-ts-L146` and `research-handle-todo-in-src-lib-pipeline-ts-L187`
as new distinct dossier dirs — they no longer overwrite the identically-named slug from the v0.1.0 run.
The line-number suffix is working.

**Auto-repair works for new-format runs.** The repair command scanned 36 entries (25 from v0.1.0 +
11 from the new live run), found 0 needing repair (all substantive), and correctly skipped 11 legacy
empty files with `extraction-too-short`. A critical bug was caught and fixed: `repair.ts` used
`path.join(datePath, entry.output)` which on Windows Node.js silently appended an absolute path as a
relative subpath. The fix (`isAbsolute` guard) was patched, tested, and committed as part of this
dogfood cycle.

## Issues found

1. **discover-deps false positives:** The `parseAddedPackages` function for `package.json` matches ALL
   JSON keys in the diff (e.g. `"name"`, `"description"`, `"version"`, `"bin"`, `"scripts"`, `"engines"`,
   `"dependencies"`, `"devDependencies"`) rather than just keys nested inside the `dependencies` or
   `devDependencies` objects. This is because the package.json was bumped from `0.1.0-mvp` → `0.1.1`
   today, making the whole file appear as ADDED in git log `--diff-filter=AM`. Result: 32 dep candidates
   were emitted instead of the expected ~8 (real deps: citty, fast-glob, uuid, yaml, zod, and the 3
   typescript devDeps recently added). The fetch-docs tasks wrote docs for fields like "name", "glean",
   "scripts", "bin" which have no npm docs. **This is the top v0.1.2 fix candidate.**

2. **repair can't recover v0.1.0 empty OUT.md:** The v0.1.0 executor wrote raw text (not JSONL) to
   `.jsonl` log files. `extractLastAssistantText` finds no parseable content. Affected: 11 dossiers from
   run `2026-05-24-1153-2e42df`. Not a regression — those files were already lost before v0.1.1.

3. **repair absolute-path bug (fixed in this PR):** Described above. Bug was introduced in the
   initial repair implementation and would have silently skipped all repair candidates on any system
   where the INDEX.md stored absolute paths. Fixed with `isAbsolute` guard.

## What to fix in v0.1.2

- **discover-deps: package.json parser must scope to `dependencies`/`devDependencies` blocks.** The
  current line-by-line regex matches every quoted-key-colon pattern in the diff, including top-level
  fields. Fix: parse the diff hunk to only emit keys when the surrounding context is inside a
  `"dependencies"` or `"devDependencies"` section. Alternatively, parse the manifest directly
  (after the diff confirms a change) and diff the package name sets.
- **fetch-docs: validate package names before emitting.** Even if discover-deps emits junk, fetch-docs
  could validate that the package name looks like a real npm/PyPI/crates name (contains alphanumeric +
  hyphen/slash/dot, no spaces, doesn't match common JSON field names) and skip rather than spawn Claude.
- **repair: consider raw-text log recovery.** For v0.1.0 users who have raw-text `.jsonl` logs,
  an optional fallback that treats the whole file as assistant text (if no JSON parse succeeds) would
  recover the 11 empty dossiers. Low priority but easy to add.
