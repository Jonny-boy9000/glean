# `glean today` Enriched with `memory.db` Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-26
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Extend the existing `glean today` view with an optional third line per entry that surfaces telemetry from `memory.db` — duration, output bytes, rate-limit hits, and user rating. Read-only enhancement. Engine, INDEX.md, and the existing two-line layout are untouched. Ships as `v0.5.0`. Closes the telemetry feedback loop by making v0.3.0's passive sweep + v0.4.0's active ratings visible at the same place the user looks every day.

---

## 1. Goal and success criteria

The v0.3.0 sweep and v0.4.0 ratings accumulate signals in `memory.db`. Until this release, those signals are essentially invisible — `glean today` reads only INDEX.md, and `glean rate --list` shows ratings but not timing, bytes, or rate-limit hits. The user has no daily-rhythm surface that says "yesterday's dossier on X took 12 minutes, was 4.2 KB, and you rated it kept."

This release adds that surface in the place the user already looks: `glean today`. One optional third line per entry. Dim in color mode. Only appears when there's enrichment to show. Failed tasks (which already show `(no output)`) don't get a third line — timing without context is misleading.

**Note on `dossier_existed_at_7d`:** that column is always NULL for today's entries (they're brand-new — no 7 days have elapsed). Surfacing it requires a historical viewer (`glean today --date <past>` or similar), which is explicitly out of scope here. The v0.3.0 sweep continues to populate the column; it just isn't read in this release.

**Done when:**

1. `src/lib/memory.ts` exports a new method `findEnrichmentsBySlugs(slugs: string[]): Map<string, EnrichmentRow>` that uses a single batched `WHERE candidate_slug IN (...)` query and returns a Map keyed by slug. Returns an empty Map when no slugs match or `slugs` is empty.
2. `src/lib/today.ts`'s `IndexEntry` type gains five new optional fields (`task_id` required, the others optional): `duration_ms`, `bytes_written`, `rate_limit_hits`, `user_rating`. `parseIndex` preserves `task_id` from the INDEX frontmatter.
3. `findTodayDossiers` opens `memory.db` (only if it exists — never lazily creates it), batches a single enrichment lookup by all collected task_ids, merges results into the returned entries. If `memory.db` is absent or any read throws, entries are returned unchanged with no stderr noise.
4. `src/lib/render-today.ts` adds a `formatEnrichmentLine(entry, c)` helper that returns the third line or `null` when nothing to show. The renderer conditionally appends it after each entry's existing two lines.
5. Format: `12m · 4.2KB · 1 rate-limit hit · rated: kept`. Bullet separator. Fields appear only when applicable per the rules in §3. Color: dim base, green for kept/actioned ratings, red for discarded.
6. Failed tasks (output empty) get no third line.
7. Unit tests cover the new Memory method, the scanner integration, and the renderer's enrichment-line formatting. Integration test verifies the third line appears end-to-end through the CLI.
8. `npm test`, `npm run build`, `npm run lint` all exit 0. Total suite: 126 + 1 skip → 133 + 1 skip.
9. `CHANGELOG.md` has a `v0.5.0` entry.
10. `docs/ROADMAP.md` moves "glean today enriched" from Up next #1 to Done. Remaining Up next renumbered 1–2.

## 2. Locked decisions (from brainstorm)

- **Format:** inline third line per entry, dim in color mode, bullet-separated fields. Selected over a column-table layout (would force a major redesign of the existing today aesthetic) and over a separate dashboard subcommand (premature; the daily-rhythm surface is the right home).
- **Visible fields in this release:** `duration_ms`, `bytes_written`, `rate_limit_hits` (only if > 0), `user_rating` (only if non-null). The 7-day existence flag is NOT shown — it's always NULL for today's entries.
- **Failure mode:** silent degradation. No stderr warning when memory.db can't be read. A noisy warning every invocation would be worse than transparent fallback for a read-only view that's run daily.
- **Lazy DB creation prevented:** `findTodayDossiers` does `existsSync(dbPath)` before opening. `glean today` never creates memory.db.
- **`--date` flag:** explicitly NOT added. Historical viewing is a separate sub-project. Without it, the 7-day-existence flag remains invisible — accepted as a known limitation in this release.
- **Failed/no-output tasks:** no enrichment line. Timing for a failed task is misleading without surrounding context (rate-limit retries, partial output, etc.) — better to show nothing than to mislead.
- **Engine isolation:** `pipeline.ts`, `executor.ts`, discovery modules, and the v0.3.0/v0.4.0 write paths are not touched.
- **Version:** `v0.5.0` (minor — new visible behavior, no schema change).

## 3. Architecture

Three touch points across existing modules + one new method:

```
glean today
  ├─ findTodayDossiers(gleanRoot)
  │   ├─ scan dossiers/*/<today>/INDEX.md (existing)
  │   ├─ parse frontmatter; preserve task_id (CHANGE: previously dropped)
  │   ├─ collect all task_ids across all projects
  │   ├─ if existsSync(<root>/memory.db):
  │   │     try {
  │   │       memory = new Memory(dbPath)
  │   │       enrichments = memory.findEnrichmentsBySlugs(taskIds)
  │   │       memory.close()
  │   │       merge enrichments into entries by task_id
  │   │     } catch { /* silent — return entries as-is */ }
  │   └─ return TodayReport
  ├─ renderToday(report, isTTY)
  │   └─ for each entry:
  │       ├─ print existing 2 base lines
  │       └─ if formatEnrichmentLine(entry, c) !== null:
  │             print 17-space indent + that line
  └─ stdout
```

The renderer's signature is unchanged. The scanner's signature is unchanged. The new field plumbing is internal to `IndexEntry`. Only `Memory` gains one new exported method.

The split mirrors the existing v0.2.1 / v0.3.0 / v0.4.0 conventions: storage SQL in `memory.ts`, filesystem orchestration in `today.ts`, pure rendering in `render-today.ts`.

## 4. Data shape

### 4.1 `IndexEntry` (extended)

```ts
export type IndexEntry = {
  title: string;
  status: 'ok' | 'ok-fallback' | 'failed' | 'timeout' | 'rate-limit';
  output: string;
  type: 'research-dossier' | 'fetch-docs';
  task_id: string;                                          // NEW: join key
  duration_ms?: number;                                     // NEW: from memory.db
  bytes_written?: number;                                   // NEW: from memory.db
  rate_limit_hits?: number;                                 // NEW: from memory.db (stderr_rate_limit_hits column)
  user_rating?: 'kept' | 'discarded' | 'actioned' | null;   // NEW: from memory.db
};
```

`task_id` is REQUIRED (every entry has one — `pipeline.ts`'s `appendIndex` always writes it). The other four are optional and absent when memory.db has no matching row.

### 4.2 `EnrichmentRow` (Memory return type)

```ts
type EnrichmentRow = {
  duration_ms: number | null;
  bytes_written: number | null;
  stderr_rate_limit_hits: number;        // NOT NULL default 0 — always a number
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
};
```

Field name `stderr_rate_limit_hits` matches the DB column verbatim. The `IndexEntry`'s `rate_limit_hits` is the same value, renamed during merge for readability (the `stderr_` prefix is implementation detail not worth surfacing in the type model used by the renderer).

## 5. Module details

### 5.1 `Memory.findEnrichmentsBySlugs`

```ts
findEnrichmentsBySlugs(slugs: string[]): Map<string, {
  duration_ms: number | null;
  bytes_written: number | null;
  stderr_rate_limit_hits: number;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
}> {
  if (slugs.length === 0) return new Map();
  const placeholders = slugs.map(() => '?').join(',');
  const rows = this.db.prepare(
    `SELECT candidate_slug, duration_ms, bytes_written, stderr_rate_limit_hits, user_rating
       FROM candidates
      WHERE candidate_slug IN (${placeholders})`,
  ).all(...slugs) as Array<{
    candidate_slug: string;
    duration_ms: number | null;
    bytes_written: number | null;
    stderr_rate_limit_hits: number;
    user_rating: 'kept' | 'discarded' | 'actioned' | null;
  }>;
  const m = new Map();
  for (const r of rows) {
    m.set(r.candidate_slug, {
      duration_ms: r.duration_ms,
      bytes_written: r.bytes_written,
      stderr_rate_limit_hits: r.stderr_rate_limit_hits,
      user_rating: r.user_rating,
    });
  }
  return m;
}
```

Single batched query. SQLite handles `IN (?, ?, ?, ...)` cleanly up to its parameter limit (default 999 in old versions, 32766 in modern). Today views typically have <50 slugs, well under any limit.

Empty-input short-circuit avoids running `SELECT ... WHERE x IN ()` which is invalid SQL.

### 5.2 `today.ts` — `findTodayDossiers` extension

The function currently returns `{date, projects}` with each project containing entries that have only `title`/`status`/`output`/`type`. Two changes:

(a) `parseIndex` already reads the YAML frontmatter; just stop dropping `task_id`. The existing pipeline writes it as `task_id: c.id`. Add it to the constructed entry:

```ts
for (const raw of fm.entries) {
  // existing validation
  if (typeof e.task_id !== 'string') continue;  // NEW: skip entries without task_id
  entries.push({
    title: e.title,
    status: e.status as IndexEntryStatus,
    output: typeof e.output === 'string' ? e.output : '',
    type: e.type === 'fetch-docs' ? 'fetch-docs' : 'research-dossier',
    task_id: e.task_id,                          // NEW
  });
}
```

The `task_id` validation guard means entries from corrupt or pre-substrate INDEX files (very unlikely in practice) are skipped rather than silently mis-joined.

(b) After all projects are collected, add an enrichment merge step before returning:

```ts
import { existsSync } from 'node:fs';
import { Memory } from './memory.js';

// ... existing collection loop ...

// Enrich entries with memory.db data when available.
const dbPath = join(gleanRoot, 'memory.db');
if (existsSync(dbPath)) {
  try {
    const memory = new Memory(dbPath);
    try {
      const allSlugs: string[] = [];
      for (const p of projects) for (const e of p.entries) allSlugs.push(e.task_id);
      const enrichments = memory.findEnrichmentsBySlugs(allSlugs);
      for (const p of projects) {
        for (const e of p.entries) {
          const enr = enrichments.get(e.task_id);
          if (!enr) continue;
          if (enr.duration_ms !== null) e.duration_ms = enr.duration_ms;
          if (enr.bytes_written !== null) e.bytes_written = enr.bytes_written;
          e.rate_limit_hits = enr.stderr_rate_limit_hits;  // never null
          e.user_rating = enr.user_rating;
        }
      }
    } finally {
      memory.close();
    }
  } catch {
    // Silent degradation: today view should still work without memory.db.
  }
}

return { date: targetDate, projects };
```

Note: `rate_limit_hits` is always set (since the DB column has NOT NULL DEFAULT 0); the renderer decides whether to display it based on > 0. `user_rating` is always set when there's an enrichment row, but may be `null` (unrated). The renderer treats `null` as "don't display."

### 5.3 `render-today.ts` — new `formatEnrichmentLine`

Add a helper:

```ts
function formatEnrichmentLine(entry: IndexEntry, c: Painter): string | null {
  // Failed/no-output entries get no enrichment line.
  if (!entry.output) return null;

  // Each part is wrapped in its own color/dim independently, so the parts
  // can be joined plainly without ANSI nesting (which would break because
  // \x1b[0m resets all attributes, not just the inner color).
  const parts: string[] = [];

  if (typeof entry.duration_ms === 'number') {
    parts.push(c.dim(formatDuration(entry.duration_ms)));
  }
  if (typeof entry.bytes_written === 'number' && entry.bytes_written > 0) {
    parts.push(c.dim(formatBytes(entry.bytes_written)));
  }
  if (typeof entry.rate_limit_hits === 'number' && entry.rate_limit_hits > 0) {
    const noun = entry.rate_limit_hits === 1 ? 'rate-limit hit' : 'rate-limit hits';
    parts.push(c.dim(`${entry.rate_limit_hits} ${noun}`));
  }
  if (entry.user_rating != null) {
    parts.push((entry.user_rating === 'kept' || entry.user_rating === 'actioned')
      ? c.green(`rated: ${entry.user_rating}`)
      : c.red(`rated: ${entry.user_rating}`));
  }

  if (parts.length === 0) return null;
  // The separator between parts is also dim, so the line reads as a single
  // continuous dim run with the rating segment overriding in green/red.
  const sep = c.dim(' · ');
  // Indent matches the output-path line: 17 spaces before content.
  return `                 ${parts.join(sep)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}
```

**ANSI strategy:** every part — including the separator ` · ` — is wrapped in its own painter call, so the final string is a sequence of self-terminating ANSI segments concatenated without nesting. This avoids the trap where `\x1b[0m` inside a wrapped rating would reset the outer dim and leave subsequent parts un-dimmed. Visually the result reads identically to a single dim run, with the rating segment overriding in green or red.

Modify the main render loop in `renderToday`:

```ts
for (const e of p.entries) {
  // existing 2 lines (icon+status+title, then output path)
  lines.push(/* line 1: status row */);
  lines.push(/* line 2: output path */);
  const enr = formatEnrichmentLine(e, c);
  if (enr !== null) lines.push(enr);
}
```

### 5.4 Render examples

Plain mode entry with full enrichment:

```
  ✓ ok           Handle TODO in src/cli.ts
                 ~/glean/dossiers/glean/2026-05-26/research-.../OUT.md
                 12m · 4.2KB · rated: kept
```

With rate-limit hit:

```
  ✓ ok           Pre-fetch docs for better-sqlite3
                 ~/glean/dossiers/glean/2026-05-26/docs/better-sqlite3.md
                 38s · 2.1KB · 1 rate-limit hit
```

Failed task (no enrichment line):

```
  ✗ failed       Handle TODO in lib/foo.ts
                 (no output)
```

Successful task with memory.db absent (back to pre-v0.5.0 behavior):

```
  ✓ ok           Handle TODO in src/cli.ts
                 ~/glean/dossiers/glean/2026-05-26/research-.../OUT.md
```

## 6. Module changes

| File | Change |
|---|---|
| `src/lib/memory.ts` | Add `findEnrichmentsBySlugs`. ~20 LOC delta. |
| `src/lib/memory.test.ts` | 2 new tests. ~50 LOC delta. |
| `src/lib/today.ts` | Extend `IndexEntry`, preserve `task_id` in `parseIndex`, add enrichment merge after collection loop. ~30 LOC delta. |
| `src/lib/today.test.ts` | 2 new tests. ~60 LOC delta. |
| `src/lib/render-today.ts` | Add `formatEnrichmentLine` + helpers + call site. ~50 LOC delta. |
| `src/lib/render-today.test.ts` | 3 new tests. ~50 LOC delta. |
| `test/integration/v15-today.test.ts` | Extend existing first test to seed memory.db and assert enrichment line. ~20 LOC delta. |
| `package.json` | Bump version to `0.5.0`. |
| `CHANGELOG.md` | v0.5.0 entry. |
| `docs/ROADMAP.md` | Move "glean today enriched" to Done. Renumber Up next (2→1, 3→2). |

Estimated implementation LOC: ~100. Tests: ~180.

## 7. Testing plan

### 7.1 `memory.test.ts` additions

1. **`findEnrichmentsBySlugs` returns matching rows in a Map.** Seed 3 candidates with varied enrichments (one with duration+bytes+rating set, one with rate-limit-hits=3, one with default values). Call with all 3 slugs. Assert Map has 3 entries with correct values.
2. **`findEnrichmentsBySlugs` returns empty Map for no matches AND for empty input.** Seed nothing. Call with `['bogus-slug']` — assert empty Map. Then call with `[]` — assert empty Map (no SQL executed).

### 7.2 `today.test.ts` additions

1. **Entries get enrichment when memory.db has data.** Create temp dossiers root. Write a real `memory.db` file using the existing `Memory` class plus a seed candidate whose slug matches the INDEX `task_id`. Set `duration_ms=120000`, `bytes_written=4096`, `user_rating='kept'`. Call `findTodayDossiers`. Assert the returned entry has those three fields set on the in-memory representation.
2. **Entries unchanged when memory.db is absent.** Fixture INDEX with valid `task_id` but no memory.db file in the temp glean root. Call `findTodayDossiers`. Assert entries are returned with `duration_ms === undefined`, no error thrown.

### 7.3 `render-today.test.ts` additions

1. **Enrichment line appears with duration + bytes + rating (plain mode).** Single entry with `duration_ms: 720_000` (12m), `bytes_written: 4300` (~4.2KB), `user_rating: 'kept'`. Render plain. Assert third line contains `12m`, `4.2KB`, `rated: kept`, separated by ` · `. Assert no `\x1b` codes.
2. **No third line when no enrichment fields apply.** Entry with `output: 'OUT.md'` but no enrichment fields set. Render. Assert the rendered string has exactly two lines for this entry (status + path), no third.
3. **Color codes appear for rating in color mode.** Entry with `user_rating: 'discarded'`. Render with `useColor: true`. Assert `\x1b[31m` (red) appears in the third line. Also assert `\x1b[2m` (dim) wraps the line. (`/* eslint-disable no-control-regex */` already present in this test file from v0.2.1.)

### 7.4 Integration `v15-today.test.ts` update

Modify the existing first test (`'prints a grouped report when dossiers exist for today'`). After creating the fixture INDEX.md, also create a `memory.db` in the same `home/glean/` directory using the same in-test schema-creation pattern as `v16-rate.test.ts`. Insert one candidate row whose `candidate_slug` matches the `task_id` in the fixture INDEX, with `duration_ms=720000`, `bytes_written=4300`, `user_rating='kept'`. Assert that the spawned `glean today` stdout contains `12m`, `4.2KB`, and `rated: kept`.

Keep the second test (`'prints the empty-case message'`) as-is — it doesn't need a memory.db.

### 7.5 Regression discipline

All 126 existing tests must continue to pass. Total target: 133 passing + 1 skipped.

## 8. Out of scope (explicit)

- **No `--date <YYYY-MM-DD>` flag.** Today only. Historical views are a separate sub-project.
- **No surfacing of `dossier_existed_at_7d`.** The column is always NULL for today's entries; making it visible requires the historical viewer above.
- **No JSON output mode** (`--json`). Programmatic access goes through `memory.db` directly.
- **No filtering** (`--only-rated`, `--failed-only`, `--has-rate-limits`). YAGNI.
- **No new write paths** — engine, INDEX.md, and ratings unchanged.
- **No ranker behavior change.** Telemetry remains read-only here.
- **No change to the empty-case message** (`No glean dossiers for <date>.`) — same as v0.2.1.
- **No retroactive enrichment of INDEX.md.** Memory.db remains the canonical source for telemetry; INDEX.md stays human-facing.

## 9. Rollback / failure modes

- **`memory.db` doesn't exist** — `existsSync` returns false; enrichment merge skipped; entries returned without the new fields. `glean today` works exactly as in v0.2.1.
- **`memory.db` exists but is corrupt** — `new Memory(dbPath)` throws (likely during migration or open). Caught by the outer try/catch in `findTodayDossiers`. No stderr noise; entries returned without enrichment.
- **`findEnrichmentsBySlugs` throws** (e.g., schema mismatch from a manually-downgraded DB) — same try/catch. Silent degradation.
- **Some entries have memory.db rows, others don't** (e.g., a brand-new run that hasn't recorded yet, or pre-substrate INDEX entries) — `enrichments.get(task_id)` returns undefined for missing slugs; the `if (!enr) continue` guards correctly. Mixed output is fine.
- **INDEX entry has invalid or missing `task_id`** — `parseIndex` skips it (the new validation guard). The entry won't appear in the today view at all. That's a stronger contract than v0.2.1's "best-effort" parsing but safer once we depend on task_id for joins.
- **User wants to suppress enrichment** — set `memory.db` to a non-existent path (e.g., rename it temporarily). No flag needed; the design is "enrichment when available." If a `--no-enrichment` flag becomes valuable, add it later.

## 10. Open questions deferred

- **Whether to add a `glean today --date <past>` flag.** Required to make 7-day-existence visible. Belongs to a separate "historical viewer" design.
- **Whether to add a usefulness-summary footer line** (e.g., "5 tasks · 4 ok · 1 failed · 2 kept · 0 discarded"). Probably useful; YAGNI here.
- **Whether to color-code entries by realized value** once enough rating data accumulates. Premature without a value model.
- **Whether to show output path on a single line + enrichment on the same line** for compactness. Tested mentally; the third-line design reads better.
- **Whether to truncate long titles or paths** for narrow terminals. Today already overflows on long titles; not a new concern. Address in a follow-up if it bites.
