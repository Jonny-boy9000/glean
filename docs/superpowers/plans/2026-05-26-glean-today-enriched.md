# `glean today` Enriched Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `glean today` with an optional third line per entry that surfaces telemetry from `memory.db` — duration, output bytes, rate-limit hits, and user rating. Read-only enhancement. Engine, INDEX.md, and the two-line layout untouched. Ships as `v0.5.0`.

**Architecture:** One new `Memory` method (`findEnrichmentsBySlugs`) does a single batched lookup by candidate slug. `today.ts` calls into Memory after scanning INDEX.md and merges per-entry. `render-today.ts` gains a `formatEnrichmentLine` helper that returns the third line or null. All ANSI segments are independently wrapped so `\x1b[0m` resets don't kill outer dim attributes. Silent degradation when memory.db is absent or unreadable.

**Tech Stack:** Node 20, TypeScript strict, ESM, vitest, better-sqlite3 (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-glean-today-enriched-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\lib\
    memory.ts                  MODIFY — add findEnrichmentsBySlugs (~20 LOC)
    memory.test.ts             MODIFY — 2 new tests (~50 LOC)
    today.ts                   MODIFY — extend IndexEntry, preserve task_id, merge step (~30 LOC)
    today.test.ts              MODIFY — 2 new tests (~60 LOC)
    render-today.ts            MODIFY — formatEnrichmentLine + helpers + call site (~50 LOC)
    render-today.test.ts       MODIFY — 3 new tests (~50 LOC)
  test\integration\
    v15-today.test.ts          MODIFY — extend first test to seed memory.db and assert enrichment (~20 LOC)
  package.json                 MODIFY — bump version to 0.5.0
  CHANGELOG.md                 MODIFY — v0.5.0 entry
  docs\ROADMAP.md              MODIFY — move enriched-today to Done, renumber Up next
```

No new top-level modules. Pure read-side extension.

---

## Task ordering

Branch (Task 1). New `Memory` method first (Task 2) — pure SQL, no dependencies. Extend `today.ts` with `task_id` and the enrichment merge (Task 3 + Task 4 — split because they're separately testable: parse preserves task_id, merge uses it). Renderer's enrichment-line helper (Task 5). Integration test (Task 6). Release bookkeeping (Task 7). Merge + tag (Task 8).

Task 3 (parse preserves task_id) and Task 4 (enrichment merge) are separate so each can fail/pass independently. They could be combined but the split keeps each commit small.

---

## Task 1: Create the v0.5.0 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, on `main`, HEAD at `3497c98` (the today-enriched spec commit) or later.

- [ ] **Step 2: Create branch**

```bash
cd /c/Glean && git checkout -b v0.5.0 && git branch --show-current
```
Expected: `v0.5.0`.

---

## Task 2: `Memory.findEnrichmentsBySlugs` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\memory.ts`
- Modify: `C:\Glean\src\lib\memory.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\memory.test.ts` (as a new `describe` block, at the end):

```ts
describe('Memory enrichment lookup', () => {
  function seed(m: Memory, runId: string, slug: string, fields: { duration_ms?: number; bytes_written?: number; rate_limit_hits?: number; user_rating?: 'kept' | 'discarded' | 'actioned' | null }): number {
    m.recordRun(runId, {
      project_path: 'C:\\proj',
      budget_seconds: 3600,
      max_parallel: 1,
      glean_version: '0.5.0',
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
      .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=?, duration_ms=?, bytes_written=?, stderr_rate_limit_hits=?, user_rating=? WHERE id=?')
      .run(
        'ok', 'OUT.md', Date.now(),
        fields.duration_ms ?? null,
        fields.bytes_written ?? null,
        fields.rate_limit_hits ?? 0,
        fields.user_rating ?? null,
        id,
      );
    return id;
  }

  it('returns matching rows in a Map keyed by slug', () => {
    const m = new Memory(':memory:');
    seed(m, 'run-e1', 'slug-a', { duration_ms: 120_000, bytes_written: 4096, user_rating: 'kept' });
    seed(m, 'run-e2', 'slug-b', { rate_limit_hits: 3 });
    seed(m, 'run-e3', 'slug-c', {});

    const got = m.findEnrichmentsBySlugs(['slug-a', 'slug-b', 'slug-c']);
    expect(got.size).toBe(3);
    expect(got.get('slug-a')).toEqual({
      duration_ms: 120_000,
      bytes_written: 4096,
      stderr_rate_limit_hits: 0,
      user_rating: 'kept',
    });
    expect(got.get('slug-b')).toEqual({
      duration_ms: null,
      bytes_written: null,
      stderr_rate_limit_hits: 3,
      user_rating: null,
    });
    expect(got.get('slug-c')).toEqual({
      duration_ms: null,
      bytes_written: null,
      stderr_rate_limit_hits: 0,
      user_rating: null,
    });
    m.close();
  });

  it('returns empty Map for no matches and for empty input', () => {
    const m = new Memory(':memory:');
    expect(m.findEnrichmentsBySlugs(['bogus']).size).toBe(0);
    expect(m.findEnrichmentsBySlugs([]).size).toBe(0);
    m.close();
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/memory.test.ts`
Expected: FAIL — `m.findEnrichmentsBySlugs is not a function`.

### Step 3: Add the method

In `C:\Glean\src\lib\memory.ts`, add the following method to the `Memory` class. Position it after `listRecentRatableCandidates` (added in v0.4.0):

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
    const m = new Map<string, {
      duration_ms: number | null;
      bytes_written: number | null;
      stderr_rate_limit_hits: number;
      user_rating: 'kept' | 'discarded' | 'actioned' | null;
    }>();
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

The empty-input short-circuit avoids running `SELECT ... WHERE x IN ()`, which is invalid SQL.

### Step 4: Run tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/memory.test.ts && npm test && npx tsc --noEmit
```
Expected: memory tests pass (existing + 2 new). Full suite: 128 passing + 1 skipped (126 baseline + 2 new). TS clean.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/memory.ts src/lib/memory.test.ts && git commit -m "feat(memory): findEnrichmentsBySlugs for batched enrichment lookup

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Preserve `task_id` in `parseIndex` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\today.ts`
- Modify: `C:\Glean\src\lib\today.test.ts`

This task adds the join key to `IndexEntry`. The enrichment merge (Task 4) depends on it.

### Step 1: Write the failing test

Append to `C:\Glean\src\lib\today.test.ts`:

```ts
describe('findTodayDossiers task_id preservation', () => {
  it('preserves task_id from INDEX frontmatter on each entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-taskid-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\proj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - task_id: "task-abc"',
      '    title: "First"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '  - task_id: "task-def"',
      '    title: "Second"',
      '    status: ok',
      '    output: "B.md"',
      '    type: fetch-docs',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].task_id).toBe('task-abc');
    expect(r.projects[0].entries[1].task_id).toBe('task-def');
  });

  it('skips entries that lack task_id (validation guard)', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-notask-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - title: "Has task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '    task_id: "task-x"',
      '  - title: "No task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects[0].entries).toHaveLength(1);
    expect(r.projects[0].entries[0].task_id).toBe('task-x');
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/today.test.ts`
Expected: FAIL — `IndexEntry` doesn't have `task_id`, so the first test errors at the assertion (or the type check fails). The second test fails because both entries are returned.

### Step 3: Extend `IndexEntry` and `parseIndex`

In `C:\Glean\src\lib\today.ts`:

(a) Update the `IndexEntry` type (currently around line 12):

```ts
export type IndexEntry = {
  title: string;
  status: IndexEntryStatus;
  output: string;
  type: 'research-dossier' | 'fetch-docs';
  task_id: string;                                                 // NEW: required join key
  duration_ms?: number;                                            // NEW: optional, from memory.db (Task 4)
  bytes_written?: number;                                          // NEW: optional, from memory.db (Task 4)
  rate_limit_hits?: number;                                        // NEW: optional, from memory.db (Task 4)
  user_rating?: 'kept' | 'discarded' | 'actioned' | null;          // NEW: optional, from memory.db (Task 4)
};
```

(b) Modify `parseIndex` (currently around line 55) — add a `task_id` validation guard and include it in the constructed entry. Change the inner loop:

From:
```ts
  for (const raw of fm.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.title !== 'string' || typeof e.status !== 'string') continue;
    entries.push({
      title: e.title,
      status: e.status as IndexEntryStatus,
      output: typeof e.output === 'string' ? e.output : '',
      type: e.type === 'fetch-docs' ? 'fetch-docs' : 'research-dossier',
    });
  }
```

To:
```ts
  for (const raw of fm.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.title !== 'string' || typeof e.status !== 'string') continue;
    if (typeof e.task_id !== 'string') continue;                      // NEW: skip entries without task_id
    entries.push({
      title: e.title,
      status: e.status as IndexEntryStatus,
      output: typeof e.output === 'string' ? e.output : '',
      type: e.type === 'fetch-docs' ? 'fetch-docs' : 'research-dossier',
      task_id: e.task_id,                                              // NEW
    });
  }
```

### Step 4: Run tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/today.test.ts && npm test && npx tsc --noEmit
```
Expected: today tests pass (existing + 2 new). Full suite: 130 passing + 1 skipped. TS clean.

**Important caveat:** existing today tests that build fixture INDEX.md files MAY break if they don't include `task_id`. Run the full suite and check. If `today.test.ts`'s existing tests fail because their fixtures omit `task_id`, look at the `makeIndex` helper and other inline fixtures and add `task_id: 'task-<n>'` (any non-empty string) to each entry. The existing `v13-memory.test.ts` and `v15-today.test.ts` integration fixtures likewise — check them too. If you have to fix more than 5 fixtures, STOP and report — that's a sign the design needs a backward-compatibility consideration that the spec didn't anticipate.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/today.ts src/lib/today.test.ts && git commit -m "feat(today): preserve task_id from INDEX frontmatter on IndexEntry

Adds task_id as a required field on IndexEntry, including a parse-time
validation guard. This enables the memory.db enrichment join in the
next task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

If you fixed existing fixtures in Step 4, include those files in the commit too (e.g., `test/integration/v15-today.test.ts`) and update the commit body to mention the fixture additions.

---

## Task 4: Enrichment merge in `findTodayDossiers` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\today.ts`
- Modify: `C:\Glean\src\lib\today.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\today.test.ts`:

```ts
describe('findTodayDossiers enrichment merge', () => {
  it('attaches memory.db enrichment to entries by task_id', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-enr-'));

    // Create a real memory.db using the Memory class.
    const dbPath = join(root, 'memory.db');
    const Memory = require('./memory.js').Memory as typeof import('./memory.js').Memory;
    const mem = new Memory(dbPath);
    mem.recordRun('r-1', { project_path: 'C:\\proj', budget_seconds: 3600, max_parallel: 1, glean_version: '0.5.0' });
    const id = mem.recordCandidate('r-1', {
      candidate_slug: 'task-enr-1',
      candidate_type: 'research-dossier',
      title: 'Has enrichment',
      source_signal: 'git-todo',
      file_path: 'a.ts',
      est_value: 0.5,
      est_tokens: 500,
      priority_rank: 0,
    });
    (mem as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare('UPDATE candidates SET outcome=?, dossier_path=?, ended_at=?, duration_ms=?, bytes_written=?, stderr_rate_limit_hits=?, user_rating=? WHERE id=?')
      .run('ok', 'OUT.md', Date.now(), 720_000, 4300, 1, 'kept', id);
    mem.close();

    // INDEX.md with the matching task_id
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - task_id: "task-enr-1"',
      '    title: "Has enrichment"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    const entry = r.projects[0].entries[0];
    expect(entry.duration_ms).toBe(720_000);
    expect(entry.bytes_written).toBe(4300);
    expect(entry.rate_limit_hits).toBe(1);
    expect(entry.user_rating).toBe('kept');
  });

  it('returns entries with no enrichment fields when memory.db is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-nodb-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - task_id: "task-x"',
      '    title: "No memory.db"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    const entry = r.projects[0].entries[0];
    expect(entry.duration_ms).toBeUndefined();
    expect(entry.bytes_written).toBeUndefined();
    expect(entry.user_rating).toBeUndefined();
  });
});
```

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/today.test.ts`
Expected: the first test fails — entry has no enrichment fields. Second test passes (already correct: no merge yet means no fields).

### Step 3: Add the enrichment merge

In `C:\Glean\src\lib\today.ts`:

(a) Add imports at the top of the file (under the existing imports):

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';  // existing — note we add Memory below
import { join } from 'node:path';                                            // existing
import { parse as parseYaml } from 'yaml';                                   // existing
import { Memory } from './memory.js';                                        // NEW
```

(`existsSync` is already in the import; don't duplicate.)

(b) Modify `findTodayDossiers`. The current function (around line 30) ends with `return { date: targetDate, projects };`. Replace that with a merge step + return:

Current end:
```ts
  return { date: targetDate, projects };
}
```

New end:
```ts
  // Enrich entries with memory.db data when available. Silent on failure —
  // glean today should still work without telemetry, no stderr noise.
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
            e.rate_limit_hits = enr.stderr_rate_limit_hits;
            e.user_rating = enr.user_rating;
          }
        }
      } finally {
        memory.close();
      }
    } catch {
      // Silent degradation.
    }
  }

  return { date: targetDate, projects };
}
```

Positioning note: this merge runs AFTER the existing project-collection loop and BEFORE the `return`. Reuses the existing `projects` array (mutates entries in place — they were freshly constructed in `parseIndex` and are not shared).

### Step 4: Run tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/today.test.ts && npm test && npx tsc --noEmit
```
Expected: today tests pass (all 4 new from Tasks 3+4). Full suite: 132 passing + 1 skipped. TS clean.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/today.ts src/lib/today.test.ts && git commit -m "feat(today): merge memory.db enrichment into entries by task_id

Adds a post-scan step that opens memory.db (if it exists), batches a
single findEnrichmentsBySlugs lookup, and attaches duration/bytes/
rate_limit/user_rating to each entry. Silent degradation when
memory.db is missing or unreadable.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `formatEnrichmentLine` in `render-today.ts` (TDD)

**Files:**
- Modify: `C:\Glean\src\lib\render-today.ts`
- Modify: `C:\Glean\src\lib\render-today.test.ts`

### Step 1: Write the failing tests

Append to `C:\Glean\src\lib\render-today.test.ts`:

```ts
describe('renderToday enrichment line', () => {
  it('appends a third line with duration, bytes, and rating (plain mode)', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Handle TODO',
          status: 'ok',
          output: 'C:\\u\\glean\\dossiers\\g\\OUT.md',
          type: 'research-dossier',
          task_id: 't1',
          duration_ms: 720_000,    // 12m
          bytes_written: 4300,     // 4.2KB
          user_rating: 'kept',
        }],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('12m');
    expect(s).toContain('4.2KB');
    expect(s).toContain('rated: kept');
    // The three parts are bullet-separated:
    expect(s).toMatch(/12m\s*·\s*4\.2KB\s*·\s*rated: kept/);
  });

  it('omits the enrichment line when no fields apply', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'No data',
          status: 'ok',
          output: 'OUT.md',
          type: 'research-dossier',
          task_id: 't2',
          // no enrichment fields
        }],
      }],
    };
    const s = renderToday(r, false);
    // The entry should occupy exactly 2 lines (status + output path) for this project.
    // Easiest check: there's no '·' separator in the output (which only appears in enrichment line).
    expect(s).not.toContain('·');
    // And no enrichment-specific tokens.
    expect(s).not.toContain('rated:');
  });

  it('emits red ANSI for a discarded rating in color mode', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Bad',
          status: 'ok',
          output: 'OUT.md',
          type: 'research-dossier',
          task_id: 't3',
          duration_ms: 30_000,
          user_rating: 'discarded',
        }],
      }],
    };
    const s = renderToday(r, true);
    expect(s).toMatch(/\x1b\[31m.*rated: discarded.*\x1b\[0m/);
  });

  it('omits enrichment line for failed entries with no output', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Bad task',
          status: 'failed',
          output: '',
          type: 'research-dossier',
          task_id: 't4',
          duration_ms: 30_000,  // even with duration set, no line for no-output entries
        }],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('(no output)');
    expect(s).not.toMatch(/30s|30\s*·/);  // no duration string anywhere
  });
});
```

The fourth test covers a spec rule that wasn't in the spec's explicit test list but is in §5.3 ("Failed/no-output entries get no enrichment line"). Worth verifying.

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/render-today.test.ts`
Expected: all 4 new tests fail — `renderToday` doesn't yet produce the enrichment line. (The fourth test's `expect(s).toContain('(no output)')` may pass — that's existing behavior — but the negative assertion may pass too since there's nothing producing the duration string yet. Don't worry; it will all align after Step 3.)

### Step 3: Implement the helper + call site

In `C:\Glean\src\lib\render-today.ts`:

(a) Add helper functions at the bottom of the file (after `normalizePath`):

```ts
function formatEnrichmentLine(entry: IndexEntry, c: Painter): string | null {
  // Failed/no-output entries get no enrichment line.
  if (!entry.output) return null;

  // Each part is wrapped in its own painter call so the parts can be joined
  // plainly without ANSI nesting (\x1b[0m resets ALL attributes, not just
  // the inner color).
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
  const sep = c.dim(' · ');
  // Indent matches the output-path line: 17 spaces.
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

The `Painter` type referenced is already defined in `render-today.ts` from v0.2.1. The `IndexEntry` import is already at the top.

(b) Modify the main rendering loop inside `renderToday`. Find the section where each entry is rendered (the loop that pushes the status line and the output-path line). After the output-path push, add a conditional enrichment line push.

Current (approximate — exact line depends on file state):

```ts
    for (const e of p.entries) {
      const isOk = e.status === 'ok' || e.status === 'ok-fallback';
      const icon = isOk ? c.green('✓') : c.red('✗');
      const status = isOk ? c.green(e.status.padEnd(STATUS_COLUMN_WIDTH)) : c.red(e.status.padEnd(STATUS_COLUMN_WIDTH));
      lines.push(`  ${icon} ${status} ${e.title}`);
      const outputDisplay = e.output ? normalizePath(e.output) : '(no output)';
      lines.push(`                 ${c.dim(outputDisplay)}`);
    }
```

Updated:

```ts
    for (const e of p.entries) {
      const isOk = e.status === 'ok' || e.status === 'ok-fallback';
      const icon = isOk ? c.green('✓') : c.red('✗');
      const status = isOk ? c.green(e.status.padEnd(STATUS_COLUMN_WIDTH)) : c.red(e.status.padEnd(STATUS_COLUMN_WIDTH));
      lines.push(`  ${icon} ${status} ${e.title}`);
      const outputDisplay = e.output ? normalizePath(e.output) : '(no output)';
      lines.push(`                 ${c.dim(outputDisplay)}`);
      const enrLine = formatEnrichmentLine(e, c);
      if (enrLine !== null) lines.push(enrLine);
    }
```

### Step 4: Run tests + types + full suite + lint

```bash
cd /c/Glean && npx vitest run src/lib/render-today.test.ts && npm test && npx tsc --noEmit && npm run lint
```
Expected: all 4 new render-today tests pass. Full suite: 136 passing + 1 skipped (132 from Tasks 2–4 + 4 new). TS + lint clean.

If the lint flags `no-control-regex` on the new red-ANSI matcher in the third new test, the file-level `/* eslint-disable no-control-regex */` from v0.2.1 should already cover it. If not, add the disable.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/render-today.ts src/lib/render-today.test.ts && git commit -m "feat(today): formatEnrichmentLine renders telemetry as third line per entry

Adds dim duration/bytes/rate-limit segments plus colored rating
segment. ANSI segments are independently wrapped to avoid \\x1b[0m
collapsing outer dim attributes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Extend `v15-today.test.ts` integration test

**Files:**
- Modify: `C:\Glean\test\integration\v15-today.test.ts`

### Step 1: Inspect the current test

Read `C:\Glean\test\integration\v15-today.test.ts` first. It has two tests:
- `'prints a grouped report when dossiers exist for today'`
- `'prints the empty-case message when no dossiers exist'`

The first test creates an INDEX.md and spawns `node bin/glean.js today`. The second is unchanged by this release.

You will extend the first test to:
1. Seed a memory.db file alongside the dossiers folder with one candidate row whose `candidate_slug` matches the `task_id` in the INDEX fixture.
2. Set `duration_ms=720000`, `bytes_written=4300`, `user_rating='kept'` on that row.
3. Assert that stdout contains the enrichment strings (`12m`, `4.2KB`, `rated: kept`).

The INDEX fixture in the current test uses a specific `task_id` value — preserve or change it to a known value like `task-v15`.

### Step 2: Modify the test

Open `C:\Glean\test\integration\v15-today.test.ts`. The first test's setup block creates `dossierDir` and writes INDEX.md. Right after writing INDEX.md (and before `spawnSync`), add the memory.db seed:

```ts
    // Seed memory.db with matching enrichment so the enrichment line should appear.
    const dbPath = join(home, 'glean', 'memory.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
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
      .run('run-v15', Date.now(), 'C:\\demoproj', 3600, 1, '0.5.0');
    db.prepare(
      `INSERT INTO candidates
         (run_id, candidate_slug, fingerprint, candidate_type, title, source_signal,
          file_path, est_value, est_tokens, priority_rank, outcome, dossier_path,
          ended_at, duration_ms, bytes_written, user_rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-v15', 'task-v15', 'fp15', 'research-dossier', 'Handle TODO in src/a.ts',
      'git-todo', 'a.ts', 0.5, 500, 0, 'ok', 'OUT.md',
      Date.now(), 720_000, 4300, 'kept',
    );
    db.close();
```

Also ensure the INDEX fixture's first entry has `task_id: "task-v15"`. The current fixture writes entries — find the relevant entry block and verify or add `task_id: "task-v15"` to that entry. Be careful with YAML escaping if you have to add it: the existing pattern uses `'    task_id: "task-v15"'` as a line in the array.

Make the test function `async` if it isn't already (so `await import` works at the top).

### Step 3: Add the new assertions

After the existing assertions (`expect(res.stdout).toContain('GLEAN today —')`, etc.), add:

```ts
    expect(res.stdout).toContain('12m');
    expect(res.stdout).toContain('4.2KB');
    expect(res.stdout).toContain('rated: kept');
```

### Step 4: Run the test + full suite

```bash
cd /c/Glean && npx vitest run test/integration/v15-today.test.ts && npm test && npx tsc --noEmit && npm run lint
```
Expected: 2 passed in v15. Full suite: 136 passing + 1 skipped (no new tests; modified existing). TS + lint clean.

### Step 5: Commit

```bash
cd /c/Glean && git add test/integration/v15-today.test.ts && git commit -m "test(today): extend v15 integration test to assert enrichment line

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
  "version": "0.4.0",
```
to:
```json
  "version": "0.5.0",
```

### Step 2: Add the CHANGELOG entry

Open `C:\Glean\CHANGELOG.md`. Insert a new v0.5.0 section between `# Changelog` and the existing `## v0.4.0 — 2026-05-26` section:

```markdown
## v0.5.0 — 2026-05-26

`glean today` enriched with telemetry from `memory.db`. Closes the feedback loop: v0.3.0's passive sweep and v0.4.0's active ratings now become visible at the same place the user looks every day.

### Added
- Optional third line per entry in `glean today` output. Surfaces: duration (e.g. `12m`), output bytes (e.g. `4.2KB`), rate-limit hits (only when > 0, e.g. `1 rate-limit hit`), and user rating (e.g. `rated: kept` / `rated: discarded`). Bullet-separated, dim by default, with green/red color for the rating segment.
- New `Memory.findEnrichmentsBySlugs(slugs)` method — single batched lookup keyed by candidate slug.
- `task_id` is now preserved on `IndexEntry` (from the existing INDEX.md frontmatter). Used as the join key with memory.db.

### Why
Until this release, the data from v0.3.0 (dossier-existence sweep) and v0.4.0 (`glean rate`) accumulated silently in `memory.db` with no daily-rhythm surface. `glean today` now shows what the engine knows about each dossier without changing the existing two-line layout — the third line only appears when there's something to show.

### Compatibility
Non-breaking. Same CLI surface, same exit codes, same empty-case message. Silent degradation when `memory.db` is missing or unreadable — entries render as in v0.2.1 with no warning. Failed/no-output entries get no enrichment line (timing without context is misleading). The `dossier_existed_at_7d` column is still populated by the v0.3.0 sweep but is NOT shown in this release — it's always NULL for today's brand-new entries; a future historical-viewer subproject will surface it for past dates.

INDEX.md entries without a `task_id` field are now silently skipped at parse time. In practice every entry written since v0.1.0-mvp has had `task_id` — this is a defensive guard against corrupt files.

### Tests
- Suite: 126 + 1 skip → 136 + 1 skip.
- 2 new tests in `src/lib/memory.test.ts` (`findEnrichmentsBySlugs` matching and empty-input).
- 4 new tests in `src/lib/today.test.ts` (task_id preservation × 2; enrichment merge × 2).
- 4 new tests in `src/lib/render-today.test.ts` (enrichment line plain × 2; color × 1; no-output exclusion × 1).
- Existing `test/integration/v15-today.test.ts` extended to seed memory.db and assert the enrichment line.
```

### Step 3: Update ROADMAP.md

Open `C:\Glean\docs\ROADMAP.md`.

(a) Update the header:
```markdown
**Last updated:** 2026-05-26 (post-v0.5.0; `glean today` enriched with memory.db shipped)
**Current release:** [v0.5.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.5.0) (commit `<TBD>`)
```
(Commit SHA filled in Task 8. Leave `<TBD>` for now.)

(b) Remove the entire `### 1. \`glean today\` enriched with memory.db` section from **Up next**. Then renumber the remaining items:
- `### 1. \`glean peek\` + SessionStart hook integration` (was #2)
- `### 2. API-key fallback when Pro/Max rate-limits` (was #3)

(c) Update the "Strategic lens" preamble in **Up next**. Find the current sentence beginning `Both halves of the telemetry pair shipped` and replace it with one that reflects that surfacing also shipped:

Replace the current preamble's middle sentences (`item 1 surfaces both signals back via 'glean today'. Item 2 is the highest-leverage forward-momentum item ... Item 3 is engine durability.`) with:

`Both halves of the telemetry pair shipped (v0.3.0 passive sweep + v0.4.0 'glean rate' active ratings) and v0.5.0 surfaces both back in 'glean today'. Item 1 is now the highest-leverage forward-momentum item (compound memory across sessions). Item 2 is engine durability.`

Full updated paragraph:

```markdown
> **Strategic lens (2026-05-26):** The most load-bearing critique of the project is that the engine has no measure of dossier usefulness — you don't know if you'd open what it produces. Both halves of the telemetry pair shipped (v0.3.0 passive sweep + v0.4.0 `glean rate` active ratings) and v0.5.0 surfaces both back in `glean today`. Item 1 is now the highest-leverage forward-momentum item (compound memory across sessions). Item 2 is engine durability. Distribution / adoption items (POSIX port, npm publish, GitHub issues, demo media) consciously deferred until telemetry validates that the core is worth distributing.
```

(d) Update the "Deliberately second, not first:" note inside the (now-renumbered) `glean peek` item. Change to "Deliberately first, not first:" doesn't make sense — change instead to just remove the deferral note since it's now first anyway. Find the sentence `**Deliberately second, not first:** without telemetry first, you'd auto-print dossiers you don't even know are useful.` and replace with:

`**Why now:** telemetry from v0.3.0/v0.4.0/v0.5.0 is in place, so when peek lands you can validate which dossiers are worth auto-printing.`

(e) Update the "Smaller v0.2-shaped features" cross-reference for output adapters. Find: `only worth doing once \`glean today\` proves useful in dogfood (the v0.3.0 sweep + v0.4.0 ratings will tell).` Update to: `only worth doing once \`glean today\` proves useful in dogfood (telemetry now visible via v0.5.0 — start dogfooding).`

(f) Update the "Distribution prep" deferred note. Find: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + v0.4.0 ratings + Up next #1).` Update to: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + v0.4.0 ratings + v0.5.0 surfacing — all shipped).`

(g) Add a new entry to the **Done** section. Insert before the `v0.4.0` entry:

```markdown
- **v0.5.0** (2026-05-26, tag `v0.5.0`) — `glean today` enriched with memory.db. Surfaces duration, output bytes, rate-limit hits, and user rating as an optional third line per entry. Read-only enhancement; engine and INDEX.md untouched. Silent degradation when memory.db is absent. Closes the telemetry feedback loop by making v0.3.0/v0.4.0 signals visible at the daily-rhythm surface. See [v0.5.0 spec](./superpowers/specs/2026-05-26-glean-today-enriched-design.md), [v0.5.0 plan](./superpowers/plans/2026-05-26-glean-today-enriched.md).
- **v0.4.0** (2026-05-26, tag `v0.4.0`) — ...
```

### Step 4: Final verification

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all three exit 0. Test count: 136 passing + 1 skipped.

### Step 5: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/ROADMAP.md && git commit -m "chore: bump to v0.5.0 + CHANGELOG + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.5.0 -m "Merge v0.5.0 glean today enriched into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.5.0 -m "v0.5.0 — glean today enriched with memory.db"
```

### Step 3: Update ROADMAP commit SHA

Get the merge SHA:
```bash
cd /c/Glean && git log --oneline -1 main
```

Edit `C:\Glean\docs\ROADMAP.md` — find the header line containing `<TBD>` and replace it with the actual 7-char SHA prefix.

Commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.5.0 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 4: Verify final state

```bash
cd /c/Glean && git log --oneline -8 && git tag -l 'v0.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.1.0-mvp` through `v0.5.0` tags all present, `"version": "0.5.0"`.

### Step 5: Do NOT push without user approval

Per `CLAUDE.md`, do not push until explicitly told. When approved:
```bash
cd /c/Glean && git push origin main --follow-tags
```

---

## Done-when checklist (mirrors spec §1)

- [x] `Memory.findEnrichmentsBySlugs` exists and behaves correctly. (Task 2)
- [x] `IndexEntry` has `task_id` + 4 optional enrichment fields. (Task 3)
- [x] `parseIndex` preserves `task_id` and skips entries without it. (Task 3)
- [x] `findTodayDossiers` opens memory.db (only if exists) and merges enrichment. (Task 4)
- [x] Silent degradation when memory.db is absent or unreadable. (Task 4)
- [x] `formatEnrichmentLine` produces the third line with correct rules. (Task 5)
- [x] Failed/no-output entries get no enrichment line. (Task 5)
- [x] Unit tests across memory/today/render-today + extended integration. (Tasks 2–6)
- [x] `npm test`, `npm run build`, `npm run lint` exit 0. (Tasks 6 + 7 verify)
- [x] CHANGELOG v0.5.0 entry. (Task 7)
- [x] ROADMAP moves enriched-today to Done, renumbers Up next, updates cross-refs. (Task 7 + Task 8)
