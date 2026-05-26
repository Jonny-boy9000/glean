# `glean rate` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `glean rate` CLI subcommand that writes explicit user ratings (`kept`/`discarded`/`actioned`) to `memory.db`, plus `glean rate --list` for finding ratable dossiers. Pairs with v0.3.0's passive sweep for complete dossier-quality measurement. Ships as `v0.4.0`.

**Architecture:** Schema migration v3 adds two columns to `candidates` (`user_rating TEXT`, `user_rating_at INTEGER`). Two new `Memory` methods (`setUserRating`, `listRecentRatableCandidates`) handle storage primitives. A new `src/lib/rate.ts` exports a pure formatter `renderRateList`. The CLI subcommand uses citty positional args for `<id> <verdict>` and a `--list` flag for discovery.

**Tech Stack:** Node 20, TypeScript strict, ESM, vitest, citty (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-glean-rate-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\
    cli.ts                        MODIFY — add rateCmd + register on root (~50 LOC delta)
    lib\
      memory.ts                   MODIFY — migration v3 + 2 new methods (~30 LOC delta)
      memory.test.ts              MODIFY — 6 new tests + update pre-existing v2 assertions (~70 LOC delta)
      rate.ts                     NEW    — renderRateList + ANSI helpers (~50 LOC)
      rate.test.ts                NEW    — 3 tests (empty, plain, color) (~50 LOC)
  test\integration\
    v16-rate.test.ts              NEW    — 2 tests (round-trip, invalid verdict) (~70 LOC)
  package.json                    MODIFY — bump version to 0.4.0
  CHANGELOG.md                    MODIFY — v0.4.0 entry
  docs\ROADMAP.md                 MODIFY — move glean rate to Done, renumber Up next
```

---

## Citty positional-arg note

The existing `src/cli.ts` subcommands (`runCmd`, `repairCmd`, etc.) all use **named** args. `glean rate` introduces the project's first use of **positional** args. citty 0.1.6 supports positionals via:

```ts
args: {
  myFlag: { type: 'boolean', default: false },
  myPositional: { type: 'positional', required: false, description: '...' },
}
```

Positionals are assigned in declaration order. When mixed with flags, the parser strips flags first. So `glean rate --list` populates only `list`; `glean rate 42 kept` populates only the two positionals (in order); `glean rate` populates nothing.

If the implementer hits a citty quirk (e.g., positionals interacting badly with flags), the fallback is to read `process.argv` directly inside the `run()` body — but try the citty-native pattern first.

---

## Task ordering

Branch (Task 1). Schema migration v3 with its own tests + the existing v2 test updates (Task 2) — establishes the columns everything else depends on. Memory methods that read/write those columns (Task 3). Pure renderer (Task 4). CLI wiring (Task 5). End-to-end integration test (Task 6). Release bookkeeping (Task 7). Merge + tag (Task 8).

---

## Task 1: Create the v0.4.0 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, on `main`, HEAD at `662f5c8` (the glean rate spec commit) or later.

- [ ] **Step 2: Create branch**

```bash
cd /c/Glean && git checkout -b v0.4.0 && git branch --show-current
```
Expected: `v0.4.0`.

---

## Task 2: Schema migration v3 (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\memory.test.ts` (as a new `describe` block, after the existing migration-v2 block):

```ts
describe('Memory migration v3', () => {
  it('creates user_rating and user_rating_at columns on a fresh DB and sets user_version=3', () => {
    const m = new Memory(':memory:');
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('user_rating');
    expect(names).toContain('user_rating_at');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(3);
    m.close();
  });

  it('migrates from v2 to v3 on an existing v2 DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glean-mig-v3-'));
    const path = join(dir, 'memory.db');
    // First open creates v3 (latest); to simulate "v2 DB", manually create v2 schema
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
        stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0,
        dossier_existed_at_7d    INTEGER
      );
    `);
    raw.pragma('user_version = 2');
    raw.close();

    const m = new Memory(path);
    const cols = (m as unknown as { db: { prepare: (s: string) => { all: () => Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info('candidates')").all();
    const names = cols.map((c) => c.name);
    expect(names).toContain('user_rating');
    expect(names).toContain('user_rating_at');
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(3);
    m.close();
  });
});
```

Both tests are inside the same `describe`. The second is `async` so it can use `await import('better-sqlite3')` — vitest supports async test callbacks.

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts
```
Expected: the two new tests fail (no `user_rating` column; `user_version = 2`, not 3). The existing tests that assert `user_version === 2` will still pass for now — you'll update them in Step 3.

### Step 3: Update `Memory.migrate()` AND pre-existing tests

(a) In `C:\Glean\src\lib\memory.ts`, locate the existing `migrate` method. It currently has `if (version < 1)` and `if (version < 2)` blocks. Add a third `if (version < 3)` block immediately after, so the method becomes:

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
    if (version < 3) {
      this.db.exec('BEGIN');
      try {
        this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating TEXT');
        this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating_at INTEGER');
        this.db.pragma('user_version = 3');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }
```

The `version` variable is still captured ONCE at the top — do not re-read it between blocks. When a fresh DB starts at 0, all three migrations apply in order.

The two ALTER TABLE statements inside the v3 block run separately because SQLite's `ALTER TABLE ADD COLUMN` adds only one column at a time.

(b) Update the existing test in `memory.test.ts` titled `'creates the schema on a fresh DB and sets user_version=2'`. Change the title and assertion:

```ts
  it('creates the schema on a fresh DB and sets user_version=3', () => {
    const m = new Memory(':memory:');
    const rows = (m as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(rows).toEqual([{ name: 'candidates' }, { name: 'runs' }]);
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(3);
    m.close();
  });
```

(c) Find the existing `'is idempotent — opening twice does not error'` test. Its assertion `expect(v).toBe(2)` must become `expect(v).toBe(3)`. Update that single line.

### Step 4: Run tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts && npm test && npx tsc --noEmit
```
Expected: all memory tests pass (existing + 2 new = 16). Full suite 117 passing + 1 skipped (115 baseline + 2 new). Zero TS errors.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): schema migration v3 adds user_rating + user_rating_at columns

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `setUserRating` + `listRecentRatableCandidates` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\memory.test.ts`:

```ts
describe('Memory rating helpers', () => {
  function seedCandidate(m: Memory, runId: string, slug: string, opts?: { outcome?: string; dossier_path?: string | null; ended_at?: number | null; title?: string }): number {
    m.recordRun(runId, {
      project_path: 'C:\\proj',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.4.0',
    });
    const id = m.recordCandidate(runId, {
      candidate_slug: slug,
      candidate_type: 'research-dossier',
      title: opts?.title ?? slug,
      source_signal: 'git-todo',
      file_path: 'a.ts',
      est_value: 0.5,
      est_tokens: 500,
      priority_rank: 0,
    });
    if (opts) {
      (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
        .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=? WHERE id=?')
        .run(opts.outcome ?? 'ok', opts.dossier_path ?? 'OUT.md', opts.ended_at ?? Date.now(), id);
    }
    return id;
  }

  it('setUserRating returns {updated: true, title} and writes the row on success', () => {
    const m = new Memory(':memory:');
    const id = seedCandidate(m, 'run-r1', 'c1', { title: 'My TODO' });
    const r = m.setUserRating(id, 'kept');
    expect(r).toEqual({ updated: true, title: 'My TODO' });
    const row = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT user_rating, user_rating_at FROM candidates WHERE id=?').get(id);
    expect(row.user_rating).toBe('kept');
    expect(typeof row.user_rating_at).toBe('number');
    expect(row.user_rating_at).toBeGreaterThan(Date.now() - 5000);
    m.close();
  });

  it('setUserRating returns {updated: false, title: null} for a missing id', () => {
    const m = new Memory(':memory:');
    const r = m.setUserRating(999, 'kept');
    expect(r).toEqual({ updated: false, title: null });
    m.close();
  });

  it('re-rating overwrites the previous value and timestamp', async () => {
    const m = new Memory(':memory:');
    const id = seedCandidate(m, 'run-r2', 'c2');
    m.setUserRating(id, 'kept');
    const row1 = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT user_rating, user_rating_at FROM candidates WHERE id=?').get(id);
    await new Promise((res) => setTimeout(res, 5)); // ensure timestamp can differ
    m.setUserRating(id, 'discarded');
    const row2 = (m as unknown as { db: { prepare: (s: string) => { get: (k: number) => Record<string, unknown> } } })
      .db.prepare('SELECT user_rating, user_rating_at FROM candidates WHERE id=?').get(id);
    expect(row2.user_rating).toBe('discarded');
    expect(row2.user_rating_at as number).toBeGreaterThanOrEqual(row1.user_rating_at as number);
    m.close();
  });

  it('listRecentRatableCandidates filters by outcome+dossier_path and orders by ended_at DESC', () => {
    const m = new Memory(':memory:');
    const now = Date.now();
    seedCandidate(m, 'run-l1', 'older', { ended_at: now - 10_000 });
    seedCandidate(m, 'run-l2', 'newer', { ended_at: now });
    // Row with no outcome
    const noOutId = m.recordCandidate('run-l1', {
      candidate_slug: 'no-outcome', candidate_type: 'research-dossier', title: 'no-outcome',
      source_signal: 'git-todo', file_path: 'a.ts', est_value: 0.5, est_tokens: 500, priority_rank: 1,
    });
    (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET dossier_path=?, ended_at=? WHERE id=?')
      .run('OUT.md', now, noOutId); // outcome stays NULL
    // Row with outcome but no dossier_path
    const noDossierId = m.recordCandidate('run-l1', {
      candidate_slug: 'no-dossier', candidate_type: 'research-dossier', title: 'no-dossier',
      source_signal: 'git-todo', file_path: 'a.ts', est_value: 0.5, est_tokens: 500, priority_rank: 2,
    });
    (m as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET outcome=?, ended_at=? WHERE id=?')
      .run('failed', now, noDossierId);

    const rows = m.listRecentRatableCandidates(20);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('newer');
    expect(rows[1].title).toBe('older');
    expect(rows[0].user_rating).toBeNull();
    m.close();
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/memory.test.ts`
Expected: FAIL — `m.setUserRating is not a function` and `m.listRecentRatableCandidates is not a function`.

### Step 3: Add the methods

In `C:\Glean\src\lib\memory.ts`, add both methods to the `Memory` class. Position them after `markDossierExists` (which was added in v0.3.0):

```ts
  setUserRating(candidateId: number, rating: 'kept' | 'discarded' | 'actioned'): { updated: boolean; title: string | null } {
    const row = this.db.prepare('SELECT title FROM candidates WHERE id = ?').get(candidateId) as { title: string } | undefined;
    if (!row) return { updated: false, title: null };
    this.db.prepare('UPDATE candidates SET user_rating = ?, user_rating_at = ? WHERE id = ?')
      .run(rating, Date.now(), candidateId);
    return { updated: true, title: row.title };
  }

  listRecentRatableCandidates(limit: number): Array<{
    id: number;
    title: string;
    candidate_type: 'research-dossier' | 'fetch-docs';
    ended_at: number;
    dossier_path: string;
    user_rating: 'kept' | 'discarded' | 'actioned' | null;
  }> {
    return this.db.prepare(
      `SELECT id, title, candidate_type, ended_at, dossier_path, user_rating
         FROM candidates
        WHERE outcome IS NOT NULL
          AND dossier_path IS NOT NULL
        ORDER BY ended_at DESC
        LIMIT ?`,
    ).all(limit) as Array<{
      id: number;
      title: string;
      candidate_type: 'research-dossier' | 'fetch-docs';
      ended_at: number;
      dossier_path: string;
      user_rating: 'kept' | 'discarded' | 'actioned' | null;
    }>;
  }
```

### Step 4: Run tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts && npm test && npx tsc --noEmit
```
Expected: memory tests pass (16 + 4 new = 20). Full suite 121 passing + 1 skipped. No TS errors.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): setUserRating and listRecentRatableCandidates

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `renderRateList` formatter (TDD)

**Files:**
- Create: `C:\Glean\src\lib\rate.ts`
- Create: `C:\Glean\src\lib\rate.test.ts`

### Step 1: Write the failing tests

Create `C:\Glean\src\lib\rate.test.ts`:

```ts
/* eslint-disable no-control-regex */
import { describe, it, expect } from 'vitest';
import { renderRateList } from './rate.js';

type Row = {
  id: number;
  title: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  ended_at: number;
  dossier_path: string;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
};

describe('renderRateList', () => {
  it('renders the empty-case message when no rows', () => {
    expect(renderRateList([], false)).toBe('No ratable dossiers found.');
  });

  it('renders a plain table with no ANSI codes', () => {
    const rows: Row[] = [
      { id: 42, title: 'Handle TODO in src/cli.ts', candidate_type: 'research-dossier',
        ended_at: new Date('2026-05-26T13:01:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\OUT.md', user_rating: 'kept' },
      { id: 41, title: 'Pre-fetch docs for better-sqlite3', candidate_type: 'fetch-docs',
        ended_at: new Date('2026-05-26T12:58:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\docs\\bs3.md', user_rating: null },
      { id: 40, title: 'Handle TODO in src/foo.ts', candidate_type: 'research-dossier',
        ended_at: new Date('2026-05-25T10:13:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\OUT.md', user_rating: 'discarded' },
    ];
    const s = renderRateList(rows, false);
    expect(s).not.toMatch(/\x1b\[/);
    expect(s).toContain('Recent rateable dossiers');
    expect(s).toContain('42');
    expect(s).toContain('41');
    expect(s).toContain('40');
    expect(s).toContain('research-dossier');
    expect(s).toContain('fetch-docs');
    expect(s).toContain('kept');
    expect(s).toContain('discarded');
    expect(s).toContain('(unrated)');
    expect(s).toContain('Handle TODO in src/cli.ts');
    expect(s).toContain('Rate one with: glean rate <id>');
  });

  it('emits ANSI codes when useColor is true', () => {
    const rows: Row[] = [
      { id: 1, title: 'kept', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: 'kept' },
      { id: 2, title: 'bad', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: 'discarded' },
      { id: 3, title: 'pending', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: null },
    ];
    const s = renderRateList(rows, true);
    expect(s).toMatch(/\x1b\[1m/);  // bold (header)
    expect(s).toMatch(/\x1b\[32m/); // green (kept)
    expect(s).toMatch(/\x1b\[31m/); // red (discarded)
    expect(s).toMatch(/\x1b\[2m/);  // dim (unrated / footer / column headers)
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/rate.test.ts`
Expected: FAIL — "Cannot find module './rate.js'".

### Step 3: Implement `rate.ts`

Create `C:\Glean\src\lib\rate.ts`:

```ts
type Row = {
  id: number;
  title: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  ended_at: number;
  dossier_path: string;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
};

type Painter = {
  bold:  (s: string) => string;
  dim:   (s: string) => string;
  green: (s: string) => string;
  red:   (s: string) => string;
};

const ANSI: Painter = {
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
};

const PLAIN: Painter = {
  bold:  (s) => s,
  dim:   (s) => s,
  green: (s) => s,
  red:   (s) => s,
};

export function renderRateList(rows: Row[], useColor: boolean): string {
  if (rows.length === 0) {
    return 'No ratable dossiers found.';
  }
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];

  lines.push(c.bold('Recent rateable dossiers (most recent first):'));
  lines.push('');
  lines.push(c.dim('  id    when              type              rating       title'));

  for (const r of rows) {
    const idCol = String(r.id).padEnd(5);
    const whenCol = formatLocalDateTime(r.ended_at).padEnd(17);
    const typeCol = r.candidate_type.padEnd(17);
    const ratingCol = formatRating(r.user_rating, c).padEnd(12 + ansiOverhead(r.user_rating, c));
    lines.push(`  ${idCol} ${whenCol} ${typeCol} ${ratingCol} ${r.title}`);
  }

  lines.push('');
  lines.push(c.dim('Rate one with: glean rate <id> <kept|discarded|actioned>'));

  return lines.join('\n');
}

function formatRating(rating: Row['user_rating'], c: Painter): string {
  if (rating === null) return c.dim('(unrated)');
  if (rating === 'kept' || rating === 'actioned') return c.green(rating);
  return c.red(rating);
}

function ansiOverhead(rating: Row['user_rating'], c: Painter): number {
  // padEnd needs the visible-character target; ANSI codes inflate string.length.
  // Compute how many extra chars the painters add for the rating column.
  if (c === PLAIN) return 0;
  if (rating === null) {
    const wrapped = c.dim('x');
    return wrapped.length - 1;
  }
  const wrapped = (rating === 'kept' || rating === 'actioned') ? c.green('x') : c.red('x');
  return wrapped.length - 1;
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
```

The `ansiOverhead` helper exists because `String.prototype.padEnd` counts the ANSI escape sequences as visible characters. Without compensation, color-mode output would have columns shifted left. The plain mode (`c === PLAIN`) short-circuits to 0 overhead.

### Step 4: Run the tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/rate.test.ts && npm test && npx tsc --noEmit && npm run lint
```
Expected: rate tests pass (3 new). Full suite 124 passing + 1 skipped. No TS errors. Lint clean.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/rate.ts src/lib/rate.test.ts && git commit -m "feat(rate): renderRateList formatter with ANSI color toggle

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Wire `rateCmd` in `cli.ts`

**Files:**
- Modify: `C:\Glean\src\cli.ts`

No new unit test — the integration test in Task 6 covers the wiring.

### Step 1: Add imports

Open `C:\Glean\src\cli.ts`. Find the existing import block. Add two new imports:

```ts
import { Memory } from './lib/memory.js';
import { renderRateList } from './lib/rate.js';
```

(`Memory` may already be in scope via another import — check. If not, add it.)

### Step 2: Define `rateCmd`

Add the following `defineCommand` block after the existing `todayCmd` definition (or wherever the most recently-added subcommand sits) and BEFORE the `root` command definition:

```ts
const rateCmd = defineCommand({
  meta: { name: 'rate', description: 'Rate a dossier (kept/discarded/actioned), or --list recent dossiers' },
  args: {
    list:    { type: 'boolean',    default: false, description: 'Print recent ratable dossiers' },
    id:      { type: 'positional', required: false, description: 'Candidate id to rate' },
    verdict: { type: 'positional', required: false, description: 'kept | discarded | actioned' },
  },
  async run({ args }) {
    const memory = new Memory(join(gleanRoot(), 'memory.db'));
    try {
      if (args.list) {
        const rows = memory.listRecentRatableCandidates(20);
        const useColor = Boolean(process.stdout.isTTY);
        process.stdout.write(renderRateList(rows, useColor) + '\n');
        return;
      }
      const idStr = args.id as string | undefined;
      const verdict = args.verdict as string | undefined;
      if (!idStr || !verdict) {
        process.stderr.write('usage: glean rate <id> <kept|discarded|actioned>\n       glean rate --list\n');
        process.exit(1);
      }
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(`error: invalid id '${idStr}'\n`);
        process.exit(1);
      }
      if (verdict !== 'kept' && verdict !== 'discarded' && verdict !== 'actioned') {
        process.stderr.write(`error: unknown verdict '${verdict}' — use one of: kept, discarded, actioned\n`);
        process.exit(1);
      }
      const result = memory.setUserRating(id, verdict);
      if (!result.updated) {
        process.stderr.write(`error: no candidate with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`rated ${id} (${result.title}) as ${verdict}\n`);
    } finally {
      memory.close();
    }
  },
});
```

### Step 3: Register `rateCmd` on the root command

Find the existing `root` defineCommand (currently `subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd }`) and append `, rate: rateCmd`:

```ts
const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd },
});
```

### Step 4: Build + smoke test

```bash
cd /c/Glean && npm run build
```
Expected: clean.

```bash
cd /c/Glean && node bin/glean.js rate --list
```
Expected: `No ratable dossiers found.` (since the user's local memory.db likely has no settled candidates with dossiers yet, OR shows a list if they do).

```bash
cd /c/Glean && node bin/glean.js rate
```
Expected: `usage: glean rate <id> <kept|discarded|actioned>` on stderr, exit code 1.

```bash
cd /c/Glean && node bin/glean.js rate 99 kept
```
Expected: either `error: no candidate with id 99` (likely) or `rated 99 (...) as kept` (if you happen to have a candidate id 99). Either way the command should exit cleanly.

```bash
cd /c/Glean && node bin/glean.js rate 1 wat
```
Expected: `error: unknown verdict 'wat'` on stderr, exit 1.

### Step 5: Run full test suite

```bash
cd /c/Glean && npm test && npx tsc --noEmit && npm run lint
```
Expected: 124 passing + 1 skipped (no new tests in this task; nothing regressed). TS + lint clean.

### Step 6: Commit

```bash
cd /c/Glean && git add src/cli.ts && git commit -m "feat(cli): add 'glean rate' subcommand

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: v16 integration test

**Files:**
- Create: `C:\Glean\test\integration\v16-rate.test.ts`

### Step 1: Write the test

Create `C:\Glean\test\integration\v16-rate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

describe('verification 16: glean rate CLI', () => {
  function setupMemoryWithCandidate(home: string): number {
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dbPath = join(home, 'glean', 'memory.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Apply the same schema migrations a normal Memory open would
    db.exec(`
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
        stderr_rate_limit_hits   INTEGER NOT NULL DEFAULT 0,
        dossier_existed_at_7d    INTEGER,
        user_rating              TEXT,
        user_rating_at           INTEGER
      );
      CREATE INDEX idx_candidates_fingerprint ON candidates(fingerprint);
      CREATE INDEX idx_candidates_run_id      ON candidates(run_id);
    `);
    db.pragma('user_version = 3');
    db.prepare('INSERT INTO runs (run_id, started_at, project_path, budget_seconds, max_parallel, glean_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-v16', Date.now(), 'C:\\demo', 3600, 1, '0.4.0');
    const info = db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-v16', 'c-v16', 'fp16', 'research-dossier', 'Test ratable dossier', 'git-todo',
      'a.ts', 0.5, 500, 0, 'ok', 'OUT.md', Date.now());
    const id = Number(info.lastInsertRowid);
    db.close();
    return id;
  }

  it('rates a dossier and --list shows the rating (round-trip)', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v16-rt-'));
    const id = setupMemoryWithCandidate(home);

    const rateRes = spawnSync('node', ['bin/glean.js', 'rate', String(id), 'kept'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(rateRes.status).toBe(0);
    expect(rateRes.stdout).toContain(`rated ${id}`);
    expect(rateRes.stdout).toContain('as kept');

    const listRes = spawnSync('node', ['bin/glean.js', 'rate', '--list'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(listRes.status).toBe(0);
    expect(listRes.stdout).toContain('Test ratable dossier');
    expect(listRes.stdout).toContain('kept');
    expect(listRes.stdout).toContain(String(id));
  });

  it('exits 1 on invalid verdict with a useful error', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v16-bad-'));
    const id = setupMemoryWithCandidate(home);

    const res = spawnSync('node', ['bin/glean.js', 'rate', String(id), 'wat'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/unknown verdict 'wat'/);
  });
});
```

### Step 2: Run the tests

```bash
cd /c/Glean && npx vitest run test/integration/v16-rate.test.ts
```
Expected: 2 passed.

```bash
cd /c/Glean && npm test && npx tsc --noEmit && npm run lint
```
Expected: 126 passing + 1 skipped. Zero failures, TS clean, lint clean.

### Step 3: Commit

```bash
cd /c/Glean && git add test/integration/v16-rate.test.ts && git commit -m "test(rate): end-to-end CLI integration tests (round-trip + invalid verdict)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Version + CHANGELOG + ROADMAP

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\CHANGELOG.md`
- Modify: `C:\Glean\docs\ROADMAP.md`

### Step 1: Bump the version

Edit `C:\Glean\package.json`. Change:
```json
  "version": "0.3.0",
```
to:
```json
  "version": "0.4.0",
```

### Step 2: Add the CHANGELOG entry

Open `C:\Glean\CHANGELOG.md`. The file currently starts with:

```markdown
# Changelog

## v0.3.0 — 2026-05-26
```

Insert a new v0.4.0 section between `# Changelog` and `## v0.3.0`:

```markdown
## v0.4.0 — 2026-05-26

Active usefulness telemetry. Closes the active half of the dossier-quality feedback loop, complementing v0.3.0's passive sweep.

### Added
- `glean rate <id> <kept|discarded|actioned>` subcommand. Writes an explicit user verdict to a new `user_rating` column in `memory.db`. Ratings are mutable — re-rating overwrites the previous value, and `user_rating_at` tracks the latest write.
- `glean rate --list` flag. Prints the last 20 ratable dossiers (settled candidates with dossier paths) so the user can find what to rate. ANSI-colored when interactive, plain when piped.
- Schema migration `v3` (auto-applied on first open): adds `user_rating TEXT` and `user_rating_at INTEGER` columns to `candidates`.
- New module `src/lib/rate.ts` exporting the pure `renderRateList` formatter.
- Two new `Memory` methods: `setUserRating(candidateId, rating)` and `listRecentRatableCandidates(limit)`.

### Why
The v0.3.0 sweep captures a passive signal — "did the dossier file still exist after 7 days." That's slow (7-day latency) and noisy (you might keep files you never opened). `glean rate` adds the explicit, immediate ground truth. The two telemetry types are complementary: passive = default behavior, active = deliberate verdict. The eventual ranker will combine both.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. Schema migration is automatic and idempotent on first open. Ratings are mutable; the latest rating wins, previous values are not retained. To wipe ratings only: `sqlite3 %USERPROFILE%\glean\memory.db "UPDATE candidates SET user_rating = NULL, user_rating_at = NULL"`.

### Tests
- Suite: 115 + 1 skip → 126 + 1 skip.
- 6 new tests in `src/lib/memory.test.ts` (migration v3 fresh + v2→v3 upgrade, setUserRating success + failure, re-rating, listRecentRatableCandidates filtering/ordering).
- 3 new tests in `src/lib/rate.test.ts` (empty, plain, color).
- 2 new tests in `test/integration/v16-rate.test.ts` (round-trip, invalid verdict exits 1).
```

### Step 3: Update ROADMAP.md

Open `C:\Glean\docs\ROADMAP.md`.

(a) Update the header:
```markdown
**Last updated:** 2026-05-26 (post-v0.4.0; `glean rate` shipped)
**Current release:** [v0.4.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.4.0) (commit `<TBD>`)
```
(The commit SHA will be filled in after merge in Task 8. Leave `<TBD>` for now.)

(b) Remove the entire `### 1. \`glean rate\` — active usefulness telemetry` section from **Up next**. Then renumber the remaining items so what was #2 (`glean today` enriched) becomes #1, #3 (`glean peek`) becomes #2, #4 (API-key fallback) becomes #3.

The renumbered headings:
- `### 1. \`glean today\` enriched with memory.db` (was #2)
- `### 2. \`glean peek\` + SessionStart hook integration` (was #3)
- `### 3. API-key fallback when Pro/Max rate-limits` (was #4)

(c) Update the "Strategic lens" preamble paragraph in **Up next**. Find the current sentence: `Items 1–2 close the active half (explicit ratings + surfacing telemetry back via \`glean today\`).` Replace with: `Both halves of the telemetry pair shipped (v0.3.0 passive sweep + v0.4.0 \`glean rate\` active ratings); item 1 surfaces both signals back via \`glean today\`.`

Full updated paragraph:

```markdown
> **Strategic lens (2026-05-26):** The most load-bearing critique of the project is that the engine has no measure of dossier usefulness — you don't know if you'd open what it produces. Both halves of the telemetry pair shipped (v0.3.0 passive sweep + v0.4.0 `glean rate` active ratings); item 1 surfaces both signals back via `glean today`. Item 2 is the highest-leverage forward-momentum item that benefits from telemetry already being in place. Item 3 is engine durability. Distribution / adoption items (POSIX port, npm publish, GitHub issues, demo media) consciously deferred until telemetry validates that the core is worth distributing.
```

(d) Update the "Deliberately third, not first:" note inside the renumbered `glean peek` item. Change it to "Deliberately second, not first:" (since it's now Up next #2).

Current: `**Deliberately third, not first:**`
Updated: `**Deliberately second, not first:**`

(e) Update the cross-reference in "Smaller v0.2-shaped features" → output adapters bullet. Find: `only worth doing once \`glean today\` proves useful in dogfood (the v0.3.0 sweep + the forthcoming \`glean rate\` will tell).` Change `forthcoming \`glean rate\`` to `v0.4.0 ratings`:

Updated bullet text: `only worth doing once \`glean today\` proves useful in dogfood (the v0.3.0 sweep + v0.4.0 ratings will tell).`

(f) Update the "Distribution prep" deferred note. Find: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + Up next #1–2).` Change to: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + v0.4.0 ratings + Up next #1).`

(g) Add a new entry to the **Done** section. Insert before the `v0.3.0` entry:

```markdown
- **v0.4.0** (2026-05-26, tag `v0.4.0`) — `glean rate` subcommand for active usefulness telemetry. Writes `kept`/`discarded`/`actioned` verdicts to a new `user_rating` column; `glean rate --list` prints recent ratable dossiers. Schema migration v3. Pairs with the v0.3.0 passive sweep for complete dossier-quality measurement. See [v0.4.0 spec](./superpowers/specs/2026-05-26-glean-rate-design.md), [v0.4.0 plan](./superpowers/plans/2026-05-26-glean-rate.md).
- **v0.3.0** (2026-05-26, tag `v0.3.0`) — ...
```

### Step 4: Final verification

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all three exit 0. Test count: 126 passing + 1 skipped.

### Step 5: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/ROADMAP.md && git commit -m "chore: bump to v0.4.0 + CHANGELOG + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.4.0 -m "Merge v0.4.0 glean rate into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.4.0 -m "v0.4.0 — glean rate active usefulness telemetry"
```

### Step 3: Update ROADMAP commit SHA

Get the merge SHA:
```bash
cd /c/Glean && git log --oneline -1 main
```

Edit `C:\Glean\docs\ROADMAP.md` — find the header line containing `<TBD>` and replace it with the actual 7-char SHA prefix.

Commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.4.0 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 4: Verify final state

```bash
cd /c/Glean && git log --oneline -8 && git tag -l 'v0.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.1.0-mvp` through `v0.4.0` tags present, `"version": "0.4.0"`.

### Step 5: Do NOT push without user approval

Per `CLAUDE.md`, do not push until explicitly told. When approved:
```bash
cd /c/Glean && git push origin main --follow-tags
```

---

## Done-when checklist (mirrors spec §1)

- [x] Schema migration v3 adds both columns + `user_version = 3` + idempotent. (Task 2)
- [x] `setUserRating` returns `{updated, title}` correctly for hit + miss + re-rate. (Task 3)
- [x] `listRecentRatableCandidates` filters + orders + limits. (Task 3)
- [x] `rate.ts` exports `renderRateList` (pure, empty + plain + color). (Task 4)
- [x] `glean rate <id> <verdict>` writes via `setUserRating` and echoes confirmation. (Task 5)
- [x] `glean rate --list` renders the list to stdout. (Task 5)
- [x] Invalid id / invalid verdict / missing row → exit 1 with stderr message. (Task 5 smoke + Task 6 integration test)
- [x] ~11 new tests across memory/rate/integration. (Tasks 2/3/4/6)
- [x] `npm test`, `npm run build`, `npm run lint` exit 0. (Task 6 + Task 7 verify)
- [x] CHANGELOG v0.4.0 entry. (Task 7)
- [x] ROADMAP moves rate to Done, renumbers Up next + updates cross-references. (Task 7 + Task 8)
