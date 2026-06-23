# ADR-0014 — Honest draft test-status taxonomy (`env-blocked` ≠ `fail`, preamble-anchored)

- Status: **Accepted** (built + tested 2026-06-23) — 2026-06-23
- Supersedes: the overloaded `'none'` producer token from the v0.7.1 morning-receipt work (which
  conflated "no test command", "stopped before tests", and "tests could not run"). `'none'` survives
  **only as a renderer bucket** for pre-ADR-0014 DB rows — never produced again.
- Enforced at: `src/lib/types.ts` (`DraftTestStatus` union, tagged `ASSUMPTION[ADR-0014]`),
  `src/lib/draft-test.ts` (`preambleOf` / `preambleLooksLikeEnvFailure` + the 6 status returns,
  tagged `ASSUMPTION[ADR-0014]`), `src/lib/draft-git.ts` (`linkBaseNodeModules` /
  `unlinkNodeModulesLink`, tagged `ASSUMPTION[ADR-0014]`), `src/lib/executor.ts` (post-spawn-death
  link + teardown + status wiring), `src/lib/morning.ts` (`normalizeTestStatus` pass-through),
  `src/lib/render-morning.ts` (`describeTest` phrasing). Tests: `draft-test.test.ts` (9 preamble +
  2 node_modules), the retargeted `executor.test.ts` producer assertions, `render-morning.test.ts`
  (the 5 producer states + legacy `none` + `unknown`), `render-receipt.test.ts` (describeTest
  routing), `memory.test.ts` (new-token round-trip, no migration).

## Context

The v0.7.1 receipt reported a draft's test status, but the producer collapsed several distinct
outcomes into one `'none'` token, and — worse — a draft whose suite **could not even start** (the
worktree has no `node_modules`, so the runner can't resolve `vitest`/`jest`) was being reported as a
**`fail`**. That is a dishonest signal: it tells the user their draft is broken when in fact glean's
own out-of-session test run never ran. The receipt's whole value is a trustworthy "is this draft
safe to look at" line; a false `fail` poisons it.

Two facts drive the fix:
- **An env/setup failure means the suite NEVER STARTED.** Its signature ("cannot find module",
  "missing script: test", a bare loader stack) can therefore only appear in the runner's **startup
  preamble** — the lines *before the first test-result marker*. A genuine assertion failure that
  merely mentions `ENOENT` in its message appears *after* a test fence. So anchoring the env-failure
  scan to the preamble (lines before the first runner-progress marker, capped at 50) distinguishes
  "never ran" from "ran and failed" without guessing.
- **glean tests the draft out-of-session**, in a bare linked worktree that has the source but not the
  installed dependency tree. A Node/TS draft that *would* pass after `npm install` reaches a false
  `env-blocked` unless its declared deps are resolvable. Linking the base checkout's `node_modules`
  into the worktree makes them resolvable — but only safely **after the spawn tree is provably dead**
  (`descendantsDead`), so the live spawn never saw base deps and the [ADR-0009](./0009-spawned-session-trust-boundary.md)
  boundary is not widened.

## Decision

Replace the overloaded producer token with an **honest five-state taxonomy**
(`DraftTestStatus = 'pass' | 'fail' | 'env-blocked' | 'skipped' | 'no-command'`):
- **`pass`** — exit 0. The only assumption-free signal.
- **`fail`** — non-zero **and** the preamble shows no env-failure signature (the suite ran and
  something failed).
- **`env-blocked`** — the command isn't runnable, errored before exit, returned `null` status, or
  exited non-zero **with** an env signature in the preamble (suite never started). This is the
  honesty fix: a missing toolchain is no longer a `fail`.
- **`skipped`** — a draft commit exists but glean stopped before running tests (budget/partial).
- **`no-command`** — no test command is configured for the project.

`env-failure` detection is **preamble-anchored**: `preambleOf(output)` cuts at the first
runner-progress marker (`SUITE_STARTED_FENCE`, capped at `PREAMBLE_LINE_CAP = 50`), and
`preambleLooksLikeEnvFailure` scans only that slice. A late `ENOENT` *after* a test fence stays
`fail`.

To recover real `pass` signals, the executor calls `linkBaseNodeModules(main, worktree,
descendantsDead)` **after the spawn is dead**, runs the tests, then `unlinkNodeModulesLink(path)`.
The link is a **junction on Windows** (needs no elevation) / **dir-symlink on POSIX**; teardown
removes **only the link** (POSIX `unlinkSync` → Windows `rmdirSync` fallback) and **NEVER**
`rmSync({recursive})` — a Windows junction lstats as a directory, so a recursive remove would walk
into and delete the base `node_modules` it targets. Both helpers are best-effort and never throw; on
any failure the status degrades to today's `env-blocked`.

The DB column `draft_tests` is plain `TEXT` (no `CHECK`), so the widened vocabulary needs **no schema
migration** — NULL rows = pre-feature, rendered `unknown`; legacy `'none'` literals render as
`'none'`. The receipt/morning renderers route every status through `describeTest` (human phrasing:
`env-blocked` → "could not run (environment)", `skipped` → "skipped (partial/stopped)", `no-command`
→ "no test command"), never raw token interpolation.

## Status / what would change this

- **`SUITE_STARTED_FENCE` is a heuristic allow-list** of runner-progress markers (TAP, vitest/jest
  banners, `✓`/`✗`, "test files", "collected", etc.). A runner whose first line is neither a fence
  nor an env signature would have its whole output treated as preamble — at worst mislabeling a real
  `fail` as `env-blocked` (the safe direction: never a false `pass`). Add markers as new runners
  surface; the preamble tests pin the current set.
- **The node_modules link assumes a single base `node_modules` resolves the draft's deps** — true for
  the common single-package repo; a draft that adds a *new* dependency the base never installed still
  reads `env-blocked` (honest — it genuinely can't run here). Monorepo/workspace layouts (per-package
  `node_modules`) are out of scope for v0.10; revisit if drafts in those land false `env-blocked`.
- **`pass` is the only assumption-free claim.** Everything else is a classification; the receipt
  states the phrase, not a guarantee. The boundary that would change this is a real in-session test
  signal (none exists today — glean tests out-of-session by design).
