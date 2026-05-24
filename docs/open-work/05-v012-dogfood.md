# v0.1.2 Dogfood Validation — 2026-05-25

Light validation report confirming the v0.1.1 dep-parser regression doesn't recur.

## Command run

```
glean run --project C:\Glean --dry-run
```

Run ID: `2026-05-25-0117-c66786`

## Dep candidates emitted (after parser rewrite)

- **Count:** 1
- **Package names:** `smol-toml` (from `package.json`, the runtime dep added in v0.1.2 itself)
- **Spurious entries found:** None.

## Counts by evidence kind

| kind | count |
|---|---|
| dep | 1 |
| todo | 0 |
| jsonl | 0 |
| pr | 0 |

Total candidates: 1 emitted, 4 skipped by dedup. Run exited 0 with no errors.

## v0.1.1 baseline for comparison

v0.1.1 dogfood produced 32 dep candidates of which only ~3 were genuine; the rest were top-level package.json fields (`name`, `description`, `scripts`, `bin`, etc.) that the old regex parser mis-treated as dependency names. The fetch-docs tasks dutifully wrote useless `docs/name.md` / `docs/description.md` etc. into the user's dossier dir.

## Verdict

**Regression confirmed fixed.** Zero spurious dep candidates. The only entry emitted is `smol-toml`, the one genuine recently-added dependency. The new full-file-parse approach with proper JSON/TOML parsers correctly scopes to dependency sections.

## Acceptance criteria from spec §1

| # | Criterion | Result |
|---|---|---|
| 1 | 81 tests pass, 1 skipped | yes |
| 2 | Zero spurious dep candidates in dogfood | yes |
| 3 | npm test, build, lint all exit 0 | yes |
| 4 | CHANGELOG.md has v0.1.2 entry | yes |
| 5 | 04-v011-dogfood.md AC3 corrected | yes |
| 6 | smol-toml install footprint <50KB | yes (verified during Task 2 install) |
