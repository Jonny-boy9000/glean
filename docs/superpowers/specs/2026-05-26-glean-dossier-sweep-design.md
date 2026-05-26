# Dossier-Existence Sweep — Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-26
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Add a passive usefulness-telemetry sweep that runs at the start of every `glean run`. For each historical candidate that produced a dossier and is now 7+ days old, it checks whether the dossier file still exists on disk and writes the result to `memory.db`. Captures the implicit "kept vs discarded" signal with zero user action. Ships as `v0.3.0`. No CLI surface, no engine behavior change.

---

## 1. Goal and success criteria

The strategic analysis on 2026-05-26 identified the engine's most load-bearing gap: there is no measure of dossier usefulness. `est_value` is a heuristic. The dossiers themselves have never been scored against "did the user actually keep this." Without that signal, every other engineering improvement (better ranking, smarter discovery, more candidate types) is decorating a value-unknown core.

This release closes the easy half of that gap. Active ratings via `glean rate` (Up next #2) require user effort. Existence checks require none — if the user `rm -rf`'d a dossier within 7 days of it being generated, that's an implicit "discarded." If it's still there, it's at least tolerated. The sweep captures this with no friction and no new UI.

**Done when:**

1. Schema migration `v2` adds `dossier_existed_at_7d INTEGER` column to `candidates` and sets `PRAGMA user_version = 2`. Applies idempotently against both fresh DBs and v1 DBs.
2. `src/lib/memory.ts` exports two new methods: `findCandidatesNeedingSweep(beforeMs)` and `markDossierExists(candidateId, exists)`.
3. New module `src/lib/sweep.ts` exports `runDossierExistenceSweep(memory, now, ageMs): SweepResult`. Pure orchestration — loops candidates, calls `existsSync`, calls `markDossierExists`, returns `{checked, kept, discarded}`.
4. `src/lib/pipeline.ts` calls `runDossierExistenceSweep(memory, Date.now(), SWEEP_AGE_MS)` right after `memory.recordRun` succeeds, inside the same try/catch that protects against memory failures. Sweep result is logged via `appendOrchestratorLog`.
5. Sweep failures are non-fatal: they emit `[memory] warning: sweep failed: ...` to stderr and the run continues normally. The engine must not regress on any existing behavior if the sweep cannot run.
6. Per-path errors (e.g., `existsSync` throws on a malformed or permission-denied path) are swallowed per-candidate: that row is marked as "did not exist" (`0`) and the sweep continues to the next row.
7. Idempotency: each row is checked exactly once. Once `dossier_existed_at_7d` is non-NULL, it is never overwritten.
8. New unit tests cover migration v2, the two new `Memory` methods, and the sweep orchestrator (~10 new tests). Total test suite: 105 + 1 skip → ~115 + 1 skip.
9. `npm test`, `npm run build`, `npm run lint` all exit 0.
10. `CHANGELOG.md` has a `v0.3.0` entry.
11. `docs/ROADMAP.md` moves "Dossier-existence sweep" from **Up next #1** to **Done**.

## 2. Locked decisions (from brainstorm)

- **Trigger:** auto-runs at the start of every `glean run`, before discovery. Not a separate `glean sweep` subcommand. Manual invocation is a future enhancement if needed.
- **Threshold:** single 7-day window. No 30-day or longer checkpoints in this release; the schema permits adding them later as new columns.
- **Signal:** bare existence via `fs.existsSync`. No atime, no mtime, no content check, no size check.
- **Idempotency model:** once-and-done. A row's existence column is written once; subsequent sweeps skip it (`WHERE dossier_existed_at_7d IS NULL`).
- **Retroactivity:** none. Pre-v0.3.0 candidate rows that have already passed the 7-day mark when the feature ships will stay `NULL` forever. Historical data is intentionally lost; the substrate only began accumulating on 2026-05-25, so the cost is bounded.
- **Failure mode:** sweep is best-effort. DB write failures, `existsSync` throws, missing memory.db — all logged and skipped. Never propagates.
- **Surface:** none. Pure data accumulation. Item #3 in the roadmap (`glean today` enriched with memory.db) will read this column to surface the signal to the user.
- **Performance:** acceptable to do all eligible candidates in one pass at run start. Each `existsSync` is sub-ms; typical sweeps will do tens of checks, completing in <100ms. Even at 10,000 historical candidates the total cost is <10s — but the eligible set grows by ~1 day's worth per run in steady state, so most sweeps are trivial.
- **Version:** `v0.3.0` (minor bump — schema migration v2 is the qualifying change).

## 3. Architecture

Three touch points:

```
glean run
  ├─ open Memory (existing — v0.2.0)
  ├─ memory.recordRun(...) (existing)
  ├─ runDossierExistenceSweep(memory, Date.now(), SWEEP_AGE_MS)  ◄── NEW
  │     ├─ findCandidatesNeedingSweep(beforeMs)
  │     ├─ for each: existsSync(dossier_path)
  │     └─ markDossierExists(id, bool)
  ├─ appendOrchestratorLog({evt: 'sweep.done', ...})  ◄── NEW
  └─ ... rest of pipeline unchanged
```

`src/lib/sweep.ts` is the only new file. The Memory class grows by two methods + one migration. Pipeline.ts gains one new call site (~5 lines including logging and try/catch).

The split between `sweep.ts` (orchestration) and `memory.ts` (storage primitives) is the same pattern v0.2.1 used for `today.ts` (scanner) / `render-today.ts` (formatter): keep the SQL-touching code in `memory.ts`, keep the filesystem-touching code in `sweep.ts`, test each in isolation.

## 4. Schema migration v2

Migration v2 (in `Memory.migrate`):

```sql
ALTER TABLE candidates ADD COLUMN dossier_existed_at_7d INTEGER;
```

Then `PRAGMA user_version = 2`.

Semantics:
- `NULL` — not yet checked (default for all existing and future rows).
- `1` — `existsSync(dossier_path)` returned true at check time.
- `0` — `existsSync(dossier_path)` returned false at check time, OR the call threw.

SQLite stores `INTEGER` for booleans (no native BOOL); matches the existing `stderr_rate_limit_hits` column convention.

The migration block in `Memory.migrate` adds a `version < 2` arm after the existing `version < 1` arm:

```ts
private migrate(): void {
  const version = this.db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    this.db.exec('BEGIN');
    try {
      this.db.exec(SCHEMA_V1);
      this.db.pragma('user_version = 1');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  if (version < 2) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('ALTER TABLE candidates ADD COLUMN dossier_existed_at_7d INTEGER');
      this.db.pragma('user_version = 2');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
```

Idempotent: running against a v0 DB applies both migrations in order; running against a v1 DB applies only v2; running against a v2 DB applies neither.

## 5. Module details

### 5.1 `src/lib/memory.ts` — two new methods

```ts
findCandidatesNeedingSweep(beforeMs: number): Array<{ id: number; dossier_path: string }> {
  return this.db.prepare(
    `SELECT id, dossier_path
       FROM candidates
      WHERE outcome IS NOT NULL
        AND dossier_path IS NOT NULL
        AND ended_at IS NOT NULL
        AND ended_at < ?
        AND dossier_existed_at_7d IS NULL`,
  ).all(beforeMs) as Array<{ id: number; dossier_path: string }>;
}

markDossierExists(candidateId: number, exists: boolean): void {
  this.db.prepare(
    `UPDATE candidates
        SET dossier_existed_at_7d = ?
      WHERE id = ?
        AND dossier_existed_at_7d IS NULL`,  // write-once guard
  ).run(exists ? 1 : 0, candidateId);
}
```

The `WHERE dossier_existed_at_7d IS NULL` guard on `markDossierExists` enforces write-once even if the sweep is re-invoked on the same row in a race or bug. (Realistically the query filter in `findCandidatesNeedingSweep` already excludes such rows, but defense-in-depth costs nothing.)

`beforeMs` semantics: a row is eligible when `ended_at < beforeMs`. The caller passes `Date.now() - SWEEP_AGE_MS`, meaning "rows that ended at least 7 days ago."

### 5.2 `src/lib/sweep.ts` — new module

```ts
import { existsSync } from 'node:fs';
import type { Memory } from './memory.js';

export const SWEEP_AGE_MS = 7 * 86_400_000;

export interface SweepResult {
  checked: number;
  kept: number;
  discarded: number;
}

export function runDossierExistenceSweep(memory: Memory, now: number, ageMs: number): SweepResult {
  const beforeMs = now - ageMs;
  const candidates = memory.findCandidatesNeedingSweep(beforeMs);
  let kept = 0;
  let discarded = 0;

  for (const c of candidates) {
    let exists = false;
    try {
      exists = existsSync(c.dossier_path);
    } catch {
      exists = false;
    }
    try {
      memory.markDossierExists(c.id, exists);
    } catch (e) {
      process.stderr.write(`[memory] warning: markDossierExists failed for id=${c.id}: ${(e as Error).message}\n`);
      continue;
    }
    if (exists) kept++;
    else discarded++;
  }

  return { checked: candidates.length, kept, discarded };
}
```

Module purpose: take a `Memory` instance and a clock, sweep eligible rows. No I/O beyond `existsSync` and the `Memory` methods. Pure orchestration; trivially unit-testable with a fake `Memory`.

The `now` and `ageMs` parameters exist for testability — tests can pass an old `now` to make recent fixtures look "ancient," or a tiny `ageMs` to avoid sleeping.

### 5.3 `src/lib/pipeline.ts` — one new call site

After the existing `memory.recordRun(...)` line, inside the same try/catch that opens Memory:

```ts
if (memory) {
  try {
    const result = runDossierExistenceSweep(memory, Date.now(), SWEEP_AGE_MS);
    appendOrchestratorLog(opts.gleanRoot, runId, {
      evt: 'sweep.done',
      checked: result.checked,
      kept: result.kept,
      discarded: result.discarded,
    });
  } catch (e) {
    process.stderr.write(`[memory] warning: sweep failed: ${(e as Error).message}\n`);
  }
}
```

Position: after `recordRun` (so `memory` is open and a run is recorded), before discovery (so the sweep doesn't compete with the run's wall-clock budget — its work is "free" before the real engine starts).

## 6. Module changes

| File | Change |
|---|---|
| `src/lib/memory.ts` | Migration v2 in `migrate()`; two new methods (`findCandidatesNeedingSweep`, `markDossierExists`). ~30 LOC delta. |
| `src/lib/memory.test.ts` | 4 new tests: migration v2 idempotency × 2, `findCandidatesNeedingSweep` filtering, `markDossierExists` write-once. ~40 LOC delta. |
| `src/lib/sweep.ts` | **New.** Orchestrator + `SWEEP_AGE_MS` constant + `SweepResult` interface. ~30 LOC. |
| `src/lib/sweep.test.ts` | **New.** 6 fixture-based tests. ~80 LOC. |
| `src/lib/pipeline.ts` | One new call site (~10 LOC including log + try/catch). Import `runDossierExistenceSweep` and `SWEEP_AGE_MS`. |
| `package.json` | Bump version to `0.3.0`. |
| `CHANGELOG.md` | v0.3.0 entry. |
| `docs/ROADMAP.md` | Move "Dossier-existence sweep" from Up next #1 to Done. Renumber remaining Up next 2–5 → 1–4. |

Estimated implementation LOC: ~75. Estimated test LOC: ~120. (Tests grow faster than implementation as usual.)

## 7. Testing plan

### 7.1 `memory.test.ts` additions

1. **Migration v2 on fresh DB.** Open a `:memory:` DB. Assert `dossier_existed_at_7d` column exists on `candidates` (via `PRAGMA table_info('candidates')`). Assert `user_version = 2`.
2. **Migration v2 from v1 DB.** Open a file-backed DB, force `user_version = 1` after v1 migration ran (or open against a DB that legitimately stopped at v1). Reopen. Assert the new column exists and `user_version = 2`.
3. **`findCandidatesNeedingSweep` filters correctly.** Seed 5 rows: one with no `ended_at`, one with no `dossier_path`, one with `ended_at` after the cutoff, one already swept (column = 1), one fully eligible. Assert only the eligible row is returned.
4. **`markDossierExists` is write-once.** Seed an eligible row. Call `markDossierExists(id, true)` then `markDossierExists(id, false)`. Assert the final value is `1` (the first write wins). Then assert the eligible row no longer appears in `findCandidatesNeedingSweep`.

### 7.2 `sweep.test.ts` (new file)

All tests use `Memory(':memory:')` plus a `mkdtempSync` workspace for real files.

1. **Empty DB.** Sweep returns `{checked: 0, kept: 0, discarded: 0}`. No error.
2. **One eligible row, file exists.** Seed a run + candidate with `dossier_path` pointing to a real file in the temp dir. Pass `ageMs: 0` so the row is immediately eligible. Sweep. Assert `kept: 1, discarded: 0`. Verify the column is `1`.
3. **One eligible row, file does NOT exist.** Same as #2 but the path points to a non-existent file. Assert `kept: 0, discarded: 1`. Column is `0`.
4. **Row too recent.** Seed a row with `ended_at = Date.now()` (just settled). Sweep with `ageMs: 7 * 86_400_000`. Assert `checked: 0`. Column stays NULL.
5. **Row already swept.** Manually set `dossier_existed_at_7d = 1` on a row. Sweep. Assert `checked: 0` (row excluded by the query).
6. **`existsSync` throws (malformed path).** Node's `fs` module rejects any path containing a null byte (`\u0000`) at the JS validation layer with a `TypeError`. Seed a candidate with `dossier_path: 'C:\foo\u0000bar'` to deterministically trigger the throw. Assert the candidate is marked `0` (per-row catch swallows the throw), and the sweep returns normally with `checked: 1, discarded: 1`.

### 7.3 Regression discipline

All existing tests (105 passing + 1 skipped at v0.2.1) must continue to pass. The integration tests (`v13-memory`, `v14-memory-failure`) exercise `pipeline.ts` end-to-end and will now also exercise the sweep — but their fresh-DB setup means the sweep finds zero eligible rows. No assertion changes needed; just verify they still pass.

The `[memory] warning: sweep failed:` path should be tested via the existing `v14-memory-failure.test.ts` pattern — but only if the sweep fails differently than `Memory` open failure. In this design, sweep failure is rare (would require DB corruption mid-run), and the existing v14 test already covers the broader "memory unavailable" contract. Skip a dedicated v16-sweep-failure test for v0.3.0; revisit if real failures surface.

## 8. Out of scope (explicit)

- **No `glean sweep` subcommand.** Sweep auto-runs only at the start of `glean run`. If a user wants to force a sweep without running glean, they can't in v0.3.0.
- **No 30-day or longer checkpoints.** Single 7-day threshold.
- **No retroactive sweep of pre-v0.3.0 rows.** Old rows that already passed the 7-day mark when the feature ships stay `NULL` forever.
- **No content checks.** Bare existence only. A dossier with `OUT.md` size 0 still counts as "existed."
- **No "moved" detection.** If a user moves a dossier to `~/notes/` they could argue it's been kept, but tracking moves requires inode tracking or path heuristics — out of scope.
- **No surfacing in any UI.** Item #3 in the roadmap (`glean today` enriched with memory.db) will read this column.
- **No ranker behavior change.** Engine reads zero existence data; future learning loops will.
- **No telemetry on partial-day windows.** A row checked at day 7.5 vs day 8.5 is recorded as "existed/didn't" with no timestamp. If finer resolution becomes valuable, add a `swept_at` timestamp column in a later migration.
- **No memory growth from old rows.** This release does not add a `gc` step. The `glean discard` / `glean gc` deferred sub-project handles eventual cleanup.

## 9. Rollback / failure modes

- **`memory.db` cannot be opened at run start** — existing pipeline catch handles this; `memory = null`, sweep is skipped entirely (the `if (memory)` guard).
- **`runDossierExistenceSweep` throws (e.g., DB locked)** — caught by the new try/catch in `pipeline.ts`. Logs `[memory] warning: sweep failed: ...`. Run continues with discovery.
- **Migration v2 fails mid-apply** — `BEGIN`/`ROLLBACK` transaction ensures `user_version` stays at 1, the new column is rolled back. Next run retries. Logged via the existing `Memory` open catch in `pipeline.ts`.
- **`existsSync` throws on a single path** — per-row try/catch in `sweep.ts` treats it as `false`. Sweep continues to the next row.
- **`markDossierExists` throws mid-loop** — per-row try/catch logs `[memory] warning:` and skips that row. Sweep continues. The row stays NULL and will be re-checked on the next run.
- **User wants to wipe the existence data** — `rm %USERPROFILE%\glean\memory.db` wipes everything (substrate + sweep data). Or, surgically: `sqlite3 memory.db "UPDATE candidates SET dossier_existed_at_7d = NULL"`. Document the second in CHANGELOG.

## 10. Open questions deferred

- **Whether to add a 30-day or 90-day window** as a second column. Wait for v0.3.0 data to show whether 7-day "kept" rates differ meaningfully from longer windows.
- **Whether to add a `swept_at` timestamp** so we can later distinguish "checked at day 7" from "checked at day 14." If signal turns out to depend on the precision, add it; for now the check is "did this row pass the 7-day mark with the file still present."
- **Whether a dedicated `glean sweep` subcommand is worth it** so the user can force a check without running a real glean. Wait for a use case.
- **Whether to combine existence with content fingerprinting** (sha256 of OUT.md at write time vs. at sweep time) to detect "user kept the file but edited it heavily" as a stronger signal than mere existence. Deferred — `bytes_written` already captures initial size; that's enough for v1.
