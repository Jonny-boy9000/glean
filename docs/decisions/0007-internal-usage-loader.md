# ADR-0007 — Internal JSONL usage loader (deviation from the design's `ccusage/data-loader` dependency)

- Status: **Accepted** (deviation verified against the live npm registry, 2026-06-13)
- Date: 2026-06-13
- Enforced at: `src/lib/usage.ts` (module header tagged `ASSUMPTION[ADR-0007]`) +
  `usage.test.ts` (dedup / exclusion / local-day attribution suite)

## Context

The capacity-governor design (2026-06-12) pinned `ccusage/data-loader` as a **pinned direct
dependency** — "not a shell-out … not a reimplementation, which would re-own its documented dedup
bug surface (#888)." Verified against npm on 2026-06-13, that option no longer exists in
maintainable form:

- **ccusage v20 (current, 20.0.11)** ships platform-specific binaries (`@ccusage/ccusage-*`
  optionalDependencies) + a bin stub only — `package.json` has **no `exports` and no `main`**;
  there is no programmatic JS API at all.
- **v19** already dropped the `./data-loader` subpath (only `"."` remained).
- **18.0.11** is the last version exporting `./data-loader` — i.e. the API the design named is an
  **upstream-abandoned surface**: future dedup fixes land in the v20 binary, never in a pinned v18,
  which inverts the design's "never re-own the dedup bug surface" rationale into its opposite.
- Suitability gap even on 18.0.11: `loadDailyUsageData` aggregates to daily totals **before**
  glean's own-session exclusion can apply. Glean must drop sessions by JSONL `cwd` (under
  `~/glean/`, agent worktrees, temp — the verified `isNoiseCwd` rules), and ccusage's project
  dimension is the encoded history-dir slug, which this machine proved ambiguous (v0.8.5:
  `C--ClaudeCode-Work` ≠ decodable). Using ccusage would mean loading raw entries and
  re-aggregating anyway.

## Decision

`src/lib/usage.ts` implements a **minimal internal loader** over
`~/.claude/projects/**/*.jsonl` `message.usage` blocks: dedup by `message.id + requestId`,
**first entry wins, only when both exist** (ccusage's `createUniqueHash` rule, adopted
deliberately to stay comparable); glean-spawned sessions excluded via the registry's `isNoiseCwd`
(sessions with no `cwd` at all are INCLUDED — glean always sets cwd on its spawns); LOCAL
calendar-day attribution; `<synthetic>` models and malformed lines skipped. The output contract
is glean's own either way: daily raw token totals per model family (weighting is pacing.ts's job,
see ADR-0005).

## Status / what would change this

If ccusage (or a successor) re-publishes a maintained programmatic loader **with raw per-entry
access** (so cwd exclusion survives), swap the internals behind `loadDailyUsage` and supersede
this ADR. Local accounting remains an **estimate** either way (ccusage #888/#866 document real
undercounting) — which is why `glean usage` carries the blind-spot note and `pacing.haircut`.
