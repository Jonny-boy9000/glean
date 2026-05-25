# Glean v0.2.0 Memory Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite-backed run/candidate history store as pure infrastructure. Every `glean run` records what was discovered, prioritized, executed, and how it ended. Substrate only — no CLI surface, no learning behavior. Ships as `v0.2.0`.

**Architecture:** New module `src/lib/memory.ts` owns a `better-sqlite3` connection and migration logic. Pipeline opens `Memory` at run start, calls `recordRun`/`recordCandidate`, and wraps the executor loop in `try`/`finally` so `endRun` always fires. Executor accepts a bound `recordOutcome` callback so it stays decoupled from `Memory`. All memory calls are wrapped in try/catch — failures log a warning and the engine continues normally.

**Tech Stack:** Node 20, TypeScript, vitest (existing). One new runtime dep: `better-sqlite3` (synchronous SQLite, prebuilt Windows binaries).

**Spec:** `docs/superpowers/specs/2026-05-25-glean-memory-substrate-design.md`. Read it first; this plan implements it.

---

## Type-reuse note (minor deviation from spec)

The spec §5.1 introduced new type names (`ExitReason`, `Outcome`). To minimize churn against the existing codebase, this plan **reuses the existing types** from `src/lib/types.ts`:

- `Memory.endRun` accepts `RunReason` (existing enum: `'completed' | 'no-candidates' | 'budget-exhausted' | 'rate-limit' | 'stop-sentinel' | 'lock-busy' | 'crashed'`) and stores it in the `exit_reason` column.
- `Memory.recordOutcome` accepts `CandidateStatus` (existing enum: `'pending' | 'running' | 'ok' | 'ok-fallback' | 'timeout' | 'failed' | 'rate-limit' | 'skipped'`) and stores it in the `outcome` column.
- The `run_id` is the existing pipeline-generated id (format `YYYY-MM-DD-HHMM-xxxxxx`), not a fresh UUID v4. `recordRun(runId, ...)` takes the runId as a parameter rather than generating one. This keeps DB rows joinable with `state/<runId>/summary.json`, `candidates.json`, and `logs/<runId>/orchestrator.log`.

The schema columns keep their generic names (`exit_reason`, `outcome`) — the enum values are simply the existing strings.

---

## File Structure

```
C:\Glean\
  src\lib\
    memory.ts                NEW    — Memory class + fingerprintCandidate + migrations
    memory.test.ts           NEW    — unit tests against :memory: SQLite
    pipeline.ts              MODIFY — open Memory, recordRun/recordCandidate, endRun in finally
    executor.ts              MODIFY — accept recordOutcome callback param, call after each task
    types.ts                 MODIFY — add optional candidate_row_id field to Candidate
  test\integration\
    v13-memory.test.ts       NEW    — end-to-end fake-claude run; assert DB rows
    v14-memory-failure.test.ts NEW  — unwritable memory.db → run completes with warning
  package.json               MODIFY — add better-sqlite3 + @types/better-sqlite3, bump to 0.2.0
  CHANGELOG.md               MODIFY — v0.2.0 entry
  docs\ROADMAP.md            MODIFY — move "Persistent memory substrate" to Done
```

---

## Task ordering

Branch first (Task 1). Add the dep (Task 2). Build the module bottom-up with TDD (Tasks 3–6: fingerprint → open/migrate → run lifecycle → candidate lifecycle). Wire the executor callback (Task 7), then the pipeline (Task 8) — order matters because pipeline depends on executor's new signature. Integration tests (Tasks 9–10). Housekeeping (Task 11). Merge + tag (Task 12).

---

## Task 1: Create the v0.2.0 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, HEAD at `f45685d` (the memory-substrate spec commit) or later, on `main`.

- [ ] **Step 2: Create and switch to branch**

```bash
cd /c/Glean && git checkout -b v0.2.0 && git branch --show-current
```
Expected: `v0.2.0`.

---

## Task 2: Install better-sqlite3

**Files:**
- Modify: `C:\Glean\package.json`

- [ ] **Step 1: Install runtime dep**

```bash
cd /c/Glean && npm install better-sqlite3
```
Expected: `better-sqlite3` added under `dependencies` in `package.json`. The native binary is downloaded as a prebuilt for Windows x64 + Node 20.

- [ ] **Step 2: Install type definitions**

```bash
cd /c/Glean && npm install --save-dev @types/better-sqlite3
```
Expected: `@types/better-sqlite3` added under `devDependencies`.

- [ ] **Step 3: Smoke-test the install**

```bash
cd /c/Glean && node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE t (x INTEGER)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log(db.prepare('SELECT * FROM t').all())"
```
Expected: `[ { x: 1 } ]`. If this fails, the prebuilt binary didn't download — see better-sqlite3 docs for `npm rebuild`.

- [ ] **Step 4: Commit**

```bash
cd /c/Glean && git add package.json package-lock.json && git commit -m "chore: add better-sqlite3 for memory substrate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `fingerprintCandidate` function (TDD)

**Files:**
- Create: `C:\Glean\src\lib\memory.ts`
- Create: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing test

Create `C:\Glean\src\lib\memory.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest';
import { fingerprintCandidate } from './memory.js';

describe('fingerprintCandidate', () => {
  it('returns identical hash for identical input', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes whitespace and case in title', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO   in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'HANDLE todo IN SRC/FOO.TS',
    });
    expect(a).toBe(b);
  });

  it('produces different hash for different file_path', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/bar.ts',
      title: 'Handle TODO',
    });
    expect(a).not.toBe(b);
  });

  it('treats null file_path as empty string', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'fetch-docs',
      file_path: null,
      title: 'Pre-fetch docs for lodash',
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

### Step 2: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: FAIL with "Cannot find module './memory.js'" or similar (the file doesn't exist yet).

### Step 3: Write minimal `memory.ts`

Create `C:\Glean\src\lib\memory.ts`:

```ts
import { createHash } from 'node:crypto';

export interface FingerprintInput {
  project_path: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  file_path: string | null;
  title: string;
}

export function fingerprintCandidate(input: FingerprintInput): string {
  const norm = input.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = [
    input.project_path,
    input.candidate_type,
    input.file_path ?? '',
    norm,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
```

### Step 4: Run the test to verify it passes

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: 4 passed.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): fingerprintCandidate for stable cross-run identity

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `Memory` class — open + migrate (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing test

Append to `C:\Glean\src\lib\memory.test.ts` (after the existing `describe('fingerprintCandidate', ...)` block):

```ts
import { Memory } from './memory.js';

describe('Memory open + migrate', () => {
  it('creates the schema on a fresh DB and sets user_version=1', () => {
    const m = new Memory(':memory:');
    const rows = (m as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(rows).toEqual([{ name: 'candidates' }, { name: 'runs' }]);
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(1);
    m.close();
  });

  it('is idempotent — opening twice does not error', () => {
    // Opening :memory: creates a fresh DB each time, so use a file path via tmpdir
    const dir = mkdtempSync(join(tmpdir(), 'glean-mem-'));
    const path = join(dir, 'memory.db');
    const m1 = new Memory(path);
    m1.close();
    const m2 = new Memory(path);
    const v = (m2 as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(1);
    m2.close();
  });
});
```

Also add these imports to the top of `src/lib/memory.test.ts` if not already present (above the existing `describe` blocks):

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

### Step 2: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: FAIL — `Memory is not exported`.

### Step 3: Extend `memory.ts` with the Memory class

Replace the contents of `C:\Glean\src\lib\memory.ts` with:

```ts
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FingerprintInput {
  project_path: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  file_path: string | null;
  title: string;
}

export function fingerprintCandidate(input: FingerprintInput): string {
  const norm = input.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = [
    input.project_path,
    input.candidate_type,
    input.file_path ?? '',
    norm,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

const SCHEMA_V1 = `
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  project_path    TEXT NOT NULL,
  budget_seconds  INTEGER NOT NULL,
  max_parallel    INTEGER NOT NULL,
  exit_reason     TEXT,
  glean_version   TEXT NOT NULL
);

CREATE INDEX idx_runs_started_at ON runs(started_at);

CREATE TABLE candidates (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id),
  candidate_slug           TEXT NOT NULL,
  fingerprint              TEXT NOT NULL,
  candidate_type           TEXT NOT NULL,
  title                    TEXT NOT NULL,
  source_signal            TEXT NOT NULL,
  file_path                TEXT,
  est_value                REAL NOT NULL,
  est_tokens               INTEGER NOT NULL,
  priority_rank            INTEGER NOT NULL,
  outcome                  TEXT,
  dossier_path             TEXT,
  started_at               INTEGER,
  ended_at                 INTEGER,
  duration_ms              INTEGER,
  bytes_written            INTEGER,
  stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
`;

export class Memory {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

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
  }

  close(): void {
    this.db.close();
  }
}
```

### Step 4: Run the tests to verify they pass

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: 6 passed (4 from Task 3 + 2 new).

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): Memory class with schema migration v1

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Run lifecycle — `recordRun` + `endRun` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing test

Append to `C:\Glean\src\lib\memory.test.ts`:

```ts
import type { RunReason } from './types.js';

describe('Memory run lifecycle', () => {
  it('records a run and updates ended_at + exit_reason on endRun', () => {
    const m = new Memory(':memory:');
    m.recordRun('2026-05-25-1730-abc123', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const before = (m as unknown as { db: { prepare: (s: string) => { get: (k: string) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM runs WHERE run_id = ?').get('2026-05-25-1730-abc123');
    expect(before.project_path).toBe('C:\\Glean');
    expect(before.budget_seconds).toBe(3600);
    expect(before.ended_at).toBeNull();
    expect(before.exit_reason).toBeNull();
    expect(typeof before.started_at).toBe('number');

    m.endRun('2026-05-25-1730-abc123', 'completed' as RunReason);
    const after = (m as unknown as { db: { prepare: (s: string) => { get: (k: string) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM runs WHERE run_id = ?').get('2026-05-25-1730-abc123');
    expect(after.ended_at).not.toBeNull();
    expect(after.exit_reason).toBe('completed');
    m.close();
  });
});
```

### Step 2: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: FAIL — `m.recordRun is not a function`.

### Step 3: Add `recordRun` and `endRun` to `Memory`

Add the following methods to the `Memory` class in `C:\Glean\src\lib\memory.ts` (after `migrate`, before `close`):

```ts
  recordRun(
    runId: string,
    run: {
      project_path: string;
      budget_seconds: number;
      max_parallel: number;
      glean_version: string;
    },
  ): void {
    this.db.prepare(
      `INSERT INTO runs (run_id, started_at, project_path, budget_seconds, max_parallel, glean_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      Date.now(),
      run.project_path,
      run.budget_seconds,
      run.max_parallel,
      run.glean_version,
    );
  }

  endRun(runId: string, exitReason: string): void {
    this.db.prepare(
      'UPDATE runs SET ended_at = ?, exit_reason = ? WHERE run_id = ?',
    ).run(Date.now(), exitReason, runId);
  }
```

Note: `exitReason` is typed `string` rather than the `RunReason` union to keep `memory.ts` independent of `types.ts` — the caller (pipeline) narrows it.

### Step 4: Run the tests

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: 7 passed.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): recordRun and endRun for run lifecycle

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Candidate lifecycle — `recordCandidate` + `recordOutcome` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing test

Append to `C:\Glean\src\lib\memory.test.ts`:

```ts
describe('Memory candidate lifecycle', () => {
  it('records a candidate row, returns its integer id, and updates on outcome', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-1', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const candidateId = m.recordCandidate('run-1', {
      candidate_slug: 'c-1',
      candidate_type: 'research-dossier',
      title: 'Handle TODO in src/foo.ts',
      source_signal: 'git-todo',
      file_path: 'src/foo.ts',
      est_value: 0.8,
      est_tokens: 1200,
      priority_rank: 0,
    });
    expect(typeof candidateId).toBe('number');
    expect(candidateId).toBeGreaterThan(0);

    const row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    expect(row.run_id).toBe('run-1');
    expect(row.candidate_slug).toBe('c-1');
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.candidate_type).toBe('research-dossier');
    expect(row.outcome).toBeNull();

    m.recordOutcome(candidateId, 'ok', {
      dossier_path: 'C:\\foo\\OUT.md',
      started_at: 1_700_000_000_000,
      ended_at: 1_700_000_120_000,
      duration_ms: 120_000,
      bytes_written: 4096,
      stderr_rate_limit_hits: 0,
    });
    const after = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    expect(after.outcome).toBe('ok');
    expect(after.dossier_path).toBe('C:\\foo\\OUT.md');
    expect(after.duration_ms).toBe(120_000);
    expect(after.bytes_written).toBe(4096);
    m.close();
  });

  it('accepts a candidate with null file_path', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-2', {
      project_path: 'C:\\Glean',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.2.0',
    });
    const id = m.recordCandidate('run-2', {
      candidate_slug: 'c-2',
      candidate_type: 'fetch-docs',
      title: 'Pre-fetch docs for lodash',
      source_signal: 'deps',
      file_path: null,
      est_value: 0.3,
      est_tokens: 600,
      priority_rank: 1,
    });
    expect(id).toBeGreaterThan(0);
    m.close();
  });
});
```

### Step 2: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: FAIL — `m.recordCandidate is not a function`.

### Step 3: Add `recordCandidate` and `recordOutcome`

Add to the `Memory` class in `C:\Glean\src\lib\memory.ts` (before `close`):

```ts
  recordCandidate(
    runId: string,
    c: {
      candidate_slug: string;
      candidate_type: 'research-dossier' | 'fetch-docs';
      title: string;
      source_signal: 'jsonl' | 'git-todo' | 'gh-pr' | 'deps';
      file_path: string | null;
      est_value: number;
      est_tokens: number;
      priority_rank: number;
    },
  ): number {
    const fingerprint = fingerprintCandidate({
      project_path: this.projectPathFor(runId),
      candidate_type: c.candidate_type,
      file_path: c.file_path,
      title: c.title,
    });
    const info = this.db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId, c.candidate_slug, fingerprint, c.candidate_type, c.title, c.source_signal,
      c.file_path, c.est_value, c.est_tokens, c.priority_rank,
    );
    return Number(info.lastInsertRowid);
  }

  recordOutcome(
    candidateId: number,
    outcome: string,
    fields: {
      dossier_path?: string;
      started_at?: number;
      ended_at?: number;
      duration_ms?: number;
      bytes_written?: number;
      stderr_rate_limit_hits?: number;
    } = {},
  ): void {
    this.db.prepare(
      `UPDATE candidates
         SET outcome = ?, dossier_path = ?, started_at = ?, ended_at = ?,
             duration_ms = ?, bytes_written = ?, stderr_rate_limit_hits = ?
       WHERE id = ?`,
    ).run(
      outcome,
      fields.dossier_path ?? null,
      fields.started_at ?? null,
      fields.ended_at ?? null,
      fields.duration_ms ?? null,
      fields.bytes_written ?? null,
      fields.stderr_rate_limit_hits ?? 0,
      candidateId,
    );
  }

  private projectPathFor(runId: string): string {
    const row = this.db.prepare('SELECT project_path FROM runs WHERE run_id = ?').get(runId) as
      { project_path: string } | undefined;
    if (!row) throw new Error(`memory: unknown run_id ${runId}`);
    return row.project_path;
  }
```

### Step 4: Run the tests

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: 9 passed.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): recordCandidate and recordOutcome with fingerprinting

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Wire `executor.ts` to accept a `recordOutcome` callback

**Files:**
- Modify: `C:\Glean\src\lib\executor.ts`

The executor is decoupled from `Memory` — it only sees a callback. The pipeline binds `candidateId` into the callback before passing it.

### Step 1: Write the failing test

Append a new test to `C:\Glean\src\lib\executor.test.ts`. First inspect existing tests to match style:

```bash
cd /c/Glean && head -30 src/lib/executor.test.ts
```

Then append a test inside the existing `describe` block (read the file to find the right spot — typically right before the final `});`):

```ts
it('invokes recordOutcome callback exactly once with the final status and fields', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'glean-exec-cb-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
  execSync('git add . && git commit -q -m i', { cwd: repo });

  const home = mkdtempSync(join(tmpdir(), 'glean-exec-home-'));
  mkdirSync(join(home, 'glean', 'templates'), { recursive: true });
  copyFileSync(
    join(process.cwd(), 'templates', 'research-dossier.md'),
    join(home, 'glean', 'templates', 'research-dossier.md'),
  );

  const calls: Array<{ status: string; fields: Record<string, unknown> }> = [];
  const candidate: Candidate = {
    id: 'c-1',
    evidence_hash: 'h1',
    type: 'research-dossier',
    project_path: repo,
    evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: x' }] },
    est_value: 0.5,
    est_tokens: 500,
    status: 'pending',
  };
  const fakeClaude = process.platform === 'win32'
    ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
    : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
  const result = await executeOne(candidate, {
    runId: 'r-1',
    gleanRoot: join(home, 'glean'),
    claudeBin: fakeClaude,
    templatesDir: join(process.cwd(), 'templates'),
    taskTimeoutMs: 60_000,
    env: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml'),
    },
    recordOutcome: (status, fields) => calls.push({ status, fields }),
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].status).toBe(result.status);
  expect(calls[0].fields.duration_ms).toBe(result.elapsed_ms);
});
```

Add the missing imports to the top of `executor.test.ts` if not already present:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from './types.js';
import { executeOne } from './executor.js';
```

(Skip any that are already imported; do not duplicate.)

### Step 2: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts
```
Expected: FAIL — type error or "recordOutcome is not a function". TypeScript may also flag the unknown property on `ExecCtx`.

### Step 3: Add the callback parameter to `ExecCtx` and call it

In `C:\Glean\src\lib\executor.ts`, update the `ExecCtx` type:

```ts
export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  recordOutcome?: (status: TaskResult['status'], fields: {
    dossier_path?: string;
    started_at?: number;
    ended_at?: number;
    duration_ms?: number;
    bytes_written?: number;
    stderr_rate_limit_hits?: number;
  }) => void;
};
```

Then, immediately before each `return { status: ..., elapsed_ms ... };` in `executeOne`, call the callback. The cleanest way is to wrap the existing return statements with a helper. Replace the body of `executeOne` from the `if (rateLimited) return ...` line down to the final `return { status: 'ok-fallback', ... };` with the following:

```ts
  const startedAt = start;
  const endedAt = Date.now();
  const elapsed_ms = endedAt - startedAt;

  const finalize = (status: TaskResult['status'], output_path: string | undefined, stderr_tail: string[] | undefined): TaskResult => {
    let bytes_written: number | undefined;
    if (output_path) {
      try { bytes_written = readFileSync(output_path).length; } catch { /* ignore */ }
    }
    try {
      ctx.recordOutcome?.(status, {
        dossier_path: output_path,
        started_at: startedAt,
        ended_at: endedAt,
        duration_ms: elapsed_ms,
        bytes_written,
        stderr_rate_limit_hits: rateLimited ? 1 : 0,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`);
    }
    const result: TaskResult = { status, elapsed_ms };
    if (output_path) result.output_path = output_path;
    if (stderr_tail) result.stderr_tail = stderr_tail;
    return result;
  };

  if (rateLimited) return finalize('rate-limit', undefined, undefined);
  if (timedOut) return finalize('timeout', undefined, undefined);
  if (exitCode !== 0) {
    const tail = tailLines(readFileSync(stderrPath, 'utf8'), 50);
    return finalize('failed', undefined, tail);
  }

  const outPath = c.type === 'research-dossier' ? join(workDir, 'OUT.md') : findFirstFile(workDir, /\.md$/);
  if (outPath && existsSync(outPath)) {
    const bytes = readFileSync(outPath).length;
    if (bytes < 50) {
      const fallback = extractLastAssistantText(jsonlPath);
      writeFileSync(outPath, fallback);
      return finalize('ok-fallback', outPath, undefined);
    }
    return finalize('ok', outPath, undefined);
  }
  const fallback = extractLastAssistantText(jsonlPath);
  const fallbackPath = join(workDir, 'OUT.md');
  writeFileSync(fallbackPath, fallback);
  return finalize('ok-fallback', fallbackPath, undefined);
}
```

Note: `start` is defined earlier in the function; `startedAt = start` aliases it so the callback gets the same value the elapsed_ms uses.

### Step 4: Run the tests

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts
```
Expected: all executor tests pass, including the new callback test.

Also run the full test suite to catch regressions:

```bash
cd /c/Glean && npm test
```
Expected: previous 81 passing tests still pass; new test passes; total now ~82.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/executor.ts src/lib/executor.test.ts && git commit -m "feat(executor): accept recordOutcome callback for memory substrate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Wire `pipeline.ts` to open `Memory` + record run and candidates

**Files:**
- Modify: `C:\Glean\src\lib\pipeline.ts`
- Modify: `C:\Glean\src\lib\types.ts`

### Step 1: Add a `candidate_row_id` field to `Candidate`

In `C:\Glean\src\lib\types.ts`, add an optional field to the `Candidate` type. Find the `Candidate` type and add `candidate_row_id?: number;` at the end:

```ts
export type Candidate = {
  id: string;
  evidence_hash: string;
  type: CandidateType;
  project_path: string;
  evidence: Evidence;
  est_value: number;
  est_tokens: number;
  rank?: number;
  status: CandidateStatus;
  candidate_row_id?: number;
};
```

This is the integer PK returned by `recordCandidate`, used by the pipeline to bind the callback for the executor.

### Step 2: Read the pipeline test file to understand the existing test pattern

```bash
cd /c/Glean && head -50 src/lib/pipeline.test.ts
```

Find an existing test that exercises a real `runPipeline` call. Reuse its setup (temp repo + fake-claude + temp home).

### Step 3: Write the failing test

Append to `C:\Glean\src\lib\pipeline.test.ts` (inside the main `describe` block, near the end):

```ts
it('writes a runs row and candidates rows to memory.db', async () => {
  // Set up exactly like the existing pipeline tests
  const repo = mkdtempSync(join(tmpdir(), 'glean-pipe-mem-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
  execSync('git add . && git commit -q -m i', { cwd: repo });

  const home = mkdtempSync(join(tmpdir(), 'glean-pipe-mem-home-'));
  mkdirSync(join(home, 'glean'), { recursive: true });
  const gleanRoot = join(home, 'glean');
  const fakeClaude = process.platform === 'win32'
    ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
    : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');

  const summary = await runPipeline({
    projectPath: repo,
    gleanRoot,
    claudeBin: fakeClaude,
    claudeEnv: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml'),
    } as NodeJS.ProcessEnv,
    budgetMs: 60 * 60_000,
    taskTimeoutMs: 60_000,
    dryRun: false,
    templatesDir: join(process.cwd(), 'templates'),
  });

  // Open the DB and inspect rows
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(gleanRoot, 'memory.db'), { readonly: true });
  const runs = db.prepare('SELECT * FROM runs').all() as Array<Record<string, unknown>>;
  expect(runs).toHaveLength(1);
  expect(runs[0].run_id).toBe(summary.run_id);
  expect(runs[0].project_path).toBe(repo);
  expect(runs[0].exit_reason).toBe(summary.reason);
  expect(runs[0].ended_at).not.toBeNull();

  const candidates = db.prepare('SELECT * FROM candidates ORDER BY priority_rank').all() as Array<Record<string, unknown>>;
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.every((c) => c.outcome !== null)).toBe(true);
  db.close();
});
```

If imports are missing, add at top: `import { execSync } from 'node:child_process'; import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` and `import { runPipeline } from './pipeline.js';` (skip duplicates).

### Step 4: Run the test to verify it fails

```bash
cd /c/Glean && npx vitest run src/lib/pipeline.test.ts
```
Expected: FAIL — `memory.db` does not exist (no Memory wired in yet).

### Step 5: Wire `Memory` into `pipeline.ts`

In `C:\Glean\src\lib\pipeline.ts`:

1. Add the import at the top:
   ```ts
   import { Memory } from './memory.js';
   ```

2. Add a helper at the top that loads `package.json` for the version. Below the imports, add:
   ```ts
   import { readFileSync as _readFileSyncForVersion } from 'node:fs';
   import { fileURLToPath } from 'node:url';
   import { dirname as _dirname, join as _join } from 'node:path';
   function gleanVersion(): string {
     try {
       const here = _dirname(fileURLToPath(import.meta.url));
       const pkg = JSON.parse(_readFileSyncForVersion(_join(here, '..', '..', 'package.json'), 'utf8'));
       return pkg.version ?? 'unknown';
     } catch { return 'unknown'; }
   }
   ```

3. Inside `runPipeline`, immediately after the existing `if (lock.recovered) appendOrchestratorLog(...)` line but BEFORE the `try {` block, open the Memory instance. Wrap in try/catch so failure does not propagate:
   ```ts
   let memory: Memory | null = null;
   try {
     memory = new Memory(join(opts.gleanRoot, 'memory.db'));
     memory.recordRun(runId, {
       project_path: opts.projectPath,
       budget_seconds: Math.round(opts.budgetMs / 1000),
       max_parallel: 1,
       glean_version: gleanVersion(),
     });
   } catch (e) {
     process.stderr.write(`[memory] warning: open/recordRun failed: ${(e as Error).message}\n`);
     memory = null;
   }
   ```

   (`join` is already imported at the top.)

4. Inside the existing `try { ... } finally { releaseLock(...) }` block, after the `ranked` array is built and after `writeCandidatesJson`, but BEFORE the executor loop, record each candidate:
   ```ts
   if (memory) {
     for (let i = 0; i < ranked.length; i++) {
       const c = ranked[i];
       try {
         const rowId = memory.recordCandidate(runId, {
           candidate_slug: c.id,
           candidate_type: c.type,
           title: titleFor(c),
           source_signal: sourceSignalFor(c),
           file_path: filePathFor(c),
           est_value: c.est_value,
           est_tokens: c.est_tokens,
           priority_rank: i,
         });
         c.candidate_row_id = rowId;
       } catch (e) {
         process.stderr.write(`[memory] warning: recordCandidate failed: ${(e as Error).message}\n`);
       }
     }
   }
   ```

5. Update the `executeOne` call inside the loop to pass the bound callback. Find the existing `await executeOne(c, { ... })` call and add `recordOutcome` to the ctx object:
   ```ts
   const result = await executeOne(c, {
     runId,
     gleanRoot: opts.gleanRoot,
     claudeBin: opts.claudeBin,
     templatesDir: opts.templatesDir,
     taskTimeoutMs: opts.taskTimeoutMs,
     env: opts.claudeEnv,
     recordOutcome: memory && c.candidate_row_id !== undefined
       ? ((status, fields) => {
           try { memory!.recordOutcome(c.candidate_row_id!, status, fields); }
           catch (e) { process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`); }
         })
       : undefined,
   });
   ```

6. In the `finally` block (where `releaseLock` is called), close the memory connection AFTER calling `endRun`. Replace:
   ```ts
   } finally {
     releaseLock(opts.gleanRoot);
   }
   ```
   with:
   ```ts
   } finally {
     if (memory) {
       try {
         memory.endRun(runId, reason);
       } catch (e) {
         process.stderr.write(`[memory] warning: endRun failed: ${(e as Error).message}\n`);
       }
       try { memory.close(); } catch { /* ignore */ }
     }
     releaseLock(opts.gleanRoot);
   }
   ```

7. Add the two helper functions at the bottom of `pipeline.ts` (before the closing of the module):
   ```ts
   function sourceSignalFor(c: Candidate): 'jsonl' | 'git-todo' | 'gh-pr' | 'deps' {
     switch (c.evidence.kind) {
       case 'jsonl': return 'jsonl';
       case 'todo': return 'git-todo';
       case 'pr': return 'gh-pr';
       case 'dep': return 'deps';
     }
   }

   function filePathFor(c: Candidate): string | null {
     switch (c.evidence.kind) {
       case 'todo': return c.evidence.file;
       case 'jsonl': return null;
       case 'pr': return null;
       case 'dep': return c.evidence.manifest;
     }
   }
   ```

   The existing `titleFor` helper is already in `pipeline.ts` and is reusable as-is.

### Step 6: Run the tests

```bash
cd /c/Glean && npm test
```
Expected: all previous tests still pass; new pipeline test passes. Total: ~83.

### Step 7: Commit

```bash
cd /c/Glean && git add src/lib/pipeline.ts src/lib/pipeline.test.ts src/lib/types.ts && git commit -m "feat(pipeline): wire Memory substrate into runPipeline

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: End-to-end integration test

**Files:**
- Create: `C:\Glean\test\integration\v13-memory.test.ts`

### Step 1: Write the test

Create `C:\Glean\test\integration\v13-memory.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

describe('verification 13: memory substrate end-to-end', () => {
  it('writes runs and candidates rows during a full glean run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v13-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: real thing\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-v13-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');

    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    const dbPath = join(home, 'glean', 'memory.db');
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const runs = db.prepare('SELECT * FROM runs').all() as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0].project_path).toBe(repo);
    expect(runs[0].exit_reason).toBe('completed');
    expect(runs[0].ended_at).not.toBeNull();
    expect(runs[0].glean_version).toMatch(/^\d+\.\d+\.\d+/);

    const candidates = db.prepare('SELECT * FROM candidates ORDER BY priority_rank').all() as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.run_id).toBe(runs[0].run_id);
      expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(c.outcome).not.toBeNull();
      expect(c.candidate_slug).toMatch(/^c-/);
    }
    db.close();
  });
});
```

### Step 2: Run the test

```bash
cd /c/Glean && npx vitest run test/integration/v13-memory.test.ts
```
Expected: PASS.

### Step 3: Run full test suite

```bash
cd /c/Glean && npm test
```
Expected: all tests pass (baseline 81 + 9 new in `memory.test.ts` + 1 new in `executor.test.ts` + 1 new in `pipeline.test.ts` + 1 new in `test/integration/v13-memory.test.ts` ≈ 93 passing + 1 skipped). The exact count is less important than: zero failures and no regressions.

### Step 4: Commit

```bash
cd /c/Glean && git add test/integration/v13-memory.test.ts && git commit -m "test(memory): end-to-end integration test for memory substrate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Failure-mode test — unwritable `memory.db` does not break the run

**Files:**
- Create: `C:\Glean\test\integration\v14-memory-failure.test.ts`

### Step 1: Write the test

Create `C:\Glean\test\integration\v14-memory-failure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 14: memory failure does not break the run', () => {
  it('completes successfully even when memory.db cannot be opened', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v14-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: real thing\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-v14-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');

    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

    // Force open() to fail: create a directory at memory.db's path. better-sqlite3
    // cannot open a directory as a DB file, so the constructor throws.
    mkdirSync(join(home, 'glean', 'memory.db'));

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    // The run should still succeed
    expect(res.status).toBe(0);
    // And the warning should be emitted
    expect(res.stderr).toMatch(/\[memory\] warning:/);
  });
});
```

### Step 2: Run the test

```bash
cd /c/Glean && npx vitest run test/integration/v14-memory-failure.test.ts
```
Expected: PASS — exit 0 and stderr contains the warning.

### Step 3: Commit

```bash
cd /c/Glean && git add test/integration/v14-memory-failure.test.ts && git commit -m "test(memory): unwritable memory.db emits warning and run continues

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Version bump, CHANGELOG, ROADMAP update

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\CHANGELOG.md`
- Modify: `C:\Glean\docs\ROADMAP.md`

### Step 1: Bump the version

Edit `C:\Glean\package.json` and change:
```json
  "version": "0.1.2",
```
to:
```json
  "version": "0.2.0",
```

### Step 2: Add the CHANGELOG entry

Read the existing CHANGELOG to match format:
```bash
cd /c/Glean && head -40 CHANGELOG.md
```

Insert a new section at the top (just below the file header, above the existing v0.1.2 entry):

```markdown
## [0.2.0] — 2026-05-25

### Added
- **Persistent memory substrate.** Every `glean run` now records run metadata and per-candidate outcomes to a local SQLite store at `%USERPROFILE%\glean\memory.db`. Pure infrastructure release — no CLI surface, no behavior change to discovery/prioritization/execution.
  - New module `src/lib/memory.ts` exporting `Memory` class and `fingerprintCandidate` function.
  - Schema migration `v1` creates `runs` and `candidates` tables, designed to support three future learning loops (suppress duds, rank by realized value, adapt budgets).
  - Recording failures are non-fatal: an `[memory] warning:` is logged to stderr and the run continues normally.
- Dependency: `better-sqlite3`.

### Why
Every `glean run` previously rebuilt context from scratch and discarded everything. The substrate must exist *before* any learning loop is built on top, because retrofitting memory after-the-fact requires re-running historical data that will have already been discarded.

### Compatibility
Non-breaking. Same CLI surface, same config schema. Existing runs continue to work; memory accumulation begins from `0.2.0` forward. To wipe history, delete `%USERPROFILE%\glean\memory.db`.
```

### Step 3: Update ROADMAP.md

Edit `C:\Glean\docs\ROADMAP.md`:

1. Update the header:
   ```markdown
   **Last updated:** 2026-05-25 (post-v0.2.0; memory substrate shipped)
   **Current release:** [v0.2.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.2.0)
   ```
   (The commit SHA will be filled in after merge; leave as `<TBD>` for now and update in a follow-up commit if necessary — actually update it now after Task 12.)

2. Delete the "1. Persistent memory substrate" section from **Up next** (lines starting `### 1. Persistent memory substrate` through the next `### 2.` header). Renumber items 2 and 3 to 1 and 2.

3. Add to the **Done** section at the top of that list (most-recent-first):
   ```markdown
   - **v0.2.0** (2026-05-25, tag `v0.2.0`) — persistent memory substrate. SQLite-backed run/candidate history at `%USERPROFILE%\glean\memory.db`. Pure infrastructure: no CLI surface, no behavior change. Enables three future learning loops. See [v0.2.0 spec](./superpowers/specs/2026-05-25-glean-memory-substrate-design.md).
   ```

### Step 4: Run the full test suite one more time and build

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all green.

### Step 5: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/ROADMAP.md && git commit -m "chore: bump to v0.2.0 + CHANGELOG + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.2.0 -m "Merge v0.2.0 memory substrate into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.2.0 -m "v0.2.0 — persistent memory substrate"
```

### Step 3: (Optional, only if user requests) Push

```bash
cd /c/Glean && git push origin main --follow-tags
```

(Do NOT push without explicit user approval — CLAUDE.md and global git rules require explicit authorization for pushes.)

### Step 4: Update ROADMAP commit SHA

If Step 1 of Task 11 left `<TBD>` for the commit SHA, get the merge SHA and update:
```bash
cd /c/Glean && git log --oneline -1 main
```
Edit `docs/ROADMAP.md` to replace `<TBD>` with the actual SHA, then commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.2.0 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 5: Verify final state

```bash
cd /c/Glean && git log --oneline -10 && git tag -l 'v0.2.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.2.0` tag present, `"version": "0.2.0"`.

---

## Done-when checklist (mirrors spec §1)

- [x] `src/lib/memory.ts` exports `Memory` class with 5 methods + `fingerprintCandidate`.
- [x] Schema migration `001_initial` creates tables + indexes; `PRAGMA user_version = 1`.
- [x] `pipeline.ts` calls `recordRun` at start, `recordCandidate` per candidate, `endRun` in `finally`.
- [x] `executor.ts` calls `recordOutcome` after every task.
- [x] Recording failures emit warnings and the run continues (Task 10 verifies this).
- [x] Unit tests cover fingerprint stability, migration, run lifecycle, candidate lifecycle (Tasks 3–6).
- [x] Integration test verifies end-to-end DB writes (Task 9).
- [x] `npm test`, `npm run build`, `npm run lint` all exit 0 (Task 11 Step 4).
- [x] `CHANGELOG.md` has v0.2.0 entry (Task 11).
- [x] `docs/ROADMAP.md` moves memory substrate to Done (Task 11).
