# Dossier-Existence Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a passive usefulness-telemetry sweep that runs at the start of every `glean run` and records whether candidate dossiers from 7+ days ago still exist on disk. Captures the implicit kept-vs-discarded signal with zero user action. Ships as `v0.3.0`.

**Architecture:** Schema migration v2 adds `dossier_existed_at_7d INTEGER` to the `candidates` table. Two new `Memory` methods (`findCandidatesNeedingSweep`, `markDossierExists`) handle storage primitives. A new `src/lib/sweep.ts` module owns the orchestration — iterate eligible rows, `existsSync` each, mark the result. One new call site in `pipeline.ts` invokes the sweep after `recordRun` succeeds. All memory calls already protected by the existing `[memory] warning:` try/catch pattern.

**Tech Stack:** Node 20, TypeScript strict, ESM, vitest, better-sqlite3 (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-glean-dossier-sweep-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\lib\
    memory.ts                MODIFY — add migration v2 + 2 new methods (~30 LOC delta)
    memory.test.ts           MODIFY — add 4 new tests (~50 LOC delta)
    sweep.ts                 NEW    — runDossierExistenceSweep + SWEEP_AGE_MS (~30 LOC)
    sweep.test.ts            NEW    — 6 fixture-based tests (~120 LOC)
    pipeline.ts              MODIFY — add sweep call after recordRun (~10 LOC delta)
  package.json               MODIFY — bump version to 0.3.0
  CHANGELOG.md               MODIFY — v0.3.0 entry
  docs\ROADMAP.md            MODIFY — move sweep to Done, renumber Up next
```

No new top-level modules; sweep is a new sibling under `src/lib/`. Existing test fixture patterns carry over (`Memory(':memory:')` for unit tests; `mkdtempSync` for filesystem fixtures).

---

## Task ordering

Branch first (Task 1). Migration v2 alone (Task 2) — establishes the schema everything else depends on. Then the two Memory methods that read/write the new column (Task 3). Then the orchestrator in `sweep.ts` that uses those methods (Task 4). Then the pipeline integration (Task 5). Finally release bookkeeping (Task 6) and merge (Task 7).

Each task is independently committable and leaves the suite green.

---

## Task 1: Create the v0.3.0 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, on `main`, HEAD at `bb4a743` (the sweep spec commit) or later.

- [ ] **Step 2: Create branch**

```bash
cd /c/Glean && git checkout -b v0.3.0 && git branch --show-current
```
Expected: `v0.3.0`.

---

## Task 2: Schema migration v2 (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\memory.test.ts` (after the existing `describe` blocks; add a new one):

```ts
describe('Memory migration v2', () => {
  it('creates the dossier_existed_at_7d column on a fresh DB and sets user_version=2', () => {
    const m = new Memory(':memory:');
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('dossier_existed_at_7d');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });

  it('migrates from v1 to v2 on an existing v1 DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glean-mig-v2-'));
    const path = join(dir, 'memory.db');
    // First open creates v2 (latest); to simulate "v1 DB", manually create v1 schema
    // and downgrade user_version before the second open.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
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
      CREATE TABLE candidates (
        id                       INTEGER PRIMARY KEY,
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
    `);
    raw.pragma('user_version = 1');
    raw.close();

    const m = new Memory(path);
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    expect(cols.map((c) => c.name)).toContain('dossier_existed_at_7d');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });
});
```

Note: the migration-v2 test is async (`async () => { ... }`) so it can use `await import('better-sqlite3')`. Vitest fully supports async test callbacks.

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: the existing `'creates the schema on a fresh DB and sets user_version=1'` test now fails because user_version is 1, not 2 (this is OK — it gets updated in step 3). The new two tests also fail.

### Step 3: Update `Memory.migrate()` and the existing test's expected user_version

In `C:\Glean\src\lib\memory.ts`, locate the existing `migrate` method. It currently has one `if (version < 1)` block. Add a second `if (version < 2)` block immediately after, so the method becomes:

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

Important: the `version` variable is captured ONCE before both `if` blocks. That is intentional — when a fresh DB starts at version 0, both `version < 1` and `version < 2` are true, so both migrations apply in order. When a v1 DB opens, `version` is 1, so only the second block runs. When a v2 DB opens, neither runs.

In the SAME file (`memory.ts`), the existing `SCHEMA_V1` const must still be unchanged — only the `migrate()` method changes.

Also update the existing test in `memory.test.ts` that asserts `user_version = 1` for fresh DBs. Find the test currently titled `'creates the schema on a fresh DB and sets user_version=1'` (in the `describe('Memory open + migrate', ...)` block). Update the title and the assertion:

```ts
  it('creates the schema on a fresh DB and sets user_version=2', () => {
    const m = new Memory(':memory:');
    const rows = (m as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(rows).toEqual([{ name: 'candidates' }, { name: 'runs' }]);
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(2);
    m.close();
  });
```

Similarly, find the other existing migration test (`'is idempotent — opening twice does not error'`). Its assertion `expect(v).toBe(1)` must become `expect(v).toBe(2)`. Find that line and update it.

### Step 4: Run the tests to verify they pass

Run:
```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: all memory tests pass — both the updated existing ones and the 2 new migration v2 tests.

Then full suite:
```bash
cd /c/Glean && npm test
```
Expected: zero failures. Total: 107 passing + 1 skipped (105 baseline + 2 new).

Then types:
```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no output.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): schema migration v2 adds dossier_existed_at_7d column

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `findCandidatesNeedingSweep` + `markDossierExists` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\memory.test.ts`:

```ts
describe('Memory sweep helpers', () => {
  it('findCandidatesNeedingSweep returns only eligible rows', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-sweep', {
      project_path: 'C:\\proj',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.3.0',
    });
    const seed = (slug: string, opts: { outcome?: string; dossier_path?: string | null; ended_at?: number | null; existed?: number | null }) => {
      const id = m.recordCandidate('run-sweep', {
        candidate_slug: slug,
        candidate_type: 'research-dossier',
        title: slug,
        source_signal: 'git-todo',
        file_path: 'src/a.ts',
        est_value: 0.5,
        est_tokens: 500,
        priority_rank: 0,
      });
      // Use raw UPDATE to set fields not exposed by the public API
      (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
        .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=?, dossier_existed_at_7d=? WHERE id=?')
        .run(opts.outcome ?? null, opts.dossier_path ?? null, opts.ended_at ?? null, opts.existed ?? null, id);
      return id;
    };

    const now = Date.now();
    const week = 7 * 86_400_000;
    seed('no-outcome',   { ended_at: now - week - 1000 });                                  // outcome null → skip
    seed('no-dossier',   { outcome: 'failed', ended_at: now - week - 1000 });               // dossier_path null → skip
    seed('not-ended',    { outcome: 'ok', dossier_path: 'OUT.md', ended_at: null });        // ended_at null → skip
    seed('too-recent',   { outcome: 'ok', dossier_path: 'OUT.md', ended_at: now });         // too new → skip
    seed('already-done', { outcome: 'ok', dossier_path: 'OUT.md', ended_at: now - week - 1000, existed: 1 }); // column non-null → skip
    const eligibleId = seed('eligible', { outcome: 'ok', dossier_path: 'OUT.md', ended_at: now - week - 1000 });

    const found = m.findCandidatesNeedingSweep(now - week);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(eligibleId);
    expect(found[0].dossier_path).toBe('OUT.md');
    m.close();
  });

  it('markDossierExists is write-once (NULL column accepts; non-NULL ignored)', () => {
    const m = new Memory(':memory:');
    m.recordRun('run-mark', {
      project_path: 'C:\\proj',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.3.0',
    });
    const id = m.recordCandidate('run-mark', {
      candidate_slug: 'c',
      candidate_type: 'research-dossier',
      title: 'c',
      source_signal: 'git-todo',
      file_path: 'a.ts',
      est_value: 0.5,
      est_tokens: 500,
      priority_rank: 0,
    });
    // Make the row eligible (outcome/dossier_path/ended_at set)
    (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=? WHERE id=?')
      .run('ok', 'OUT.md', Date.now() - 8 * 86_400_000, id);

    m.markDossierExists(id, true);
    let row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT dossier_existed_at_7d FROM candidates WHERE id=?').get(id);
    expect(row.dossier_existed_at_7d).toBe(1);

    // Second call must NOT overwrite (the WHERE column IS NULL guard)
    m.markDossierExists(id, false);
    row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT dossier_existed_at_7d FROM candidates WHERE id=?').get(id);
    expect(row.dossier_existed_at_7d).toBe(1);

    // And findCandidatesNeedingSweep should now exclude it
    const found = m.findCandidatesNeedingSweep(Date.now());
    expect(found.find((c) => c.id === id)).toBeUndefined();
    m.close();
  });
});
```

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: FAIL — `m.findCandidatesNeedingSweep is not a function` and `m.markDossierExists is not a function`.

### Step 3: Add the methods to `Memory`

In `C:\Glean\src\lib\memory.ts`, add the following two methods to the `Memory` class. Position them after `recordOutcome` and before `projectPathFor` (or anywhere in the class — order doesn't matter for SQLite/TypeScript, but grouping read helpers near other read code is clearer):

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
          AND dossier_existed_at_7d IS NULL`,
    ).run(exists ? 1 : 0, candidateId);
  }
```

### Step 4: Run the tests to verify they pass

Run:
```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: all memory tests pass — now 109 passing in this file overall.

Then full suite + types:
```bash
cd /c/Glean && npm test && npx tsc --noEmit
```
Expected: 109 passing + 1 skipped total. Zero TS errors.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): findCandidatesNeedingSweep and markDossierExists

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `runDossierExistenceSweep` (TDD)

**Files:**
- Create: `C:\Glean\src\lib\sweep.ts`
- Create: `C:\Glean\src\lib\sweep.test.ts`

### Step 1: Write the failing tests

Create `C:\Glean\src\lib\sweep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from './memory.js';
import { runDossierExistenceSweep, SWEEP_AGE_MS } from './sweep.js';

function seedEligible(m: Memory, runId: string, slug: string, dossierPath: string, endedAt: number): number {
  m.recordRun(runId, {
    project_path: 'C:\\proj',
    budget_seconds: 3600,
    max_parallel: 1,
    glean_version: '0.3.0',
  });
  const id = m.recordCandidate(runId, {
    candidate_slug: slug,
    candidate_type: 'research-dossier',
    title: slug,
    source_signal: 'git-todo',
    file_path: 'a.ts',
    est_value: 0.5,
    est_tokens: 500,
    priority_rank: 0,
  });
  (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
    .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=? WHERE id=?')
    .run('ok', dossierPath, endedAt, id);
  return id;
}

function readColumn(m: Memory, id: number): number | null {
  const row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
    .db.prepare('SELECT dossier_existed_at_7d FROM candidates WHERE id=?').get(id);
  return row.dossier_existed_at_7d as number | null;
}

describe('runDossierExistenceSweep', () => {
  it('returns zero counts on an empty DB', () => {
    const m = new Memory(':memory:');
    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    m.close();
  });

  it('marks an eligible row as kept when the file exists', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-kept-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, '# real dossier\n');
    const id = seedEligible(m, 'run-1', 'c1', dossierPath, Date.now() - 8 * 86_400_000);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 1, kept: 1, discarded: 0 });
    expect(readColumn(m, id)).toBe(1);
    m.close();
  });

  it('marks an eligible row as discarded when the file is missing', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-gone-'));
    const dossierPath = join(dir, 'does-not-exist.md');
    const id = seedEligible(m, 'run-2', 'c2', dossierPath, Date.now() - 8 * 86_400_000);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 1, kept: 0, discarded: 1 });
    expect(readColumn(m, id)).toBe(0);
    m.close();
  });

  it('skips rows that are too recent', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-recent-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, 'x');
    const id = seedEligible(m, 'run-3', 'c3', dossierPath, Date.now() - 1000); // 1s old

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    expect(readColumn(m, id)).toBeNull();
    m.close();
  });

  it('skips rows already swept', () => {
    const m = new Memory(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'glean-sweep-done-'));
    const dossierPath = join(dir, 'OUT.md');
    writeFileSync(dossierPath, 'x');
    const id = seedEligible(m, 'run-4', 'c4', dossierPath, Date.now() - 8 * 86_400_000);
    // Manually mark it
    (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET dossier_existed_at_7d=1 WHERE id=?').run(id);

    const r = runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS);
    expect(r).toEqual({ checked: 0, kept: 0, discarded: 0 });
    expect(readColumn(m, id)).toBe(1);
    m.close();
  });

  it('treats existsSync throws as discarded without propagating', () => {
    const m = new Memory(':memory:');
    // A path containing a literal null byte forces Node's fs validator to throw.
    const dossierPath = 'C:\\foo bar';
    const id = seedEligible(m, 'run-5', 'c5', dossierPath, Date.now() - 8 * 86_400_000);

    expect(() => runDossierExistenceSweep(m, Date.now(), SWEEP_AGE_MS)).not.toThrow();
    expect(readColumn(m, id)).toBe(0);
    m.close();
  });
});
```

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/sweep.test.ts
```
Expected: FAIL — "Cannot find module './sweep.js'".

### Step 3: Implement `sweep.ts`

Create `C:\Glean\src\lib\sweep.ts`:

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

### Step 4: Run the tests to verify they pass

Run:
```bash
cd /c/Glean && npx vitest run src/lib/sweep.test.ts
```
Expected: 6 passed.

Then types:
```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no output.

Full suite check:
```bash
cd /c/Glean && npm test
```
Expected: 115 passing + 1 skipped total. Zero failures.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/sweep.ts src/lib/sweep.test.ts && git commit -m "feat(sweep): runDossierExistenceSweep orchestrator

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Wire the sweep into `pipeline.ts`

**Files:**
- Modify: `C:\Glean\src\lib\pipeline.ts`

### Step 1: Read pipeline.ts to find the insertion point

```bash
cd /c/Glean && grep -n 'recordRun' src/lib/pipeline.ts
```
Expected output (line numbers may shift slightly): one match showing the `memory.recordRun(runId, { ... })` call inside the try/catch that protects Memory open. The new sweep call goes right after that `recordRun` succeeds, still inside the same `try { ... } catch { ... }` block.

### Step 2: Add the import

Near the top of `C:\Glean\src\lib\pipeline.ts`, find the existing `import { Memory } from './memory.js';` line. Add the sweep import on the next line:

```ts
import { Memory } from './memory.js';
import { runDossierExistenceSweep, SWEEP_AGE_MS } from './sweep.js';
```

### Step 3: Add the sweep call after recordRun

Find the existing block (it looks like):

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

Add a SEPARATE try/catch immediately AFTER that block (NOT inside it — the open/recordRun failure should not prevent the sweep from being attempted on a partially-open Memory, but in practice if Memory is null the new block guards on that):

```ts
if (memory) {
  try {
    const sweep = runDossierExistenceSweep(memory, Date.now(), SWEEP_AGE_MS);
    appendOrchestratorLog(opts.gleanRoot, runId, {
      evt: 'sweep.done',
      checked: sweep.checked,
      kept: sweep.kept,
      discarded: sweep.discarded,
    });
  } catch (e) {
    process.stderr.write(`[memory] warning: sweep failed: ${(e as Error).message}\n`);
  }
}
```

Position rationale: this is OUTSIDE the open/recordRun try/catch (so a sweep failure can't muddy the recordRun-failure log line) but BEFORE the main `try { ... }` block that contains discovery + executor loop (so the sweep runs before discovery, not during).

`appendOrchestratorLog` is already imported in pipeline.ts (it's used elsewhere). Verify with `grep -n 'appendOrchestratorLog' src/lib/pipeline.ts` if needed.

### Step 4: Build, test, lint

```bash
cd /c/Glean && npm run build
```
Expected: clean.

```bash
cd /c/Glean && npm test
```
Expected: 115 passing + 1 skipped. Zero failures. The existing pipeline tests (v13-memory, v14-memory-failure) should still pass — they don't seed any rows old enough to be eligible for sweep, so `checked: 0` is the no-op outcome.

```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no output.

```bash
cd /c/Glean && npm run lint
```
Expected: exit 0.

### Step 5: Smoke test

```bash
cd /c/Glean && node bin/glean.js today
```
Expected: still works (`today` doesn't depend on the sweep, but this confirms the build is consistent).

You may also exercise the sweep in a real `glean run` against a small fixture, but that's optional — the integration tests already validate the pipeline path.

### Step 6: Commit

```bash
cd /c/Glean && git add src/lib/pipeline.ts && git commit -m "feat(pipeline): wire dossier-existence sweep after recordRun

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Version + CHANGELOG + ROADMAP

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\CHANGELOG.md`
- Modify: `C:\Glean\docs\ROADMAP.md`

### Step 1: Bump the version

Edit `C:\Glean\package.json`. Change:
```json
  "version": "0.2.1",
```
to:
```json
  "version": "0.3.0",
```

### Step 2: Add the CHANGELOG entry

Open `C:\Glean\CHANGELOG.md`. The file currently starts with:

```markdown
# Changelog

## v0.2.1 — 2026-05-26
```

Insert a new v0.3.0 section between `# Changelog` and `## v0.2.1`:

```markdown
## v0.3.0 — 2026-05-26

Passive usefulness telemetry — first step in closing the dossier-quality feedback loop.

### Added
- Dossier-existence sweep. Every `glean run` now starts with a pass over historical `candidates` rows (7+ days old, dossier_path set). For each, `existsSync` checks whether the dossier file is still on disk and writes the result to a new `dossier_existed_at_7d` column. Captures the implicit kept-vs-discarded signal with zero user action.
- Schema migration `v2` (auto-applied on first open): `ALTER TABLE candidates ADD COLUMN dossier_existed_at_7d INTEGER`.
- New module `src/lib/sweep.ts` exporting `runDossierExistenceSweep` and `SWEEP_AGE_MS`.
- Two new `Memory` methods: `findCandidatesNeedingSweep(beforeMs)` and `markDossierExists(candidateId, exists)`.
- Sweep results logged to the existing orchestrator log via `appendOrchestratorLog({evt: 'sweep.done', checked, kept, discarded})`.

### Why
The engine has accumulated run history since v0.2.0 but has no measure of whether the dossiers it produces are actually useful. This release captures the cheapest possible signal — does the file still exist 7 days later — without asking anything of the user. Pairs with the forthcoming `glean rate` (Up next #2) for explicit ratings, and `glean today` enriched with memory.db (Up next #3) to surface both signals back.

### Compatibility
Non-breaking. Same CLI surface, same config schema. Schema migration is automatic and idempotent on first open. Sweep failures emit `[memory] warning: sweep failed: ...` to stderr and do not affect the run. Pre-v0.3.0 candidate rows that have already passed the 7-day mark stay `NULL` forever — no retroactive sweep. To wipe sweep data only (keep substrate): `sqlite3 %USERPROFILE%\glean\memory.db "UPDATE candidates SET dossier_existed_at_7d = NULL"`.

### Tests
- Suite: 105 + 1 skip → 115 + 1 skip.
- 4 new tests in `src/lib/memory.test.ts` covering migration v2 and the two new methods.
- 6 new tests in `src/lib/sweep.test.ts` covering the orchestrator (empty, kept, discarded, too-recent, already-swept, existsSync-throws).
```

### Step 3: Update ROADMAP.md

Open `C:\Glean\docs\ROADMAP.md`.

(a) Update the header:
```markdown
**Last updated:** 2026-05-26 (post-v0.3.0; dossier-existence sweep shipped)
**Current release:** [v0.3.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.3.0) (commit `<TBD>`)
```
(The commit SHA will be filled in after merge in Task 7. Leave `<TBD>` for now.)

(b) Remove the "1. Dossier-existence sweep" entry from **Up next** entirely. Then renumber the remaining items so what was #2 (`glean rate`) becomes #1, #3 becomes #2, #4 becomes #3, #5 becomes #4. The Up-next list shrinks from 5 entries to 4.

The renumbered headings should be:
- `### 1. \`glean rate\` — active usefulness telemetry` (was #2)
- `### 2. \`glean today\` enriched with memory.db` (was #3)
- `### 3. \`glean peek\` + SessionStart hook integration` (was #4)
- `### 4. API-key fallback when Pro/Max rate-limits` (was #5)

(c) Inside the body of the new `### 1. \`glean rate\``, update the cross-reference to the dossier-sweep item. The current text says "Passive existence is a noisy signal (might keep a dossier you never opened)" — that's still correct, no change needed there. But the "Strategic lens" preamble paragraph mentions "Items 1–3 close that gap with telemetry" — update to "Items 1–2 close the active half of that gap (the passive half shipped in v0.3.0)".

The full Strategic lens paragraph after this edit:

```markdown
> **Strategic lens (2026-05-26):** The most load-bearing critique of the project is that the engine has no measure of dossier usefulness — you don't know if you'd open what it produces. The passive half of that gap shipped in v0.3.0 (dossier-existence sweep). Items 1–2 close the active half (explicit ratings + surfacing telemetry back via `glean today`). Item 3 is the highest-leverage forward-momentum item that benefits from telemetry already being in place. Item 4 is engine durability. Distribution / adoption items (POSIX port, npm publish, GitHub issues, demo media) consciously deferred until telemetry validates that the core is worth distributing.
```

(d) Update the cross-reference inside `### 3. \`glean peek\` + SessionStart hook integration`. Its "Deliberately fourth, not first" justification now needs to read "Deliberately third, not first" — find that sentence and update the ordinal:

Current: `**Deliberately fourth, not first:**`
Updated: `**Deliberately third, not first:**`

(e) Update the "Smaller v0.2-shaped features" cross-reference. Find the line that says "only worth doing once `glean today` proves useful in dogfood (telemetry from Up next #1–3 will tell)" and change "#1–3" to "v0.3.0 sweep + Up next #1–2 will tell":

Current: `Each adds OAuth + network surface — only worth doing once \`glean today\` proves useful in dogfood (telemetry from Up next #1–3 will tell).`
Updated: `Each adds OAuth + network surface — only worth doing once \`glean today\` proves useful in dogfood (the v0.3.0 sweep + the forthcoming \`glean rate\` will tell).`

(f) Update the "Distribution prep" section. Find the line: "Deliberately deferred 2026-05-26 in favor of usefulness telemetry (Up next #1–3)." Change "#1–3" to "v0.3.0 sweep + Up next #1–2":

Current: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (Up next #1–3). Revisit once telemetry shows dossiers are being kept/actioned more often than discarded.`
Updated: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + Up next #1–2). Revisit once telemetry shows dossiers are being kept/actioned more often than discarded.`

(g) Add a new entry to the **Done** section. The current Done section starts:
```markdown
## Done (most recent first — for context only)

- **v0.2.1** (2026-05-26, tag `v0.2.1`)
```

Insert v0.3.0 before v0.2.1:
```markdown
- **v0.3.0** (2026-05-26, tag `v0.3.0`) — dossier-existence sweep. Passive usefulness telemetry: every `glean run` checks whether candidate dossiers from 7+ days ago still exist on disk, writes the result to a new `dossier_existed_at_7d` column in `memory.db`. Schema migration v2. No CLI surface, no engine behavior change. First step in answering the strategic analysis's existential question about dossier usefulness. See [v0.3.0 spec](./superpowers/specs/2026-05-26-glean-dossier-sweep-design.md), [v0.3.0 plan](./superpowers/plans/2026-05-26-glean-dossier-sweep.md).
- **v0.2.1** (2026-05-26, tag `v0.2.1`) — ...
```

### Step 4: Verify everything still builds and tests pass

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all three exit 0. Test count: 115 passing + 1 skipped.

### Step 5: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/ROADMAP.md && git commit -m "chore: bump to v0.3.0 + CHANGELOG + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.3.0 -m "Merge v0.3.0 dossier-existence sweep into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.3.0 -m "v0.3.0 — dossier-existence sweep (passive usefulness telemetry)"
```

### Step 3: Update ROADMAP commit SHA

Get the merge SHA:
```bash
cd /c/Glean && git log --oneline -1 main
```

Edit `C:\Glean\docs\ROADMAP.md` — find the header line containing `<TBD>` and replace it with the actual 7-char SHA prefix.

Then commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.3.0 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 4: Verify final state

```bash
cd /c/Glean && git log --oneline -8 && git tag -l 'v0.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.1.0-mvp` / `v0.1.1` / `v0.1.2` / `v0.2.0` / `v0.2.1` / `v0.3.0` tags all present, `"version": "0.3.0"`.

### Step 5: Do NOT push without user approval

Per `CLAUDE.md` and global git rules, do not push until the user explicitly says so. When they do:
```bash
cd /c/Glean && git push origin main --follow-tags
```

---

## Done-when checklist (mirrors spec §1)

- [x] Schema migration v2 adds `dossier_existed_at_7d INTEGER` and sets `user_version = 2`. (Task 2)
- [x] `Memory.findCandidatesNeedingSweep` and `Memory.markDossierExists` exist and behave correctly. (Task 3)
- [x] `src/lib/sweep.ts` exports `runDossierExistenceSweep` and `SWEEP_AGE_MS`. (Task 4)
- [x] `pipeline.ts` calls the sweep right after `recordRun` succeeds, inside its own try/catch, and logs `sweep.done` to orchestrator.log. (Task 5)
- [x] Sweep failures are non-fatal (emit `[memory] warning:`). (Task 5 — verified by the existing v14 test pattern continuing to pass.)
- [x] Per-path errors are swallowed and treated as "did not exist." (Task 4 test #6.)
- [x] Idempotency: each row checked exactly once. (Task 3 test 2 + Task 4 test 5.)
- [x] ~10 new tests. (4 + 6 = 10 — Tasks 2/3/4.)
- [x] `npm test`, `npm run build`, `npm run lint` exit 0. (Task 5 + Task 6 verify.)
- [x] CHANGELOG v0.3.0 entry. (Task 6)
- [x] ROADMAP moves sweep to Done, renumbers Up next. (Task 6 + Task 7)
