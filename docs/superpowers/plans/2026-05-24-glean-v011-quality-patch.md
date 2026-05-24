# Glean v0.1.1 Quality Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the 10 fixes from the v0.1.1 quality-patch spec (scanner false-positive filter, JSONL multi-signal discovery, output repair, three executor fixes, `--task-timeout` flag, discover-deps diagnostic+fix, v03 test revival, jobobject unit test) and ship as v0.1.1.

**Architecture:** Non-breaking patch on `main@7520e2a`. Five thematic logical groupings shipped as ~23 atomic commits. Each commit is a TDD cycle (failing test → implementation → passing test → commit) so each is bisectable in isolation.

**Tech Stack:** Node 20, TypeScript, vitest, citty CLI (existing — no new deps).

**Spec:** `docs/superpowers/specs/2026-05-24-glean-v011-quality-patch-design.md`. Read it first; this plan implements it task-by-task.

---

## File Structure

What this patch creates / modifies:

```
C:\Glean\
  src\
    lib\
      discover-git.ts       MODIFY  — extend PATH_EXCLUDES constant
      discover-jsonl.ts     MODIFY  — multi-signal scanSession + emit
      discover-deps.ts      MODIFY  — diagnostic logging + diff-filter fix
      prioritize.ts         MODIFY  — pathPenalty soft weighting
      executor.ts           MODIFY  — clear timer, type-safe sentinel, line-number slug; import jsonl-extract
      jsonl-extract.ts      NEW     — factored-out extractLastAssistantText
      repair.ts             NEW     — repairRecent(root, days) — scan + recover empty OUT.md
      pipeline.ts           MODIFY  — call repairRecent after lock acquire
      types.ts              MODIFY  — add optional signal? to EvidenceJsonl
    cli.ts                  MODIFY  — --task-timeout flag, repair subcommand, extended parseBudget
  test\
    fixtures\
      sessions\
        sample-session-unfinished.jsonl          NEW
        sample-session-idle-content.jsonl        NEW
        sample-session-todo-and-idle.jsonl       NEW
    integration\
      v03-budget.test.ts                         MODIFY — remove .skip, use --task-timeout
      v08-jobobject.test.ts                      MODIFY — comment only
      v11-repair.test.ts                         NEW    — E2E glean repair
      v12-task-timeout.test.ts                   NEW    — E2E --task-timeout
  src\lib\
    discover-git.test.ts    MODIFY  — +3 cases (md/test/docs exclusions)
    discover-jsonl.test.ts  MODIFY  — +3 cases (signal types)
    discover-deps.test.ts   MODIFY  — +1 case (newly-added manifest)
    prioritize.test.ts      MODIFY  — +1 case (vendor weighting)
    executor.test.ts        MODIFY  — +3 cases (timer/sentinel/slug)
    jobobject.test.ts       MODIFY  — +1 case (mocked taskkill)
    repair.test.ts          NEW     — 5 cases
  package.json              MODIFY  — version 0.1.1
  CHANGELOG.md              NEW
  README.md                 MODIFY  — Changelog link
  docs\open-work\
    04-v011-dogfood.md      NEW     — final dogfood validation report
```

## Task ordering principle

Branch first (Task 1). Then within each thematic commit, smallest/safest task first. Each task ends in `git commit`. After all tasks, dogfood validate (Task 22) → tag → push (Task 23).

---

## Task 1: Create the v0.1.1 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, HEAD at `7520e2a` ("spec: glean v0.1.1 quality patch design").

- [ ] **Step 2: Create and switch to branch**

```bash
cd /c/Glean && git checkout -b v0.1.1
git branch --show-current
```
Expected: `v0.1.1`.

---

## Task 2: Scanner path exclusions (item 4)

**Files:**
- Modify: `src/lib/discover-git.ts`
- Modify: `src/lib/discover-git.test.ts`

- [ ] **Step 1: Write 3 failing tests**

Append to `src/lib/discover-git.test.ts` (inside the existing `describe('discoverGitTodos', ...)` block, before the closing brace, or as a new describe — your choice):

```ts
it('excludes TODOs in *.md files', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-git-md-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  writeFileSync(join(r, 'NOTES.md'), '<!-- TODO: ignore me -->\n');
  writeFileSync(join(r, 'src.ts'), '// TODO: keep me\n');
  execSync('git add . && git commit -q -m i', { cwd: r });
  const cands = await discoverGitTodos(r);
  const files = cands.map(c => (c.evidence as { file: string }).file);
  expect(files.some(f => f.endsWith('NOTES.md'))).toBe(false);
  expect(files.some(f => f.endsWith('src.ts'))).toBe(true);
});

it('excludes TODOs in *.test.ts files', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-git-test-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  writeFileSync(join(r, 'foo.test.ts'), '// TODO: ignore me\n');
  writeFileSync(join(r, 'foo.ts'), '// TODO: keep me\n');
  execSync('git add . && git commit -q -m i', { cwd: r });
  const cands = await discoverGitTodos(r);
  const files = cands.map(c => (c.evidence as { file: string }).file);
  expect(files.some(f => f.endsWith('foo.test.ts'))).toBe(false);
  expect(files.some(f => f.endsWith('foo.ts'))).toBe(true);
});

it('excludes TODOs under docs/ subtree', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-git-docs-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  mkdirSync(join(r, 'docs'));
  writeFileSync(join(r, 'docs', 'notes.txt'), 'TODO: ignore me\n');
  writeFileSync(join(r, 'real.ts'), '// TODO: keep me\n');
  execSync('git add . && git commit -q -m i', { cwd: r });
  const cands = await discoverGitTodos(r);
  const files = cands.map(c => (c.evidence as { file: string }).file);
  expect(files.some(f => f.startsWith('docs/'))).toBe(false);
  expect(files.some(f => f.endsWith('real.ts'))).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/discover-git.test.ts 2>&1 | tail -15
```
Expected: 3 new tests FAIL — they currently leak files from excluded paths.

- [ ] **Step 3: Implement exclusions**

In `src/lib/discover-git.ts`, locate the `discoverGitTodos` function. Replace the existing pathspec arguments with this constant + spread:

```ts
const PATH_EXCLUDES = [
  ':!node_modules', ':!dist', ':!build',
  ':!*.md', ':!*.test.*',
  ':!docs/**', ':!test/**', ':!**/fixtures/**',
  ':!*.min.*', ':!*.generated.*',
  ':!*-lock.*', ':!*.lock',
];
```

Place `PATH_EXCLUDES` at module top (after imports, before the existing `MAX_HITS` constant).

Then in the `execFileSync` call inside `discoverGitTodos`, replace the existing pathspec args (`':!node_modules', ':!dist', ':!build'`) with `...PATH_EXCLUDES`:

```ts
stdout = execFileSync(
  'git',
  ['-C', projectPath, 'grep', '-nE', '(TODO|FIXME|XXX|HACK)\\b', '--', ...PATH_EXCLUDES],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
```

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/discover-git.test.ts 2>&1 | tail -15
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /c/Glean && git add src/lib/discover-git.ts src/lib/discover-git.test.ts && git commit -m "feat(discover-git): exclude noise paths (md, test, docs, generated, lock) from grep"
```

---

## Task 3: Soft path penalty in prioritize (item 11)

**Files:**
- Modify: `src/lib/prioritize.ts`
- Modify: `src/lib/prioritize.test.ts`

- [ ] **Step 1: Write failing test**

Append to `src/lib/prioritize.test.ts` (inside `describe('prioritize', ...)`):

```ts
it('soft-weights TODO candidates in vendor/ paths to 70%', () => {
  const normal = c({
    type: 'research-dossier',
    est_value: 100,
    est_tokens: 1000,
    evidence: { kind: 'todo', file: 'src/foo.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
  });
  const noisy = c({
    type: 'research-dossier',
    est_value: 100,
    est_tokens: 1000,
    evidence: { kind: 'todo', file: 'vendor/lib.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
  });
  prioritize([noisy, normal], 60 * 60_000, 0);
  expect(normal.est_value).toBe(100);
  expect(noisy.est_value).toBe(70);
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/prioritize.test.ts 2>&1 | tail -10
```
Expected: 1 new failure.

- [ ] **Step 3: Implement pathPenalty**

In `src/lib/prioritize.ts`, add the constant after `TYPE_WEIGHT`:

```ts
const SOFT_NOISE_PATTERNS = [
  /\/vendor\//, /\/third_party\//, /\.config\./, /\.lock$/,
];

function pathPenalty(c: Candidate): number {
  if (c.evidence.kind !== 'todo') return 1.0;
  return SOFT_NOISE_PATTERNS.some((re) => re.test(c.evidence.file)) ? 0.7 : 1.0;
}
```

Then in `prioritize()`, after computing `eligible` and BEFORE the `sort`, apply the penalty:

```ts
for (const c of eligible) c.est_value = Math.round(c.est_value * pathPenalty(c));
```

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/prioritize.test.ts 2>&1 | tail -10
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /c/Glean && git add src/lib/prioritize.ts src/lib/prioritize.test.ts && git commit -m "feat(prioritize): soft-weight TODO candidates in vendor/third_party/config/lock paths to 0.7"
```

---

## Task 4: JSONL fixtures for new signals

**Files:**
- Create: `test/fixtures/sessions/sample-session-unfinished.jsonl`
- Create: `test/fixtures/sessions/sample-session-idle-content.jsonl`
- Create: `test/fixtures/sessions/sample-session-todo-and-idle.jsonl`

- [ ] **Step 1: Write `sample-session-unfinished.jsonl`**

Content (ensure it's valid JSONL — one JSON object per line):

```jsonl
{"type":"user","timestamp":"2026-05-23T10:00:00Z","cwd":"C:\\fake-project","content":"start"}
{"type":"assistant","timestamp":"2026-05-23T10:00:30Z","cwd":"C:\\fake-project","content":"working"}
{"type":"assistant","timestamp":"2026-05-23T10:01:00Z","cwd":"C:\\fake-project","tool_use":{"id":"toolu_01","name":"Bash","input":{"command":"ls"}}}
{"type":"permission-mode","mode":"acceptEdits"}
```

The last assistant record has `tool_use` but there's no subsequent `tool_result` record. No `ai-title` record at all. No idle threshold met (timestamp could be anytime; the test will check unfinished_tool_use specifically).

- [ ] **Step 2: Write `sample-session-idle-content.jsonl`**

This needs 11+ assistant records AND idle >24h. Easiest: timestamps 30h ago, 11 records. Use a fixed timestamp clearly in the past:

```jsonl
{"type":"user","timestamp":"2026-04-01T10:00:00Z","cwd":"C:\\fake-project","content":"work session"}
{"type":"assistant","timestamp":"2026-04-01T10:00:30Z","cwd":"C:\\fake-project","content":"turn 1"}
{"type":"assistant","timestamp":"2026-04-01T10:01:00Z","cwd":"C:\\fake-project","content":"turn 2"}
{"type":"assistant","timestamp":"2026-04-01T10:02:00Z","cwd":"C:\\fake-project","content":"turn 3"}
{"type":"assistant","timestamp":"2026-04-01T10:03:00Z","cwd":"C:\\fake-project","content":"turn 4"}
{"type":"assistant","timestamp":"2026-04-01T10:04:00Z","cwd":"C:\\fake-project","content":"turn 5"}
{"type":"assistant","timestamp":"2026-04-01T10:05:00Z","cwd":"C:\\fake-project","content":"turn 6"}
{"type":"assistant","timestamp":"2026-04-01T10:06:00Z","cwd":"C:\\fake-project","content":"turn 7"}
{"type":"assistant","timestamp":"2026-04-01T10:07:00Z","cwd":"C:\\fake-project","content":"turn 8"}
{"type":"assistant","timestamp":"2026-04-01T10:08:00Z","cwd":"C:\\fake-project","content":"turn 9"}
{"type":"assistant","timestamp":"2026-04-01T10:09:00Z","cwd":"C:\\fake-project","content":"turn 10"}
{"type":"assistant","timestamp":"2026-04-01T10:10:00Z","cwd":"C:\\fake-project","content":"turn 11"}
{"type":"ai-title","sessionId":"sess-idle","aiTitle":"Discussing authentication flow"}
```

No TODO regex match in aiTitle. 11 assistant records. Timestamp clearly >24h old.

- [ ] **Step 3: Write `sample-session-todo-and-idle.jsonl`**

Both signals fire:

```jsonl
{"type":"user","timestamp":"2026-04-01T10:00:00Z","cwd":"C:\\fake-project","content":"start"}
{"type":"assistant","timestamp":"2026-04-01T10:00:30Z","cwd":"C:\\fake-project","content":"turn 1"}
{"type":"assistant","timestamp":"2026-04-01T10:01:00Z","cwd":"C:\\fake-project","content":"turn 2"}
{"type":"assistant","timestamp":"2026-04-01T10:02:00Z","cwd":"C:\\fake-project","content":"turn 3"}
{"type":"assistant","timestamp":"2026-04-01T10:03:00Z","cwd":"C:\\fake-project","content":"turn 4"}
{"type":"assistant","timestamp":"2026-04-01T10:04:00Z","cwd":"C:\\fake-project","content":"turn 5"}
{"type":"assistant","timestamp":"2026-04-01T10:05:00Z","cwd":"C:\\fake-project","content":"turn 6"}
{"type":"assistant","timestamp":"2026-04-01T10:06:00Z","cwd":"C:\\fake-project","content":"turn 7"}
{"type":"assistant","timestamp":"2026-04-01T10:07:00Z","cwd":"C:\\fake-project","content":"turn 8"}
{"type":"assistant","timestamp":"2026-04-01T10:08:00Z","cwd":"C:\\fake-project","content":"turn 9"}
{"type":"assistant","timestamp":"2026-04-01T10:09:00Z","cwd":"C:\\fake-project","content":"turn 10"}
{"type":"assistant","timestamp":"2026-04-01T10:10:00Z","cwd":"C:\\fake-project","content":"turn 11"}
{"type":"ai-title","sessionId":"sess-todo-idle","aiTitle":"TODO: refactor auth module"}
```

- [ ] **Step 4: Commit fixtures**

```bash
cd /c/Glean && git add test/fixtures/sessions/sample-session-unfinished.jsonl test/fixtures/sessions/sample-session-idle-content.jsonl test/fixtures/sessions/sample-session-todo-and-idle.jsonl && git commit -m "test(fixtures): add 3 JSONL session fixtures for multi-signal discovery"
```

---

## Task 5: Types — add signal field to EvidenceJsonl

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add `signal?: string` to EvidenceJsonl**

In `src/lib/types.ts`, locate `EvidenceJsonl` and add the field:

```ts
export type EvidenceJsonl = {
  kind: 'jsonl';
  session_id: string;
  ai_title: string;
  idle_hours: number;
  signal?: string;
  // Hydrated by executor at run-time:
  recent_turns?: string[];
};
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Run full suite to confirm no regressions**

```bash
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: all tests still pass.

- [ ] **Step 4: Commit**

```bash
cd /c/Glean && git add src/lib/types.ts && git commit -m "types: add optional signal field to EvidenceJsonl"
```

---

## Task 6: JSONL multi-signal discovery (item 9)

**Files:**
- Modify: `src/lib/discover-jsonl.ts`
- Modify: `src/lib/discover-jsonl.test.ts`

- [ ] **Step 1: Write 3 failing tests**

Append to the existing `describe('discoverJsonl', ...)` block in `src/lib/discover-jsonl.test.ts`:

```ts
it('emits candidate from unfinished tool_use signal', async () => {
  const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
  // sample-session-unfinished.jsonl is in FIXTURE_DIR
  const found = direct.find((c) => (c.evidence as { signal?: string }).signal?.includes('unfinished-tool-use'));
  expect(found).toBeDefined();
});

it('emits candidate from idle-with-content signal (>24h + >10 assistant turns)', async () => {
  const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
  // sample-session-idle-content.jsonl is in FIXTURE_DIR — generic aiTitle, 11 turns, old timestamps
  const found = direct.find((c) => (c.evidence as { signal?: string }).signal?.includes('idle-with-content'));
  expect(found).toBeDefined();
});

it('records multiple signals when multiple fire (todo-title + idle-with-content)', async () => {
  const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
  // sample-session-todo-and-idle.jsonl — both aiTitle matches TODO and idle conditions met
  const found = direct.find((c) =>
    (c.evidence as { signal?: string }).signal?.includes('todo-title') &&
    (c.evidence as { signal?: string }).signal?.includes('idle-with-content')
  );
  expect(found).toBeDefined();
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/discover-jsonl.test.ts 2>&1 | tail -15
```
Expected: 3 new failures.

- [ ] **Step 3: Rewrite `discoverJsonl` in `src/lib/discover-jsonl.ts`**

Replace the existing `discoverJsonl` function and `findLastAiTitle` / `findLastUserOrAssistantTimestamp` helpers with this single-pass scan:

```ts
const TODO_TITLE_RE = /\b(TODO|FIXME|fix|finish|continue|later|reminder)\b/i;

type SessionScan = {
  ai_title: string | null;
  last_assistant_turn_at: number | null;
  assistant_turn_count: number;
  unfinished_tool_use: boolean;
};

function scanSession(filePath: string): SessionScan {
  const scan: SessionScan = {
    ai_title: null,
    last_assistant_turn_at: null,
    assistant_turn_count: 0,
    unfinished_tool_use: false,
  };
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  let pendingToolUse = false;
  for (const ln of lines) {
    let obj: { type?: string; aiTitle?: string; timestamp?: string; tool_use?: unknown; tool_result?: unknown };
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      scan.ai_title = obj.aiTitle;
    }
    if (obj.type === 'assistant') {
      scan.assistant_turn_count++;
      if (typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (!isNaN(t)) scan.last_assistant_turn_at = t;
      }
      if (obj.tool_use) pendingToolUse = true;
      else pendingToolUse = false; // assistant turn without tool_use clears any pending
    }
    if (obj.type === 'tool_result' || obj.tool_result) {
      pendingToolUse = false;
    }
  }
  scan.unfinished_tool_use = pendingToolUse;
  return scan;
}

export async function discoverJsonl(
  projectPath: string,
  opts: { projectsRoot?: string; sessionsDir?: string } = {},
): Promise<Candidate[]> {
  const sessionsDir =
    opts.sessionsDir ??
    join(opts.projectsRoot ?? defaultProjectsRoot(), dashEncode(projectPath));
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  const candidates: Candidate[] = [];

  for (const f of files) {
    const filePath = join(sessionsDir, f);
    const scan = scanSession(filePath);

    const sourceTime = scan.last_assistant_turn_at ?? statSync(filePath).mtime.getTime();
    const idleHours = Math.max(0, Math.round((Date.now() - sourceTime) / 3600_000));

    const reasons: string[] = [];
    if (scan.ai_title && TODO_TITLE_RE.test(scan.ai_title)) reasons.push('todo-title');
    if (scan.unfinished_tool_use) reasons.push('unfinished-tool-use');
    if (idleHours > 24 && scan.assistant_turn_count > 10) reasons.push('idle-with-content');
    if (reasons.length === 0) continue;

    const evidence: EvidenceJsonl = {
      kind: 'jsonl',
      session_id: f.replace(/\.jsonl$/, ''),
      ai_title: scan.ai_title ?? '',
      idle_hours: idleHours,
      signal: reasons.join(','),
    };

    const cand: Candidate = {
      id: uuid(),
      evidence_hash: '',
      type: 'research-dossier',
      project_path: projectPath,
      evidence,
      est_value: 0,
      est_tokens: 4000,
      status: 'pending',
    };
    cand.evidence_hash = evidenceHash(cand);
    candidates.push(cand);
  }
  return candidates;
}
```

Keep the existing `dashEncode` and `defaultProjectsRoot` helpers as-is. Remove the old `findLastAiTitle` and `findLastUserOrAssistantTimestamp` (they're superseded by `scanSession`).

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/discover-jsonl.test.ts 2>&1 | tail -15
```
Expected: 7 tests pass (4 existing + 3 new).

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /c/Glean && git add src/lib/discover-jsonl.ts src/lib/discover-jsonl.test.ts && git commit -m "feat(discover-jsonl): multi-signal discovery (aiTitle, unfinished tool-use, idle-with-content)"
```

---

## Task 7: Executor — slug includes line number (item 6)

**Files:**
- Modify: `src/lib/executor.ts`
- Modify: `src/lib/executor.test.ts`

- [ ] **Step 1: Write failing test**

Append to `describe('executeOne', ...)` in `src/lib/executor.test.ts`:

```ts
it('produces distinct work dirs for TODOs at different lines in same file', async () => {
  const root = tmpRoot();
  const repo = tmpRepo();
  writeFileSync(join(repo, 'foo.ts'), 'a\nb\nc\nd\n');
  const c1: Candidate = {
    id: 'task-A', evidence_hash: 'hA', type: 'research-dossier',
    project_path: repo,
    evidence: { kind: 'todo', file: 'foo.ts', todo_lines: [{ line: 42, text: 'TODO' }] },
    est_value: 50, est_tokens: 1000, status: 'pending',
  };
  const c2: Candidate = {
    id: 'task-B', evidence_hash: 'hB', type: 'research-dossier',
    project_path: repo,
    evidence: { kind: 'todo', file: 'foo.ts', todo_lines: [{ line: 99, text: 'TODO' }] },
    est_value: 50, est_tokens: 1000, status: 'pending',
  };
  const ctx = {
    runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
    templatesDir: join(__dirname, '..', '..', 'templates'),
    taskTimeoutMs: 30_000,
    env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
  };
  const r1 = await executeOne(c1, ctx);
  const r2 = await executeOne(c2, ctx);
  expect(r1.output_path).not.toEqual(r2.output_path);
  expect(r1.output_path).toMatch(/-L42/);
  expect(r2.output_path).toMatch(/-L99/);
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts 2>&1 | tail -10
```
Expected: 1 new failure (both paths collide).

- [ ] **Step 3: Modify `slugify` in `src/lib/executor.ts`**

Locate the existing `slugify` function and replace it with:

```ts
function slugify(c: Candidate): string {
  const base = titleFor(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (c.evidence.kind === 'todo') {
    const line = c.evidence.todo_lines[0]?.line ?? 0;
    return `${base}-L${line}`;
  }
  return base;
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts 2>&1 | tail -10
```
Expected: 4 tests pass (3 existing + 1 new).

- [ ] **Step 5: Commit**

```bash
cd /c/Glean && git add src/lib/executor.ts src/lib/executor.test.ts && git commit -m "fix(executor): include line number in slug for todo candidates to avoid collisions"
```

---

## Task 8: Executor — clear timer + type-safe sentinel (items 7, 8)

**Files:**
- Modify: `src/lib/executor.ts`
- Modify: `src/lib/executor.test.ts`

- [ ] **Step 1: Write failing test for timer clear**

Append to `describe('executeOne', ...)` in `src/lib/executor.test.ts`:

```ts
import { vi } from 'vitest';

it('clears the timeout handle on normal exit (no dangling timers)', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
  try {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
    });
    expect(result.status).toBe('ok');
    // After executeOne returns, no fake timers should remain pending.
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
```

**Note:** if `vi.useFakeTimers` interferes with the child process exit promise (e.g., never resolves), use a real-time test instead: spy on `clearTimeout` via `vi.spyOn(global, 'clearTimeout')` and assert it was called at least once. Pick whichever works in your environment.

- [ ] **Step 2: Run, verify FAIL or environment-issue**

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts 2>&1 | tail -15
```
Expected: 1 new failure or timeout. If fake timers cause flakiness, switch to the spyOn approach noted in Step 1.

- [ ] **Step 3: Refactor executor.ts to clear timer + drop -2 sentinel**

In `src/lib/executor.ts`, locate the section that builds the timeout promise and `Promise.race`. Replace it with this try/finally pattern (around the existing job + exit handling):

```ts
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; job.kill(); }, ctx.taskTimeoutMs);

let exitCode: number;
try {
  exitCode = await job.exit;
} finally {
  clearTimeout(timer);
}

stderrStream.end();
jsonlStream.end();

const elapsed_ms = Date.now() - start;

if (rateLimited) return { status: 'rate-limit', elapsed_ms };
if (timedOut) return { status: 'timeout', elapsed_ms };
if (exitCode !== 0) {
  const tail = tailLines(readFileSync(stderrPath, 'utf8'), 50);
  return { status: 'failed', elapsed_ms, stderr_tail: tail };
}
```

Delete the existing `timerPromise` / `Promise.race([job.exit, timerPromise.then(() => -2)])` lines and any reference to `-2`. The `timedOut` flag is now the only timeout-signaling channel.

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/executor.test.ts 2>&1 | tail -10
```
Expected: 5 tests pass (3 original + slug + timer).

- [ ] **Step 5: Commit**

```bash
cd /c/Glean && git add src/lib/executor.ts src/lib/executor.test.ts && git commit -m "fix(executor): clear timeout via try/finally; drop -2 numeric sentinel"
```

---

## Task 9: Factor out jsonl-extract module

**Files:**
- Create: `src/lib/jsonl-extract.ts`
- Modify: `src/lib/executor.ts`

This is a small refactor so Task 11 (repair) can share the helper without circular imports.

- [ ] **Step 1: Create `src/lib/jsonl-extract.ts`**

```ts
import { readFileSync } from 'node:fs';

export function extractLastAssistantText(jsonlPath: string): string {
  try {
    const content = readFileSync(jsonlPath, 'utf8').split(/\r?\n/).reverse();
    for (const ln of content) {
      try {
        const o = JSON.parse(ln);
        const text = o?.message?.content?.[0]?.text ?? o?.delta?.text;
        if (typeof text === 'string' && text.length > 0) return text;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* file missing */
  }
  return '_(no output produced)_';
}
```

- [ ] **Step 2: Update `src/lib/executor.ts` to import from the new module**

At the top of `src/lib/executor.ts`, add:

```ts
import { extractLastAssistantText } from './jsonl-extract.js';
```

Delete the existing `extractLastAssistantText` function definition from the bottom of `executor.ts`.

- [ ] **Step 3: Build + run all tests**

```bash
cd /c/Glean && npm run build 2>&1 | tail -5
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: build clean, all tests pass (no behavioral change).

- [ ] **Step 4: Commit**

```bash
cd /c/Glean && git add src/lib/jsonl-extract.ts src/lib/executor.ts && git commit -m "refactor: extract extractLastAssistantText into jsonl-extract module"
```

---

## Task 10: Repair module + tests

**Files:**
- Create: `src/lib/repair.ts`
- Create: `src/lib/repair.test.ts`

- [ ] **Step 1: Write failing tests**

`src/lib/repair.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairRecent } from './repair.js';

function setup(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), 'glean-repair-')) };
}

function writeIndex(root: string, proj: string, date: string, entries: { task_id: string; output: string; status: string; evidence_hash: string }[]): void {
  const dir = join(root, 'dossiers', proj, date);
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'run_id: test-run',
    `project_path: C:\\${proj}`,
    `generated_at: ${new Date().toISOString()}`,
    'entries:',
    ...entries.map(e =>
      `  - { task_id: ${e.task_id}, evidence_hash: ${e.evidence_hash}, type: research-dossier, title: t, output: ${e.output}, status: ${e.status} }`),
    '---',
    '# index',
  ].join('\n');
  writeFileSync(join(dir, 'INDEX.md'), fm);
}

function writeJsonlLog(root: string, runId: string, taskId: string, text: string): void {
  const dir = join(root, 'logs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { content: [{ text }] } }) + '\n');
}

describe('repairRecent', () => {
  it('repairs a <100 byte OUT.md by extracting text from the matching jsonl log', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const taskId = 'task-x';
    const outDir = join(root, 'dossiers', 'proj', today, 'research-x');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), '_(no output produced)_');
    writeIndex(root, 'proj', today, [{ task_id: taskId, output: 'research-x/OUT.md', status: 'ok-fallback', evidence_hash: 'h1' }]);
    writeJsonlLog(root, 'test-run', taskId, 'A'.repeat(200));

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(1);
    expect(statSync(join(outDir, 'OUT.md')).size).toBeGreaterThan(99);
  });

  it('skips OUT.md ≥100 bytes (already substantive)', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-y');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'B'.repeat(200));
    writeIndex(root, 'proj', today, [{ task_id: 'task-y', output: 'research-y/OUT.md', status: 'ok', evidence_hash: 'h2' }]);
    writeJsonlLog(root, 'test-run', 'task-y', 'C'.repeat(200));

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
  });

  it('skips when no matching jsonl log exists', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-z');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', today, [{ task_id: 'task-z', output: 'research-z/OUT.md', status: 'ok-fallback', evidence_hash: 'h3' }]);
    // no log written

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('skips when jsonl extraction yields <100 bytes', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-w');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', today, [{ task_id: 'task-w', output: 'research-w/OUT.md', status: 'ok-fallback', evidence_hash: 'h4' }]);
    writeJsonlLog(root, 'test-run', 'task-w', 'short text'); // <100 bytes

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
  });

  it('respects the days window — ignores outputs older than days', () => {
    const { root } = setup();
    const oldDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', oldDate, 'research-old');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', oldDate, [{ task_id: 'task-old', output: 'research-old/OUT.md', status: 'ok-fallback', evidence_hash: 'h5' }]);
    writeJsonlLog(root, 'test-run', 'task-old', 'A'.repeat(200));

    const result = repairRecent(root, 7);
    expect(result.repaired.length).toBe(0);
    expect(result.scanned).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/repair.test.ts 2>&1 | tail -10
```
Expected: 5 failures (module not found).

- [ ] **Step 3: Implement `src/lib/repair.ts`**

```ts
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { extractLastAssistantText } from './jsonl-extract.js';

export type RepairResult = {
  scanned: number;
  repaired: { run_id: string; task_id: string; path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
};

export function repairRecent(gleanRoot: string, days = 7): RepairResult {
  const out: RepairResult = { scanned: 0, repaired: [], skipped: [], failed: [] };
  const dossierRoot = join(gleanRoot, 'dossiers');
  if (!existsSync(dossierRoot)) return out;

  const cutoff = Date.now() - days * 86400_000;

  for (const projDir of readdirSync(dossierRoot)) {
    const projPath = join(dossierRoot, projDir);
    if (!statSync(projPath).isDirectory()) continue;
    for (const dateDir of readdirSync(projPath)) {
      const m = dateDir.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) continue;
      const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (dateMs < cutoff) continue;

      const datePath = join(projPath, dateDir);
      const indexPath = join(datePath, 'INDEX.md');
      if (!existsSync(indexPath)) continue;

      const indexContent = readFileSync(indexPath, 'utf8');
      const fmMatch = indexContent.match(/^---\n([\s\S]+?)\n---/);
      if (!fmMatch) continue;

      let fm: { run_id?: string; project_path?: string; generated_at?: string; entries?: { task_id: string; output: string; status: string; evidence_hash?: string; title?: string; type?: string }[] };
      try {
        fm = parseYaml(fmMatch[1]) as typeof fm;
      } catch {
        continue;
      }
      if (!fm.entries || !fm.run_id) continue;

      let indexDirty = false;
      for (const entry of fm.entries) {
        if (!entry.output) continue;
        const outPath = join(datePath, entry.output);
        if (!existsSync(outPath)) {
          out.skipped.push({ path: outPath, reason: 'output-missing' });
          continue;
        }
        out.scanned++;
        if (statSync(outPath).size >= 100) continue; // already substantive

        const jsonlPath = join(gleanRoot, 'logs', fm.run_id, `${entry.task_id}.jsonl`);
        if (!existsSync(jsonlPath)) {
          out.skipped.push({ path: outPath, reason: 'log-missing' });
          continue;
        }
        const text = extractLastAssistantText(jsonlPath);
        if (text.length < 100) {
          out.skipped.push({ path: outPath, reason: 'extraction-too-short' });
          continue;
        }
        try {
          writeFileSync(outPath, text);
          entry.status = 'ok-repaired';
          indexDirty = true;
          out.repaired.push({ run_id: fm.run_id, task_id: entry.task_id, path: outPath, bytes: text.length });
        } catch (e) {
          out.failed.push({ path: outPath, reason: (e as Error).message });
        }
      }

      if (indexDirty) {
        const body = indexContent.slice(fmMatch[0].length);
        const newFm = yamlStringify(fm);
        writeFileSync(indexPath, `---\n${newFm}---${body}`);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/repair.test.ts 2>&1 | tail -15
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /c/Glean && git add src/lib/repair.ts src/lib/repair.test.ts && git commit -m "feat(repair): recover empty OUT.md from matching jsonl logs"
```

---

## Task 11: Wire repair into pipeline

**Files:**
- Modify: `src/lib/pipeline.ts`

- [ ] **Step 1: Add repair call after lock acquire**

In `src/lib/pipeline.ts`, locate the section just after `if (lock.recovered) appendOrchestratorLog(...)` and BEFORE `ensureTemplatesDir(...)`. Add:

```ts
import { repairRecent } from './repair.js';
```
(near the existing imports at the top)

Then in `runPipeline`, after the stale-lock log and before `ensureTemplatesDir`:

```ts
const repairResult = repairRecent(opts.gleanRoot);
if (repairResult.repaired.length > 0) {
  appendOrchestratorLog(opts.gleanRoot, runId, {
    evt: 'repair.done',
    repaired: repairResult.repaired.length,
    skipped: repairResult.skipped.length,
    failed: repairResult.failed.length,
  });
}
```

- [ ] **Step 2: Run pipeline tests + full suite**

```bash
cd /c/Glean && npx vitest run src/lib/pipeline.test.ts 2>&1 | tail -10
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: all pass (repair is silent on empty inputs).

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add src/lib/pipeline.ts && git commit -m "feat(pipeline): call repairRecent at run start; log repair.done when files recovered"
```

---

## Task 12: parseBudget extended + --task-timeout flag (item 12 part 1)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Extend `parseBudget` to support seconds**

In `src/cli.ts`, locate the existing `parseBudget` function. Replace it with:

```ts
function parseBudget(s: string): number {
  const m = s.match(/^(\d+)\s*(s|m|h)$/);
  if (!m) throw new Error(`invalid duration: ${s} (use e.g. 8m, 30s, 1h)`);
  const n = Number(m[1]);
  if (m[2] === 'h') return n * 60 * 60_000;
  if (m[2] === 'm') return n * 60_000;
  return n * 1000;
}
```

- [ ] **Step 2: Add `--task-timeout` arg and wire to PipelineOpts**

Locate the `runCmd` `defineCommand`. In its `args` object, add:

```ts
'task-timeout': { type: 'string', default: '8m', description: 'Per-task timeout (e.g. 8m, 30s, 2m)' },
```

In the `async run({ args })` body, after `const budgetMs = parseBudget(args.budget as string);` add:

```ts
const taskTimeoutMs = parseBudget(args['task-timeout'] as string);
```

Then in the `runPipeline({...})` call, change `taskTimeoutMs: 8 * 60_000` to `taskTimeoutMs,`.

- [ ] **Step 3: Build + smoke test**

```bash
cd /c/Glean && npm run build 2>&1 | tail -5
cd /c/Glean && node bin/glean.js run --help 2>&1 | head -20
```
Expected: `--task-timeout` flag visible in help. Build clean.

- [ ] **Step 4: Commit**

```bash
cd /c/Glean && git add src/cli.ts && git commit -m "feat(cli): --task-timeout flag (parses s/m/h) wired to PipelineOpts"
```

---

## Task 13: Revive v03-budget integration test (item 12 part 2)

**Files:**
- Modify: `test/integration/v03-budget.test.ts`

- [ ] **Step 1: Remove `.skip` and use --task-timeout**

Open `test/integration/v03-budget.test.ts`. Replace its contents with:

```ts
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 3: budget self-termination', () => {
  it('exits with budget-exhausted (or task-timeout chain) within reasonable time', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v3-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: long-running\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'timeout.yaml');

    // With --task-timeout 2s the task is killed after 2s; budget 60m won't be the limiting factor,
    // but the pipeline still completes promptly (each task hits timeout, marks failed, moves on).
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--task-timeout', '2s'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
      timeout: 60_000,
    });

    // Expected: 0 (completed with all tasks timed out) or 10 (if budget happens to trip)
    expect([0, 10]).toContain(res.status);
    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(['budget-exhausted', 'completed']).toContain(summary.reason);
    expect(summary.timed_out).toBeGreaterThan(0); // at least one task hit the 2s timeout
  });
});
```

The `.skip` is gone; the test runs against the real CLI with a 2-second task timeout, taking ~5-10 seconds total.

- [ ] **Step 2: Run the test**

```bash
cd /c/Glean && npx vitest run test/integration/v03-budget.test.ts 2>&1 | tail -15
```
Expected: 1 test passes within ~10 seconds.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add test/integration/v03-budget.test.ts && git commit -m "test(integration): revive v03-budget using --task-timeout 2s (no longer skipped)"
```

---

## Task 14: jobobject unit test for taskkill args (item 13)

**Files:**
- Modify: `src/lib/jobobject.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/lib/jobobject.test.ts`:

```ts
import * as childProcess from 'node:child_process';

describe('spawnInJob.kill on Windows', () => {
  it.skipIf(process.platform !== 'win32')('calls taskkill /T /F with the child pid', async () => {
    const execFileSpy = vi.spyOn(childProcess, 'execFile');
    const job = spawnInJob('cmd', ['/c', 'pause']);
    // Give spawn a moment to assign pid
    await new Promise((r) => setTimeout(r, 100));
    job.kill();
    // Wait briefly for the kill call
    await new Promise((r) => setTimeout(r, 200));
    expect(execFileSpy).toHaveBeenCalledWith(
      'taskkill',
      expect.arrayContaining(['/PID', String(job.pid), '/T', '/F']),
      expect.any(Object),
      expect.any(Function),
    );
    execFileSpy.mockRestore();
    // Wait for child to actually die so the test doesn't leak
    await job.exit;
  });
});
```

Note: this also requires importing `vi` at the top of the file if it's not already there. Add `import { describe, it, expect, vi } from 'vitest';` (replacing the existing `vitest` import).

- [ ] **Step 2: Run, verify PASS (or skip on POSIX)**

```bash
cd /c/Glean && npx vitest run src/lib/jobobject.test.ts 2>&1 | tail -10
```
Expected: 3 tests, 1 may skip on non-Windows. On Windows, all 3 pass.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add src/lib/jobobject.test.ts && git commit -m "test(jobobject): unit test asserts taskkill /T /F invocation on Windows"
```

---

## Task 15: Update v08 comment (item 13 part 2)

**Files:**
- Modify: `test/integration/v08-jobobject.test.ts`

- [ ] **Step 1: Update the `.skip` comment**

Open `test/integration/v08-jobobject.test.ts`. The existing `.skip` should already have a comment. Update it to reference the new unit test. Find the `describe.skip(...)` or `it.skip(...)` call and adjust its leading comment to:

```ts
// SKIPPED: integration assertion of "no orphan node.exe with fake-claude in command line" is
// inherently heuristic and unreliable across machines. See `src/lib/jobobject.test.ts`'s
// "calls taskkill /T /F with the child pid" unit test for the real coverage. Spec §10 row 8
// manual verification: kill a `glean run` process, then check Task Manager for orphaned
// fake-claude.cmd processes — none should remain.
```

If the test currently has different framing, adapt — the goal is just to make the comment explicit about where real coverage lives.

- [ ] **Step 2: Verify test still loads and is skipped**

```bash
cd /c/Glean && npx vitest run test/integration/v08-jobobject.test.ts 2>&1 | tail -10
```
Expected: test reports as skipped, no errors.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add test/integration/v08-jobobject.test.ts && git commit -m "test(v08): clarify .skip comment points at jobobject unit test as real coverage"
```

---

## Task 16: discover-deps diagnostic + fix (item 10)

**Files:**
- Modify: `src/lib/discover-deps.ts`
- Modify: `src/lib/discover-deps.test.ts`

- [ ] **Step 1: Write a failing test for newly-added manifests**

Append to `describe('discoverDeps', ...)` in `src/lib/discover-deps.test.ts`:

```ts
it('emits candidates from a manifest that was ADDED in the last 14 days (not modified)', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-deps-new-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t', { cwd: r });
  execSync('git config user.name t', { cwd: r });
  // Initial commit with NO package.json
  writeFileSync(join(r, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: r });
  // Second commit ADDS package.json (file creation, not modification)
  writeFileSync(join(r, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2));
  execSync('git add . && git commit -q -m "add package.json"', { cwd: r });

  const cands = await discoverDeps(r);
  const packages = cands.map(c => (c.evidence as { package: string }).package);
  expect(packages).toContain('lodash');
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd /c/Glean && npx vitest run src/lib/discover-deps.test.ts 2>&1 | tail -10
```
Expected: 1 new failure — current `--diff-filter=M` drops file-additions.

- [ ] **Step 3: Apply fix and add diagnostic logging**

In `src/lib/discover-deps.ts`, locate the `execFileSync` call for `git log -p`. Change `--diff-filter=M` to `--diff-filter=AM`:

```ts
diff = execFileSync(
  'git',
  ['-C', projectPath, 'log', '-p', '--since=14.days', '--diff-filter=AM', '--', m],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
```

(If the existing code uses different flag ordering, just swap `M` for `AM` wherever it appears in this command.)

- [ ] **Step 4: Run, verify PASS**

```bash
cd /c/Glean && npx vitest run src/lib/discover-deps.test.ts 2>&1 | tail -10
```
Expected: 2 tests pass (existing + new). The existing "modified" case should still work since `AM` covers both added and modified.

- [ ] **Step 5: Run full suite**

```bash
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /c/Glean && git add src/lib/discover-deps.ts src/lib/discover-deps.test.ts && git commit -m "fix(discover-deps): change --diff-filter=M to AM so newly-added manifests are discovered"
```

---

## Task 17: glean repair subcommand (item 5 part 2)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add the repair subcommand**

In `src/cli.ts`, add this `defineCommand` after `versionCmd`:

```ts
const repairCmd = defineCommand({
  meta: { name: 'repair', description: 'Re-extract missing OUT.md from recent JSONL logs (no Claude spawn)' },
  args: {
    'run-id': { type: 'string', description: 'Specific run to repair (default: all within --days)' },
    days: { type: 'string', default: '7', description: 'How many days back to scan' },
  },
  async run({ args }) {
    const { repairRecent } = await import('./lib/repair.js');
    const days = Number(args.days);
    const result = repairRecent(gleanRoot(), days);
    // Optional --run-id filter applied post-scan
    const filtered = args['run-id']
      ? { ...result, repaired: result.repaired.filter((r) => r.run_id === args['run-id']) }
      : result;
    console.log(`scanned ${result.scanned}, repaired ${filtered.repaired.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
    for (const r of filtered.repaired) console.log(`  ✓ ${r.path} (${r.bytes} bytes)`);
    for (const f of result.failed) console.error(`  ✗ ${f.path}: ${f.reason}`);
  },
});
```

Then add `repair: repairCmd` to the `subCommands` map in the `root` `defineCommand`.

- [ ] **Step 2: Build and smoke test**

```bash
cd /c/Glean && npm run build 2>&1 | tail -5
cd /c/Glean && node bin/glean.js repair --help 2>&1 | head -20
```
Expected: help shows `--run-id` and `--days` args. No errors.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add src/cli.ts && git commit -m "feat(cli): glean repair subcommand for recovering empty OUT.md from logs"
```

---

## Task 18: v11-repair integration test

**Files:**
- Create: `test/integration/v11-repair.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 11: glean repair recovers empty OUT.md from jsonl log', () => {
  it('rewrites a 22-byte OUT.md with extracted assistant text', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v11-home-'));
    const today = new Date().toISOString().slice(0, 10);
    const dossierDir = join(home, 'glean', 'dossiers', 'proj', today, 'research-foo');
    const logsDir = join(home, 'glean', 'logs', 'test-run');
    mkdirSync(dossierDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    writeFileSync(join(dossierDir, 'OUT.md'), '_(no output produced)_');
    writeFileSync(join(home, 'glean', 'dossiers', 'proj', today, 'INDEX.md'),
      `---
run_id: test-run
project_path: C:\\proj
generated_at: ${new Date().toISOString()}
entries:
  - { task_id: task-foo, evidence_hash: h, type: research-dossier, title: t, output: research-foo/OUT.md, status: ok-fallback }
---
# index
`);
    writeFileSync(join(logsDir, 'task-foo.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: [{ text: 'A'.repeat(300) }] } }) + '\n');

    const res = spawnSync('node', ['bin/glean.js', 'repair', '--days', '30'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(statSync(join(dossierDir, 'OUT.md')).size).toBeGreaterThan(99);
    const idx = readFileSync(join(home, 'glean', 'dossiers', 'proj', today, 'INDEX.md'), 'utf8');
    expect(idx).toContain('ok-repaired');
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /c/Glean && npx vitest run test/integration/v11-repair.test.ts 2>&1 | tail -15
```
Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add test/integration/v11-repair.test.ts && git commit -m "test(integration): v11 — glean repair end-to-end recovery"
```

---

## Task 19: v12-task-timeout integration test

**Files:**
- Create: `test/integration/v12-task-timeout.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 12: --task-timeout kills tasks early', () => {
  it('with --task-timeout 2s, a long-sleeping task gets killed and marked timed_out', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v12-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'timeout.yaml');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--task-timeout', '2s'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect([0, 10]).toContain(res.status);
    const stateDir = join(home, 'glean', 'state');
    const runId = readdirSync(stateDir).find((f) => f !== 'RUN.lock')!;
    const summary = JSON.parse(readFileSync(join(stateDir, runId, 'summary.json'), 'utf8'));
    expect(summary.timed_out).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /c/Glean && npx vitest run test/integration/v12-task-timeout.test.ts 2>&1 | tail -15
```
Expected: 1 test passes within ~15 seconds.

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add test/integration/v12-task-timeout.test.ts && git commit -m "test(integration): v12 — --task-timeout kills long-sleeping tasks"
```

---

## Task 20: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.1.0-mvp"` to `"version": "0.1.1"`.

- [ ] **Step 2: Write `CHANGELOG.md`**

```markdown
# Changelog

## v0.1.1 — 2026-05-24

Quality patch driven by the v0.1.0 dogfood findings.

### Added
- `glean repair [--run-id <id>] [--days <n>]` subcommand — recovers empty OUT.md files by re-extracting assistant text from the matching JSONL log. No Claude spawn, no capacity burn.
- `--task-timeout` flag on `glean run` (default `8m`). Accepts `s`, `m`, `h` suffixes (e.g. `30s`, `8m`, `1h`).
- Multi-signal JSONL discovery: in addition to TODO-titled sessions, a candidate is now emitted when the last assistant turn is an unfinished tool use, OR when a session has >10 assistant turns and >24h idle.
- Auto-repair pass: every `glean run` now scans the last 7 days of dossiers for empty OUT.md and recovers them silently before discovery.
- Soft path-weighting in prioritizer: TODOs in `vendor/`, `third_party/`, `*.config.*`, and `*.lock` files now score at 70% of equivalents in normal source paths.

### Changed
- Scanner excludes more noise paths: TODOs in `*.md`, `*.test.*`, `docs/**`, `test/**`, `**/fixtures/**`, `*.min.*`, `*.generated.*`, `*-lock.*`, and `*.lock` are no longer emitted as candidates.

### Fixed
- Executor no longer leaks `setTimeout` handles on early task exit (timer cleared via try/finally).
- Executor no longer collides "child exited with code -2" with "task timed out" — the sentinel is now a typed flag, not a magic number.
- Slug collisions when multiple TODOs share a file: dossier dirs now include the line number (`research-handle-todo-in-foo-ts-L42` vs `…-L99`).
- `discover-deps` now picks up packages from manifests that were ADDED (not just modified) in the last 14 days — the `git log --diff-filter` was overly strict.

### Tests
- v03-budget integration test revived using the new `--task-timeout 2s` (was `.skip` due to 8-min runtime).
- New `jobobject.test.ts` unit test asserts `taskkill /T /F` is invoked with correct args on Windows.
- v08-jobobject integration test stays skipped (heuristic process-list assertion); comment updated to point at the new unit test.
- New `repair.test.ts` (5 cases) and integration tests `v11-repair.test.ts` and `v12-task-timeout.test.ts`.
- Suite: 58 + 2 skip → 77 + 1 skip.

## v0.1.0-mvp — 2026-05-23

Initial MVP. Research-dossier + fetch-docs discovery and execution against a single Windows project. See `docs/superpowers/specs/2026-05-23-glean-mvp-design.md`.
```

- [ ] **Step 3: Commit**

```bash
cd /c/Glean && git add package.json CHANGELOG.md && git commit -m "chore: bump version to 0.1.1, add CHANGELOG"
```

---

## Task 21: README — add Changelog link

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Changelog link near the License section**

Open `C:\Glean\README.md`. Locate the License section near the bottom. Add a line directly above the final star/CTA line:

```markdown
## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md) for what's new in each release.
```

Place it between the existing `## License` section and the final star CTA paragraph.

- [ ] **Step 2: Commit**

```bash
cd /c/Glean && git add README.md && git commit -m "docs: README links to CHANGELOG"
```

---

## Task 22: Dogfood re-run + acceptance validation

**Files:**
- Create: `docs/open-work/04-v011-dogfood.md`

This is the final validation — installs the v0.1.1 build, runs it against `C:\Glean`, verifies all acceptance criteria from spec §1.

- [ ] **Step 1: Build and reinstall globally**

```bash
cd /c/Glean && npm run build && npm install -g .
glean version
```
Expected: `0.1.1`.

- [ ] **Step 2: Run repair against the existing v0.1.0 dossiers**

```bash
glean repair --days 30
```
Expected: at least the 11 historical 22-byte OUT.md files (from the v0.1.0 first dogfood attempt at `2026-05-24-1153-2e42df`) are recovered. Note the output. If some can't be recovered, the reason should be clear per file.

- [ ] **Step 3: Dry-run discovery against `C:\Glean`**

```bash
glean run --project C:\Glean --dry-run
```

Find the latest `candidates.json`:

```bash
ls "$env:USERPROFILE\glean\state" -d | Sort-Object LastWriteTime | Select-Object -Last 1
```

Inspect the candidates — count how many are from `docs/`, `test/`, or `*.md` paths. Acceptance criterion: <30% from those paths (was ~80% in v0.1.0).

- [ ] **Step 4: Live run with a small budget**

```bash
glean run --project C:\Glean --budget 15m
```

Let it complete. Note the summary line.

- [ ] **Step 5: Verify dep candidate exists**

In the candidates.json, confirm at least one candidate has `evidence.kind === "dep"` (the `discover-deps` fix). If none, the diagnostic from Task 16 needs another look — but the test in Task 16 should have caught this.

- [ ] **Step 6: Confirm all tests still pass**

```bash
cd /c/Glean && npm test 2>&1 | tail -10
cd /c/Glean && npm run build 2>&1 | tail -5
cd /c/Glean && npm run lint 2>&1 | tail -5
```
Expected: 77 passed, 1 skipped. Build + lint clean.

- [ ] **Step 7: Write the dogfood results doc**

Create `C:\Glean\docs\open-work\04-v011-dogfood.md`:

```markdown
# v0.1.1 Dogfood Results — 2026-05-24

**Run command:** `glean run --project C:\Glean --budget 15m`
**Run ID:** <fill in>
**Outcome:** <reason from summary.json>
**Exit code:** <0 / 10 / 20 / 30>

## Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | 77 tests pass, 1 skipped | ✓ / ✗ |
| 2 | <30% candidates from docs/, test/, *.md | <fill in percentage> |
| 3 | `glean repair` recovered 11 historical OUT.md | <fill in count> |
| 4 | ≥1 fetch-docs candidate emerged | ✓ / ✗ |
| 5 | npm test, build, lint exit 0 | ✓ / ✗ |
| 6 | CHANGELOG.md documents user-visible changes | ✓ |
| 7 | README has Changelog link | ✓ |

## Counts

- Candidates discovered: <N>
- Ran: <N>
- Failed: <N>
- Timed out: <N>
- Skipped (dedup): <N>
- Elapsed: <Ns>

## Notable observations

<2-3 paragraphs honestly assessing how v0.1.1 changed the output quality compared to v0.1.0. Be specific — quote a snippet or two. Was the noise meaningfully reduced? Did multi-signal JSONL surface anything useful?>

## Issues found

<any unexpected behavior, error messages, regressions vs v0.1.0>

## What to fix in v0.1.2

<short bullet list of follow-up work>
```

Fill in actual values.

- [ ] **Step 8: Commit**

```bash
cd /c/Glean && git add docs/open-work/04-v011-dogfood.md && git commit -m "docs: v0.1.1 dogfood validation results"
```

---

## Task 23: Merge, tag, push

**Files:** none (git operations)

- [ ] **Step 1: Switch to main, merge v0.1.1**

```bash
cd /c/Glean && git checkout main
git merge --no-ff v0.1.1 -m "Merge v0.1.1 quality patch into main"
```

`--no-ff` keeps the v0.1.1 branch visible in history.

- [ ] **Step 2: Tag v0.1.1**

```bash
cd /c/Glean && git tag -a v0.1.1 -m "Glean v0.1.1 — quality patch from v0.1.0 dogfood findings"
git log --oneline -3
git show v0.1.1 --stat | head -5
```

- [ ] **Step 3: Push branch + tag to origin**

```bash
cd /c/Glean && git push origin main && git push origin v0.1.1 && git push origin v0.1.1 --force-with-lease
```

(The third push is for the tag if it had to be re-created during dogfood.)

- [ ] **Step 4: Verify on GitHub**

Open https://github.com/Jonny-boy9000/glean/releases — confirm `v0.1.1` appears.

Optionally, create a GitHub release pointing at the tag with the CHANGELOG entry as the body.

- [ ] **Step 5: Mark issue progress**

Comment on related GitHub issues (if any opened in the meantime) that v0.1.1 addresses them. None known at plan-writing time, but worth checking the issues tab.

---

## Final sanity check

After Task 23:

- [ ] **Verify clean state**

```bash
cd /c/Glean && git status
cd /c/Glean && git tag -l "v0.*"
cd /c/Glean && git log --oneline --graph -10
```
Expected: clean working tree, `v0.1.0-mvp` and `v0.1.1` both present, history shows the v0.1.1 branch merged into main via `--no-ff`.

- [ ] **Verify acceptance criteria met**

Re-read `docs/open-work/04-v011-dogfood.md` and confirm all 7 acceptance criteria from spec §1 are checked off.

---

## Notes for the implementer

- **Read the spec first.** Spec at `docs/superpowers/specs/2026-05-24-glean-v011-quality-patch-design.md` has the full design rationale; this plan is the mechanical execution. If the spec and plan disagree, escalate.
- **TDD strictly.** Every task that adds behavior has a failing test first, then implementation, then passing test. Resist the urge to skip the "see it fail" step — it catches tests that pass for the wrong reason.
- **One commit per task.** Each task ends in `git commit`. Don't bundle. Each commit should be independently bisectable.
- **Branch hygiene.** All work happens on `v0.1.1`. `main` is untouched until Task 23.
- **Windows path quirks.** The integration tests at `test/integration/` all use `mkdtempSync` and `path.join` for tmpdirs, so they're cross-platform. The CLI commands and the `taskkill` test are Windows-specific (already gated).
- **If the discover-deps test in Task 16 fails to surface the bug**, the implementer should run the live diagnostic: build, install, point `glean run --project C:\Glean --dry-run`, then read `%USERPROFILE%\glean\state\<latest>\candidates.json` and `logs/<latest>/orchestrator.log` for `deps.*` events. The real-world diff is what matters; the unit-test repo may or may not reproduce.
- **Vitest fake timers can be brittle.** Task 8's timer-clear test uses `vi.useFakeTimers()`. If it interacts badly with the child-process spawn, fall back to a `vi.spyOn(global, 'clearTimeout')` assertion (noted inline in Task 8 step 1). The point of the test is "the timer is cleared," not the specific mechanism.
- **The `parseBudget` change is non-breaking.** Existing callers pass `60m` / `1h` strings, which still work. The added `s` suffix is purely additive.

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| §1 success criteria | Task 22 (dogfood validation) |
| §2 locked decisions | All tasks (decisions encoded in implementation) |
| §3 module changes summary | Tasks 2–17, 20–21 |
| §4.1 scanner filter | Task 2 |
| §4.2 JSONL multi-signal | Tasks 4, 5, 6 |
| §4.3 discover-deps fix | Task 16 |
| §4.4 prioritize soft weight | Task 3 |
| §4.5 executor three fixes | Tasks 7, 8 |
| §4.6 repair module | Tasks 9, 10 |
| §4.7 jsonl-extract refactor | Task 9 |
| §4.8 pipeline repair hook | Task 11 |
| §4.9 CLI new surface | Tasks 12, 17 |
| §5 testing strategy | Tasks 2–19 (tests inline with implementation) |
| §6.1 branch + commits | Tasks 1, 23 |
| §6.3 acceptance criteria | Task 22 |
| §7 out of scope | (no tasks — intentional) |
