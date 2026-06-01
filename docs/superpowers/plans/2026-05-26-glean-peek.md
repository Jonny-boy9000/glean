# `glean peek` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CWD-scoped `glean peek` CLI subcommand that walks up from the current directory to find the enclosing git repo, then prints just that project's today-dossier using the existing renderer. Silent exit (0) in every failure case. Pairs with a Claude Code `SessionStart` hook (user-installed manually) so dossiers auto-load into every new session. Ships as `v0.6.0`.

**Architecture:** New module `src/lib/peek.ts` walks up from `process.cwd()` for `.git`, slugs the repo root, calls existing `findTodayDossiers(gleanRoot)`, filters projects by slug. CLI subcommand wraps everything in a try/catch and exits 0 silent on any error. Small targeted refactor: extract `projectSlug` from inline copies in `pipeline.ts` + `executor.ts` to a single shared definition in `state.ts`.

**Tech Stack:** Node 20, TypeScript strict, ESM, vitest, citty (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-glean-peek-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\
    cli.ts                        MODIFY — add peekCmd + register (~25 LOC)
    lib\
      state.ts                    MODIFY — export projectSlug (~5 LOC)
      pipeline.ts                 MODIFY — remove inline projectSlug, import from state (~2 LOC delta)
      executor.ts                 MODIFY — same (~2 LOC delta)
      peek.ts                     NEW    — findGitRoot + findPeekDossier (~30 LOC)
      peek.test.ts                NEW    — 4 unit tests (~90 LOC)
  test\integration\
    v17-peek.test.ts              NEW    — 3 CLI tests (~80 LOC)
  README.md                       MODIFY — add SessionStart hook section (~10 LOC)
  package.json                    MODIFY — bump version to 0.6.0
  CHANGELOG.md                    MODIFY — v0.6.0 entry with hook config inline
  docs\ROADMAP.md                 MODIFY — move peek to Done, renumber Up next
```

---

## Task ordering

Branch (Task 1). Refactor `projectSlug` to state.ts FIRST (Task 2) so peek.ts can import from the same place. Then build peek.ts with TDD (Task 3). Wire the CLI (Task 4). Integration test (Task 5). Docs + version + ROADMAP (Task 6). Merge + tag (Task 7).

---

## Task 1: Create the v0.6.0 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, on `main`, HEAD at `714146b` (the peek spec commit) or later.

- [ ] **Step 2: Create branch**

```bash
cd /c/Glean && git checkout -b v0.6.0 && git branch --show-current
```
Expected: `v0.6.0`.

---

## Task 2: Extract `projectSlug` to `state.ts`

**Files:**
- Modify: `C:\Glean\src\lib\state.ts`
- Modify: `C:\Glean\src\lib\pipeline.ts`
- Modify: `C:\Glean\src\lib\executor.ts`

Pure refactor — no behavior change. Both inline copies are byte-identical (verified): `basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-')`.

### Step 1: Add the export to `state.ts`

Open `C:\Glean\src\lib\state.ts`. At the top, the existing imports include `join` from `node:path`. Add `basename` to that import:

```ts
import { join, basename } from 'node:path';
```

Then add this exported function anywhere in the file (good place: right after `gleanRoot()` for thematic grouping):

```ts
export function projectSlug(projectPath: string): string {
  return basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
```

### Step 2: Remove the inline copy in `pipeline.ts` and import

In `C:\Glean\src\lib\pipeline.ts`:

(a) Find the existing import from `./state.js`. Add `projectSlug` to the import list. The current import looks like:

```ts
import { acquireLock, releaseLock, isStopRequested, writeSummary, writeCandidatesJson, appendOrchestratorLog, ensureTemplatesDir } from './state.js';
```

Change to:

```ts
import { acquireLock, releaseLock, isStopRequested, writeSummary, writeCandidatesJson, appendOrchestratorLog, ensureTemplatesDir, projectSlug } from './state.js';
```

(b) Delete the inline `projectSlug` function at the bottom of `pipeline.ts` (currently around line 229):

```ts
function projectSlug(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
```

Just remove these 3 lines (plus the blank line above if there is one).

(c) Check if `basename` is still needed in `pipeline.ts` after removing the function. Run:

```bash
cd /c/Glean && grep -n 'basename' src/lib/pipeline.ts
```

If `basename` no longer appears anywhere in pipeline.ts, also remove it from the `node:path` import at the top. If it's still used somewhere else (it currently is — there's a `basename` call in `today()` helper area, let the grep tell you), leave the import as-is.

### Step 3: Remove the inline copy in `executor.ts` and import

In `C:\Glean\src\lib\executor.ts`:

(a) Add `projectSlug` to the existing `./state.js` import. If there's no current import from `./state.js`, add one:

```ts
import { projectSlug } from './state.js';
```

(Most likely there's no existing import — executor.ts uses lower-level primitives. Add a fresh import line.)

(b) Delete the inline `projectSlug` function at the bottom of `executor.ts` (currently around line 195):

```ts
function projectSlug(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
```

(c) Same `basename` check as for pipeline.ts:

```bash
cd /c/Glean && grep -n 'basename' src/lib/executor.ts
```

If unused, remove from the import.

### Step 4: Verify no regressions

```bash
cd /c/Glean && npm run build && npm test && npx tsc --noEmit && npm run lint
```
Expected: all four exit 0. Test count: 136 passing + 1 skipped (no test changes; pure refactor).

If `npm test` fails because some test imported the private inline `projectSlug` directly (extremely unlikely — it was a `function`, not `export function`), fix by updating that import. If `npx tsc --noEmit` complains about a missing `basename` import somewhere, restore it where needed.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/state.ts src/lib/pipeline.ts src/lib/executor.ts && git commit -m "refactor(state): extract projectSlug to a shared export

Both pipeline.ts and executor.ts had byte-identical inline copies.
peek (next task) needs the same. One shared definition in state.ts
replaces both.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `findGitRoot` + `findPeekDossier` (TDD)

**Files:**
- Create: `C:\Glean\src\lib\peek.ts`
- Create: `C:\Glean\src\lib\peek.test.ts`

### Step 1: Write the failing tests

Create `C:\Glean\src\lib\peek.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from './memory.js';
import { findGitRoot, findPeekDossier } from './peek.js';

describe('findGitRoot', () => {
  it('walks up and finds .git in an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-git-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  it('returns null when no .git is found walking up to filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBeNull();
  });
});

describe('findPeekDossier', () => {
  function writeIndex(gleanRoot: string, slug: string, date: string, entries: Array<{ task_id: string; title: string; status: string; output: string; type: string }>): void {
    const dir = join(gleanRoot, 'dossiers', slug, date);
    mkdirSync(dir, { recursive: true });
    const yaml = [
      '---',
      'run_id: r-1',
      `project_path: C:\\${slug}`,
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      ...entries.flatMap((e) => [
        `  - task_id: "${e.task_id}"`,
        `    title: "${e.title}"`,
        `    status: ${e.status}`,
        `    output: "${e.output}"`,
        `    type: ${e.type}`,
      ]),
      '---',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'INDEX.md'), yaml);
  }

  function todayDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it('returns the matching project filtered when cwd is inside a git repo with a dossier', () => {
    // Create a repo named "myproj" with .git
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos-'));
    const repoRoot = join(reposParent, 'myproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    // Create gleanRoot with a dossier for slug 'myproj'
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root-'));
    writeIndex(gleanRoot, 'myproj', todayDate(), [
      { task_id: 'task-1', title: 'Handle TODO', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);

    const report = findPeekDossier(gleanRoot, repoRoot);
    expect(report).not.toBeNull();
    expect(report!.projects).toHaveLength(1);
    expect(report!.projects[0].project_slug).toBe('myproj');
    expect(report!.projects[0].entries[0].title).toBe('Handle TODO');
  });

  it('returns null when cwd has no .git OR when no matching dossier exists', () => {
    // Sub-case A: no .git anywhere up
    const noGitDir = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-cwd-'));
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root2-'));
    expect(findPeekDossier(gleanRoot, noGitDir)).toBeNull();

    // Sub-case B: .git exists but no dossier for this repo's slug
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos2-'));
    const repoRoot = join(reposParent, 'otherproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    // Seed a dossier for a DIFFERENT slug
    writeIndex(gleanRoot, 'unrelated', todayDate(), [
      { task_id: 'task-1', title: 'Other', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);
    expect(findPeekDossier(gleanRoot, repoRoot)).toBeNull();
  });
});
```

Note: the third test calls `Memory` import indirectly via `findTodayDossiers` (which internally tries to open memory.db if it exists). Since no memory.db is created in these test fixtures, `findTodayDossiers` falls through its `existsSync` check silently — no enrichment, no errors.

### Step 2: Run the tests to verify they fail

Run: `cd /c/Glean && npx vitest run src/lib/peek.test.ts`
Expected: FAIL — "Cannot find module './peek.js'".

### Step 3: Implement `peek.ts`

Create `C:\Glean\src\lib\peek.ts`:

```ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findTodayDossiers, type TodayReport } from './today.js';
import { projectSlug } from './state.js';

export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;  // reached filesystem root
    dir = parent;
  }
}

export function findPeekDossier(gleanRoot: string, cwd: string): TodayReport | null {
  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) return null;
  const slug = projectSlug(repoRoot);
  const all = findTodayDossiers(gleanRoot);
  const filtered = all.projects.filter((p) => p.project_slug === slug);
  if (filtered.length === 0) return null;
  return { date: all.date, projects: filtered };
}
```

`findGitRoot` walks up using `dirname(dir)` until either `.git` is found via `existsSync` (works for both `.git` directories and submodule `.git` files), or `dirname` returns the same path it was given (filesystem root reached).

### Step 4: Run the tests + types + full suite

```bash
cd /c/Glean && npx vitest run src/lib/peek.test.ts && npm test && npx tsc --noEmit && npm run lint
```
Expected: 4 peek tests pass. Full suite: 140 passing + 1 skipped (136 baseline + 4 new). TS + lint clean.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/peek.ts src/lib/peek.test.ts && git commit -m "feat(peek): findGitRoot and findPeekDossier for CWD-scoped lookup

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Wire `peekCmd` in `cli.ts`

**Files:**
- Modify: `C:\Glean\src\cli.ts`

No new unit test — the integration test in Task 5 covers wiring.

### Step 1: Add the import

Open `C:\Glean\src\cli.ts`. Find the existing imports from `./lib/`. Add:

```ts
import { findPeekDossier } from './lib/peek.js';
```

The other needed pieces (`renderToday`, `gleanRoot`) should already be imported from earlier subcommand work. If `renderToday` isn't imported (it was added in v0.2.1), add:

```ts
import { renderToday } from './lib/render-today.js';
```

(Inspect the existing import block before duplicating.)

### Step 2: Define `peekCmd`

Add the following `defineCommand` block after the existing `rateCmd` (or wherever the most recently-added subcommand sits), and BEFORE the `root` command definition:

```ts
const peekCmd = defineCommand({
  meta: {
    name: 'peek',
    description: 'Print the current repo\'s today-dossier (CWD-scoped variant of `glean today`). Silent when nothing applies. Designed for SessionStart hook use.',
  },
  async run() {
    try {
      const report = findPeekDossier(gleanRoot(), process.cwd());
      if (report === null) return;  // exit 0, no output
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderToday(report, useColor) + '\n');
    } catch {
      // Silent: exit 0 no matter what. Hook commands must never break a session.
    }
  },
});
```

The outer try/catch is the failsafe. The contract is `glean peek` exits 0 with empty stdout in every conceivable failure mode.

### Step 3: Register `peekCmd` on the root command

Find the existing `root` defineCommand. It currently looks like:

```ts
const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd },
});
```

Add `peek: peekCmd` to the map:

```ts
const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd, peek: peekCmd },
});
```

### Step 4: Build + smoke test

```bash
cd /c/Glean && npm run build
```
Expected: clean tsc output.

```bash
cd /c/Glean && node bin/glean.js peek
```
Expected behavior depends on your CWD:
- If `C:\Glean` IS itself a git repo (it is) AND there's a today-dossier for slug `glean` in `%USERPROFILE%\glean\dossiers\glean\<today>\INDEX.md`: peek prints the dossier.
- Otherwise: peek prints nothing, exits 0.

Both outcomes are correct; don't expect any specific output. The only failure case is the command crashing or printing an error — that would mean the try/catch didn't catch something.

Test the silent-on-error path explicitly:

```bash
cd /tmp && node /c/Glean/bin/glean.js peek
```

(Or use any non-repo directory.) Expected: empty stdout, exit 0.

### Step 5: Run full test suite

```bash
cd /c/Glean && npm test && npx tsc --noEmit && npm run lint
```
Expected: 140 passing + 1 skipped (no new tests in this task). TS + lint clean.

### Step 6: Commit

```bash
cd /c/Glean && git add src/cli.ts && git commit -m "feat(cli): add 'glean peek' subcommand

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: v17 integration test

**Files:**
- Create: `C:\Glean\test\integration\v17-peek.test.ts`

### Step 1: Write the test

Create `C:\Glean\test\integration\v17-peek.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function todayDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('verification 17: glean peek CLI', () => {
  it('prints the matching project dossier when run inside a repo with one', () => {
    // Set up a fake home with a dossier for slug 'demorepo'
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-'));
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dossierDir = join(home, 'glean', 'dossiers', 'demorepo', todayDate());
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: r-v17',
      'project_path: C:\\demorepo',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - task_id: "task-v17"',
      '    title: "Peek test entry"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    // Set up a fake repo named 'demorepo' with .git
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-v17-repos-'));
    const repoRoot = join(reposParent, 'demorepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('demorepo');
    expect(res.stdout).toContain('Peek test entry');
  });

  it('prints empty stdout when cwd has no .git anywhere up', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-nogit-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const nonRepo = mkdtempSync(join(tmpdir(), 'glean-v17-nonrepo-'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: nonRepo,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('prints empty stdout when in a git repo with no matching dossier', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-nodossier-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const reposParent = mkdtempSync(join(tmpdir(), 'glean-v17-repos-'));
    const repoRoot = join(reposParent, 'demorepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});
```

Note: each `spawnSync` call passes an explicit `cwd:` argument. The peek subcommand reads `process.cwd()` of the spawned process, which will be the value of this option.

### Step 2: Run the tests

```bash
cd /c/Glean && npx vitest run test/integration/v17-peek.test.ts
```
Expected: 3 passed.

```bash
cd /c/Glean && npm test && npx tsc --noEmit && npm run lint
```
Expected: 143 passing + 1 skipped (140 + 3 new). TS + lint clean.

### Step 3: Commit

```bash
cd /c/Glean && git add test/integration/v17-peek.test.ts && git commit -m "test(peek): end-to-end CLI integration tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Version + CHANGELOG + README + ROADMAP

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\CHANGELOG.md`
- Modify: `C:\Glean\README.md`
- Modify: `C:\Glean\docs\ROADMAP.md`

### Step 1: Bump the version

Edit `C:\Glean\package.json`. Change:
```json
  "version": "0.5.0",
```
to:
```json
  "version": "0.6.0",
```

### Step 2: Add the CHANGELOG entry

Open `C:\Glean\CHANGELOG.md`. The file currently starts with:

```markdown
# Changelog

## v0.5.0 — 2026-05-26
```

Insert a new v0.6.0 section between `# Changelog` and the existing `## v0.5.0` section:

```markdown
## v0.6.0 — 2026-05-26

`glean peek` subcommand plus a SessionStart hook recipe — closes the compound-memory-across-sessions loop.

### Added
- `glean peek` subcommand. CWD-scoped variant of `glean today`. Walks up from the current directory to find the enclosing git repo, slugs the root, and prints just that project's today-dossier using the existing renderer. Silent exit (0) when nothing applies — no `.git`, no matching dossier, any error: all degrade to empty stdout + exit 0.
- New module `src/lib/peek.ts` exporting `findGitRoot(start)` and `findPeekDossier(gleanRoot, cwd)`.
- `projectSlug` helper extracted from inline copies in `pipeline.ts` and `executor.ts` to a single shared export in `src/lib/state.ts`. No behavior change.

### SessionStart hook recipe
Add this to `~/.claude/settings.json` (or merge into your existing `hooks` object):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "glean peek" }
        ]
      }
    ]
  }
}
```

Whenever you start a new Claude Code session inside a repo with a recent dossier, the hook runs `glean peek` and the dossier lands in the session's initial context. No dossier = empty output = no injection.

### Why
v0.5.0 made telemetry visible via `glean today`. v0.6.0 closes the dossier-as-compound-memory loop: every new Claude session in a repo with a recent dossier starts pre-loaded with that context. The user no longer has to remember to `cat` an INDEX file.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. No schema change, no engine change. The `projectSlug` refactor is behaviorally identical (both inline copies were byte-identical). Peek's exit-0-silent contract is unconditional — any error in walk-up, scan, or render produces empty stdout, never a hook failure.

### Tests
- Suite: 136 + 1 skip → 143 + 1 skip.
- 4 new tests in `src/lib/peek.test.ts` (findGitRoot walk-up × 2, findPeekDossier match + no-match).
- 3 new tests in `test/integration/v17-peek.test.ts` (in-repo with dossier, no .git, no matching dossier).
```

### Step 3: Add the SessionStart hook section to README

Open `C:\Glean\README.md`. Find a natural place to add a new subsection — probably under an existing "Usage" or "Integrations" header, or as a new section near the existing CLI documentation. Add the following (adjust placement to fit the README's existing structure):

```markdown
## Auto-load dossiers into Claude sessions

`glean peek` is a CWD-scoped variant of `glean today` designed for use as a SessionStart hook. When you start a Claude Code session inside a repo that has a recent glean dossier, the hook auto-loads the dossier into the session's context.

Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "glean peek" }
        ]
      }
    ]
  }
}
```

`glean peek` exits silently when there's nothing to show (no git repo, no dossier for today, any error) so it never breaks a session.
```

If the README has no `## Usage` or similar structure, add this as a top-level section near the install instructions. The implementer should pick a sensible spot.

### Step 4: Update ROADMAP.md

Open `C:\Glean\docs\ROADMAP.md`.

(a) Update the header:
```markdown
**Last updated:** 2026-05-26 (post-v0.6.0; `glean peek` + SessionStart hook shipped)
**Current release:** [v0.6.0](https://github.com/Jonny-boy9000/glean/releases/tag/v0.6.0) (commit `<TBD>`)
```
(Commit SHA filled in Task 7. Leave `<TBD>` for now.)

(b) Remove the `### 1. \`glean peek\` + SessionStart hook integration` section from **Up next**. Renumber the remaining item:

- `### 1. API-key fallback when Pro/Max rate-limits` (was #2)

(c) Update the "Strategic lens" preamble. Find the current paragraph and adjust the middle sentences. Current says something like "Item 1 is now the highest-leverage forward-momentum item (compound memory across sessions). Item 2 is engine durability." Replace with:

```markdown
> **Strategic lens (2026-05-26):** The most load-bearing critique of the project is that the engine has no measure of dossier usefulness — you don't know if you'd open what it produces. Both halves of the telemetry pair shipped (v0.3.0 passive sweep + v0.4.0 `glean rate` active ratings), v0.5.0 surfaces both back in `glean today`, and v0.6.0 closes the compound-memory-across-sessions loop via `glean peek` + SessionStart hook. Item 1 (now the only Up next item) is engine durability via API-key fallback. Distribution / adoption items (POSIX port, npm publish, GitHub issues, demo media) consciously deferred until telemetry validates that the core is worth distributing.
```

(d) Update the "Distribution prep" deferred note. Find the line: `Deliberately deferred 2026-05-26 in favor of usefulness telemetry (the v0.3.0 sweep + v0.4.0 ratings + v0.5.0 surfacing — all shipped).` Change to:

`Deliberately deferred 2026-05-26 in favor of usefulness telemetry and compound-memory loop (the v0.3.0 sweep + v0.4.0 ratings + v0.5.0 surfacing + v0.6.0 peek — all shipped). Revisit once telemetry shows dossiers are being kept/actioned more often than discarded.`

(e) Add a new entry to the **Done** section. Insert before the `v0.5.0` entry:

```markdown
- **v0.6.0** (2026-05-26, tag `v0.6.0`) — `glean peek` subcommand + SessionStart hook recipe. CWD-scoped variant of `glean today` designed for hook use: walks up for `.git`, prints the matching project's today-dossier, exits 0 silent in every failure case. Closes the compound-memory-across-sessions loop. See [v0.6.0 spec](./superpowers/specs/2026-05-26-glean-peek-design.md), [v0.6.0 plan](./superpowers/plans/2026-05-26-glean-peek.md).
- **v0.5.0** (2026-05-26, tag `v0.5.0`) — `glean today` enriched with memory.db. ...
```

### Step 5: Final verification

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all three exit 0. Test count: 143 passing + 1 skipped.

### Step 6: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md README.md docs/ROADMAP.md && git commit -m "chore: bump to v0.6.0 + CHANGELOG + README hook recipe + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.6.0 -m "Merge v0.6.0 glean peek into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.6.0 -m "v0.6.0 — glean peek + SessionStart hook"
```

### Step 3: Update ROADMAP commit SHA

Get the merge SHA:
```bash
cd /c/Glean && git log --oneline -1 main
```

Edit `C:\Glean\docs\ROADMAP.md` — find the header line containing `<TBD>` and replace it with the actual 7-char SHA prefix.

Commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.6.0 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 4: Verify final state

```bash
cd /c/Glean && git log --oneline -8 && git tag -l 'v0.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.1.0-mvp` through `v0.6.0` tags all present, `"version": "0.6.0"`.

### Step 5: Do NOT push without user approval

Per `CLAUDE.md`, do not push until explicitly told. When approved:
```bash
cd /c/Glean && git push origin main --follow-tags
```

---

## Done-when checklist (mirrors spec §1)

- [x] `src/lib/peek.ts` exports `findGitRoot` + `findPeekDossier`. (Task 3)
- [x] `findGitRoot` walks up via `dirname()` until `.git` is found or filesystem root reached. (Task 3)
- [x] `projectSlug` extracted to `state.ts`; pipeline.ts + executor.ts updated to import from there. (Task 2)
- [x] `peekCmd` in cli.ts reads `process.cwd()`, calls `findPeekDossier`, renders via `renderToday`. Outer try/catch ensures exit 0 silent on any error. (Task 4)
- [x] 4 peek unit tests + 3 v17 integration tests. (Tasks 3 + 5)
- [x] README + CHANGELOG document the SessionStart hook config. (Task 6)
- [x] `npm test`, `npm run build`, `npm run lint` exit 0. (Task 6 verifies)
- [x] ROADMAP moves peek to Done; Up next renumbered (API-key fallback → #1). (Task 6 + Task 7)
