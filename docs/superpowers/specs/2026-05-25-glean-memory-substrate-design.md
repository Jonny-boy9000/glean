# Glean Persistent Memory Substrate — Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-25
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Add a SQLite-backed run/candidate history store as pure infrastructure. Ships as `v0.2.0`. No user-visible behavior change; no CLI surface. The substrate observes — every `glean run` records what was discovered, prioritized, executed, and how it ended. Future learning-loop sub-projects (suppress duds, rank by realized value, adapt budgets) read this store, but those features are NOT in this release.

---

## 1. Goal and success criteria

Every `glean run` today rebuilds context from scratch and discards everything: no record of which candidates were considered, which ran, which timed out, which were repeatedly skipped. Retrofitting memory after-the-fact requires re-running historical data that will have already been discarded. The substrate must exist *before* any learning loop is built on top.

This release adds the substrate only — a single SQLite file at `%USERPROFILE%\glean\memory.db` with a schema designed to support three eventual learning loops without committing to any of them now:

1. **Suppress recurring duds** — same candidate keeps surfacing and being skipped; future ranker stops re-suggesting it.
2. **Rank by realized value** — replace `est_value` heuristic with observed usefulness (bytes written, dossier still present after N days).
3. **Adapt budgets/timeouts** — learn per-project rate-limit behavior and per-type runtime distributions.

**Done when:**

1. New file `src/lib/memory.ts` exports a typed `Memory` class with five methods (`recordRun`, `endRun`, `recordCandidate`, `recordOutcome`, `close`).
2. Schema migration `001_initial` creates `runs` and `candidates` tables and indexes; `PRAGMA user_version = 1` set on apply.
3. `pipeline.ts` calls `recordRun` at start and `endRun` (in `finally`) at end; calls `recordCandidate` once per candidate after prioritization.
4. `executor.ts` calls `recordOutcome` after every task completion (success, skip, timeout, rate-limit, error).
5. Recording failures (e.g., `memory.db` cannot be opened) emit a warning to stderr and the run continues normally. The engine must not regress on any existing behavior if memory is unavailable.
6. Unit tests against `:memory:` SQLite cover: fingerprint stability across runs, migration application, each API method's effect on the schema. Integration test uses the existing fake-claude fixture to verify rows are written end-to-end.
7. `npm test`, `npm run build`, `npm run lint` all exit 0. Total test count: 86–89 passing (was 81+1 skip in v0.1.2).
8. `CHANGELOG.md` has a v0.2.0 entry.
9. `docs/ROADMAP.md` moves "Persistent memory substrate" from **Up next** to **Done**.

## 2. Locked decisions (from brainstorm)

- **Strategic move:** A — memory substrate now, before retrofitting becomes harder. Selected over: B (distribution unlocker / POSIX port) and C (v0.2 velocity batch).
- **Schema scope:** design for breadth — all three learning loops must be possible from the recorded data, even though no loop ships in this release. Selected over: optimize the schema for any single loop.
- **Storage:** single SQLite file at `%USERPROFILE%\glean\memory.db`. Local-only, no remote sync, no encryption, user-owned.
- **Dependency:** `better-sqlite3` (synchronous, matches glean's serial executor; well-supported prebuild binaries on Windows). The alternative — `node:sqlite` built-in — is rejected for now because it requires bumping the Node engine requirement; revisit when POSIX port lands.
- **Version:** `v0.2.0` (minor bump, not patch — this is a new subsystem, even though no user-visible feature ships).
- **No CLI surface.** No `glean memory`, `glean stats`, or query subcommand in this release. Read APIs land with the learning-loop sub-projects.
- **No retrofit.** Memory starts accumulating from v0.2.0 forward. Historical runs are not reconstructed.
- **Failure mode:** recording is best-effort. If the DB cannot be opened or a write fails, log a warning and continue the run. Memory must never become a single point of failure for the engine.

## 3. Architecture

The substrate is a single module — `src/lib/memory.ts` — with one exported class (`Memory`) and one exported pure function (`fingerprintCandidate`). It owns the SQLite connection and the migration logic.

Three wire-in points in existing modules:

- `pipeline.ts` — opens the `Memory` instance at run start, calls `recordRun` immediately, then `recordCandidate` once per prioritized candidate. Wraps the executor loop in `try`/`finally` so `endRun` always fires.
- `executor.ts` — receives the `Memory` instance (or a per-candidate `recordOutcome` callback) and calls `recordOutcome` after each task settles.
- `pipeline.ts` again (cleanup) — calls `memory.close()` in `finally`.

Data flow:

```
run start
  ├─ Memory.open() → migrate if needed
  ├─ recordRun(runStart) → INSERT into runs, returns run_id
  ├─ for each prioritized candidate:
  │     recordCandidate(runId, c) → INSERT into candidates, returns row id
  ├─ executor loop:
  │     for each task:
  │       recordOutcome(candidateId, outcome, fields) → UPDATE candidates row
  ├─ endRun(runId, exitReason) → UPDATE runs row (ended_at, exit_reason)
  └─ Memory.close()
```

If any of the above throws, the catch logs `[memory] warning: <message>` to stderr and the run continues. No memory error propagates to the caller.

## 4. Schema

Migration `001_initial`:

```sql
-- One row per `glean run` invocation.
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,            -- uuid v4
  started_at      INTEGER NOT NULL,            -- unix ms
  ended_at        INTEGER,                     -- unix ms; null while in progress
  project_path    TEXT NOT NULL,
  budget_seconds  INTEGER NOT NULL,
  max_parallel    INTEGER NOT NULL,
  exit_reason     TEXT,                        -- 'completed' | 'wall-clock' | 'stop-sentinel' | 'rate-limit' | 'error'
  glean_version   TEXT NOT NULL
);

CREATE INDEX idx_runs_started_at ON runs(started_at);

-- One row per candidate considered in a run (ran OR skipped OR errored).
CREATE TABLE candidates (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id),
  fingerprint              TEXT NOT NULL,       -- stable hash across runs
  candidate_type           TEXT NOT NULL,       -- 'research-dossier' | 'fetch-docs'
  title                    TEXT NOT NULL,
  source_signal            TEXT NOT NULL,       -- 'jsonl' | 'git-todo' | 'gh-pr' | 'deps'
  file_path                TEXT,                -- nullable for non-file-scoped candidates
  est_value                REAL NOT NULL,
  est_tokens               INTEGER NOT NULL,
  priority_rank            INTEGER NOT NULL,    -- position in this run's queue (0 = highest)
  outcome                  TEXT,                -- 'ran' | 'skipped' | 'repaired' | 'rate-limited' | 'timed-out' | 'errored'; null = enqueued-but-never-settled
  dossier_path             TEXT,                -- path to OUT.md when outcome='ran'
  started_at               INTEGER,             -- unix ms
  ended_at                 INTEGER,
  duration_ms              INTEGER,
  bytes_written            INTEGER,             -- size of OUT.md
  stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
```

Then `PRAGMA user_version = 1`.

Schema covers all three loops:

- **Suppress duds** — `SELECT fingerprint, COUNT(*) FROM candidates WHERE outcome IN ('skipped','errored') GROUP BY fingerprint HAVING COUNT(*) > N`.
- **Realized value** — `bytes_written` is a usefulness proxy now; a future migration can add a `dossier_outcomes` table populated by a sweep that checks `dossier_path` existence on disk after 7 days.
- **Adapt budgets** — `SELECT candidate_type, AVG(duration_ms), SUM(stderr_rate_limit_hits) FROM candidates GROUP BY candidate_type, run_id JOIN runs USING (run_id)`.

## 5. Module details

### 5.1 `src/lib/memory.ts`

```ts
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ExitReason = 'completed' | 'wall-clock' | 'stop-sentinel' | 'rate-limit' | 'error';
export type Outcome = 'ran' | 'skipped' | 'repaired' | 'rate-limited' | 'timed-out' | 'errored';
export type CandidateType = 'research-dossier' | 'fetch-docs';
export type SourceSignal = 'jsonl' | 'git-todo' | 'gh-pr' | 'deps';

export interface RunStart {
  project_path: string;
  budget_seconds: number;
  max_parallel: number;
  glean_version: string;
}

export interface CandidateRecord {
  candidate_type: CandidateType;
  title: string;
  source_signal: SourceSignal;
  file_path: string | null;
  est_value: number;
  est_tokens: number;
  priority_rank: number;
  fingerprint_input: FingerprintInput;
}

export interface FingerprintInput {
  project_path: string;
  candidate_type: CandidateType;
  file_path: string | null;
  title: string;
}

export interface OutcomeFields {
  dossier_path?: string;
  started_at?: number;
  ended_at?: number;
  duration_ms?: number;
  bytes_written?: number;
  stderr_rate_limit_hits?: number;
}

export function fingerprintCandidate(input: FingerprintInput): string {
  const norm = input.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = [input.project_path, input.candidate_type, input.file_path ?? '', norm].join('|');
  return createHash('sha256').update(key).digest('hex');
}

export class Memory {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    const version = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (version < 1) {
      this.db.exec(/* runs + candidates tables + indexes — see §4 */);
      this.db.pragma('user_version = 1');
    }
    // Future migrations: if (version < 2) { ... }
  }

  recordRun(run: RunStart): string {
    const run_id = randomUUID();
    this.db.prepare(/* INSERT INTO runs ... */).run({
      run_id,
      started_at: Date.now(),
      ...run,
    });
    return run_id;
  }

  endRun(run_id: string, exit_reason: ExitReason): void {
    this.db.prepare(/* UPDATE runs SET ended_at=?, exit_reason=? WHERE run_id=? */)
      .run(Date.now(), exit_reason, run_id);
  }

  recordCandidate(run_id: string, c: CandidateRecord): number {
    const fingerprint = fingerprintCandidate(c.fingerprint_input);
    const info = this.db.prepare(/* INSERT INTO candidates ... */).run({
      run_id,
      fingerprint,
      candidate_type: c.candidate_type,
      title: c.title,
      source_signal: c.source_signal,
      file_path: c.file_path,
      est_value: c.est_value,
      est_tokens: c.est_tokens,
      priority_rank: c.priority_rank,
    });
    return info.lastInsertRowid as number;
  }

  recordOutcome(candidate_id: number, outcome: Outcome, fields: OutcomeFields = {}): void {
    this.db.prepare(/* UPDATE candidates SET outcome=?, dossier_path=?, started_at=?, ended_at=?, duration_ms=?, bytes_written=?, stderr_rate_limit_hits=? WHERE id=? */)
      .run(outcome, fields.dossier_path ?? null, fields.started_at ?? null, fields.ended_at ?? null, fields.duration_ms ?? null, fields.bytes_written ?? null, fields.stderr_rate_limit_hits ?? 0, candidate_id);
  }

  close(): void {
    this.db.close();
  }
}
```

(Signatures and types are normative; SQL strings are sketched but final wording is implementation detail.)

### 5.2 `src/lib/pipeline.ts` integration

Two changes:

1. Before the discovery/prioritization steps, open `Memory` and call `recordRun`. Resolve `dbPath` from `state.ts` (existing convention puts state under `%USERPROFILE%\glean\`).
2. After prioritization, loop over candidates and call `recordCandidate`, storing the returned `candidateId` alongside the candidate (e.g., on the in-memory object) so the executor can reference it.
3. Wrap the executor loop in `try { ... } finally { memory.endRun(runId, exitReason); memory.close(); }`. `exitReason` is determined by which terminator fired (existing logic — wall-clock vs stop-sentinel vs rate-limit vs completed; `'error'` if an unexpected throw).

All `Memory` calls are wrapped in `try/catch` that logs `[memory] warning: <message>` and continues. The engine has no behavior change if `memory.db` is unavailable.

### 5.3 `src/lib/executor.ts` integration

The executor already receives a candidate; it now also accepts a `recordOutcome` callback typed as `(outcome: Outcome, fields: OutcomeFields) => void`. This keeps `executor.ts` decoupled from `Memory` — the pipeline owns the `Memory` instance and binds the candidateId into each callback before passing it to the executor (`(outcome, fields) => memory.recordOutcome(candidateId, outcome, fields)`). After each task settles, the executor calls the callback with:

- `outcome` — derived from existing branch (ran successfully / skipped via STOP / hit timeout / hit rate-limit / threw).
- `dossier_path` — the OUT.md path if `outcome === 'ran'`.
- `started_at` / `ended_at` / `duration_ms` — already tracked in executor.
- `bytes_written` — `statSync(dossierPath).size` if the file exists.
- `stderr_rate_limit_hits` — count of matched signals from the existing stderr parser.

Wrapped in try/catch like the pipeline calls.

## 6. Module changes

| File | Change |
|---|---|
| `src/lib/memory.ts` | **New.** Memory class + fingerprintCandidate + migrations. ~150 LOC. |
| `src/lib/memory.test.ts` | **New.** Unit tests against `:memory:` DB. ~5 tests. |
| `src/lib/pipeline.ts` | Wire in `Memory` lifecycle (open, recordRun, recordCandidate, endRun in finally, close). ~15 LOC delta. |
| `src/lib/executor.ts` | Accept and call `recordOutcome` callback after each task. ~10 LOC delta. |
| `test/integration/v02-memory.test.ts` | **New.** End-to-end test using fake-claude fixture; assert rows in `runs` and `candidates`. ~1–2 tests. |
| `src/lib/types.ts` | Add `candidateId?: number` field to internal Candidate type (optional, populated post-prioritization). |
| `package.json` | Add `better-sqlite3` dependency. Bump version to `0.2.0`. |
| `CHANGELOG.md` | v0.2.0 entry. |
| `docs/ROADMAP.md` | Move "Persistent memory substrate" from **Up next** to **Done**. |

## 7. Testing plan

Per `glean.md` §8 verification checklist conventions, plus loop-enablement assertions:

### 7.1 Unit tests (`src/lib/memory.test.ts`)

1. **Migration on fresh DB** — open `:memory:` DB; assert `runs` and `candidates` tables exist; assert `PRAGMA user_version === 1`.
2. **Migration idempotency** — open same DB twice; second `migrate()` is a no-op (no error, schema unchanged).
3. **Fingerprint stability** — `fingerprintCandidate` with identical input twice → identical hash. Title whitespace/case differences → identical hash. Different `file_path` → different hash.
4. **Run lifecycle** — `recordRun` returns a uuid; row exists; `endRun` updates `ended_at` and `exit_reason`.
5. **Candidate lifecycle** — `recordCandidate` returns row id; row has correct fingerprint; `recordOutcome` updates outcome and timing fields.

### 7.2 Integration test (`test/integration/v02-memory.test.ts`)

Run a complete `glean run` using the existing fake-claude fixture against a temp project. Assert:

- Exactly one row in `runs` with the expected `project_path`, `budget_seconds`, `exit_reason === 'completed'`.
- N rows in `candidates` matching the fixture's expected candidate count.
- Each row has a non-null `outcome` and `priority_rank` matching the queue order.
- `bytes_written` matches `statSync` on the actual OUT.md files.

### 7.3 Regression discipline

All existing 81 tests must continue to pass with `memory.db` enabled. Plus: a test that points `Memory` at an unwritable path → run completes successfully with a stderr warning, zero new rows.

## 8. Out of scope (explicit)

- No `glean memory` / `glean stats` / `glean show` subcommand.
- No query API exposed from `Memory` (only writes). Future learning-loop sub-projects add reads.
- No retrofit of pre-v0.2.0 runs.
- No dossier-outcome sweep (the "still on disk after 7 days" check). Schema permits it via a future `dossier_outcomes` table; not built now.
- No cross-machine sync. `memory.db` is local-only.
- No encryption. Sensitive content lives in dossiers (already on the filesystem); the DB has no incremental sensitivity.
- No ranking change. Discovery and prioritization use existing heuristics; the substrate observes only.
- No POSIX port work bundled in. `better-sqlite3` happens to work on POSIX too, but the POSIX port has separate scope (Up Next #2 in roadmap).

## 9. Rollback / failure modes

- **`better-sqlite3` won't install on user's machine** — install requires a prebuilt binary (available for Windows x64 Node 18/20/22). If install fails, `npm i -g glean` fails. No graceful degradation at install time; this is a hard dep.
- **`memory.db` is locked / corrupt at runtime** — `new Database(...)` throws; pipeline's try/catch logs warning; run continues with `Memory` calls all no-ops (wrap in a `NullMemory` fallback class).
- **Schema migration fails mid-apply** — `migrate()` runs in a transaction; on error, the transaction rolls back, `user_version` stays at 0, next run retries. Logged as a warning.
- **User wants to wipe history** — `rm %USERPROFILE%\glean\memory.db`; next run recreates from scratch. Document this in CHANGELOG.

## 10. Open questions deferred (do NOT pre-decide)

- Whether to add a `glean stats` subcommand in v0.3 (depends on whether the data turns out to be interesting).
- Whether to layer in a dossier-existence sweep (Loop 2 enablement) as a separate cron-like hook or as part of `glean run` cleanup.
- Whether to add `parent_run_id` for resumed runs once "Resume after crash" lands (currently in Tracked backlog).
- Whether to also record `candidates` for runs that exit before prioritization (e.g., immediately stopped). Current design: no. Revisit if it bites.
