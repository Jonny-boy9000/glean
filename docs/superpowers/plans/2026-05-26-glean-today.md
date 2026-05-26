# `glean today` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `glean today` CLI subcommand that scans `~/glean/dossiers/*/<today>/INDEX.md`, parses each YAML frontmatter, and prints a grouped report to the terminal. Ships as `v0.2.1`.

**Architecture:** Two new pure modules — `src/lib/today.ts` (scanner: globs INDEX files, parses frontmatter, returns structured `TodayReport`) and `src/lib/render-today.ts` (formatter: takes the report + a `useColor` bool, returns the string to print). A new citty subcommand in `src/cli.ts` wires them together. Splitting scan from render isolates testable units. No engine changes, no `memory.db` reads, no external integrations.

**Tech Stack:** Node 20, TypeScript strict, ESM, vitest, citty (existing), `yaml` (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-25-glean-today-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\
    cli.ts                        MODIFY — add `today` subcommand + register
    lib\
      today.ts                    NEW    — findTodayDossiers + types (~40 LOC)
      today.test.ts               NEW    — scanner unit tests (~4 tests)
      render-today.ts             NEW    — renderToday + ANSI helpers (~50 LOC)
      render-today.test.ts        NEW    — formatter unit tests (~4 tests)
  test\integration\
    v15-today.test.ts             NEW    — end-to-end CLI smoke (1 test)
  package.json                    MODIFY — bump version to 0.2.1
  CHANGELOG.md                    MODIFY — v0.2.1 entry
  docs\ROADMAP.md                 MODIFY — note terminal slice shipped
```

---

## Task ordering

Branch (Task 1). Build the scanner with TDD (Task 2). Build the renderer with TDD (Task 3) — these are independent and either order works, but scanner first matches the data-flow direction. Wire the CLI (Task 4) once both modules exist. Add the integration smoke (Task 5). Release bookkeeping (Task 6). Merge + tag (Task 7).

---

## Task 1: Create the v0.2.1 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, on `main`, HEAD at `cb41d0a` (the glean-today spec commit) or later.

- [ ] **Step 2: Create branch**

```bash
cd /c/Glean && git checkout -b v0.2.1 && git branch --show-current
```
Expected: `v0.2.1`.

---

## Task 2: `findTodayDossiers` scanner (TDD)

**Files:**
- Create: `C:\Glean\src\lib\today.ts`
- Create: `C:\Glean\src\lib\today.test.ts`

### Step 1: Write the failing tests

Create `C:\Glean\src\lib\today.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTodayDossiers } from './today.js';

function makeIndex(root: string, slug: string, date: string, entries: Array<{ title: string; status: string; output: string; type: string }>, projectPath?: string): void {
  const dir = join(root, 'dossiers', slug, date);
  mkdirSync(dir, { recursive: true });
  const frontmatter = {
    run_id: 'run-x',
    project_path: projectPath ?? `C:\\projects\\${slug}`,
    generated_at: '2026-05-26T10:00:00.000Z',
    entries,
  };
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => k === 'entries'
      ? `entries:\n${(v as typeof entries).map((e) => `  - title: ${JSON.stringify(e.title)}\n    status: ${e.status}\n    output: ${JSON.stringify(e.output)}\n    type: ${e.type}`).join('\n')}`
      : `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(join(dir, 'INDEX.md'), `---\n${yaml}\n---\n\n# body ignored\n`);
}

describe('findTodayDossiers', () => {
  it('returns empty when dossiers directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-empty-'));
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r).toEqual({ date: '2026-05-26', projects: [] });
  });

  it('returns one project group when one INDEX exists for the target date', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-1-'));
    makeIndex(root, 'foo', '2026-05-26', [
      { title: 'Handle TODO in src/a.ts', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
      { title: 'Pre-fetch docs for lodash', status: 'ok', output: 'lodash.md', type: 'fetch-docs' },
    ]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.date).toBe('2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].project_slug).toBe('foo');
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].title).toBe('Handle TODO in src/a.ts');
    expect(r.projects[0].entries[0].status).toBe('ok');
  });

  it('filters to the target date and sorts projects alphabetically', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-multi-'));
    makeIndex(root, 'zebra', '2026-05-26', [{ title: 't1', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    makeIndex(root, 'alpha', '2026-05-26', [{ title: 't2', status: 'failed', output: '', type: 'research-dossier' }]);
    makeIndex(root, 'beta', '2026-05-25', [{ title: 'yesterday', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['alpha', 'zebra']);
  });

  it('skips a project with corrupt frontmatter without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-corrupt-'));
    const dir = join(root, 'dossiers', 'broken', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), 'no frontmatter here, just text\n');
    makeIndex(root, 'good', '2026-05-26', [{ title: 't', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['good']);
  });
});
```

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/today.test.ts
```
Expected: FAIL with "Cannot find module './today.js'".

### Step 3: Implement `today.ts`

Create `C:\Glean\src\lib\today.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type IndexEntryStatus =
  | 'ok'
  | 'ok-fallback'
  | 'failed'
  | 'timeout'
  | 'rate-limit';

export type IndexEntry = {
  title: string;
  status: IndexEntryStatus;
  output: string;
  type: 'research-dossier' | 'fetch-docs';
};

export type ProjectGroup = {
  project_slug: string;
  project_path?: string;
  entries: IndexEntry[];
};

export type TodayReport = {
  date: string;
  projects: ProjectGroup[];
};

export function findTodayDossiers(gleanRoot: string, date?: string): TodayReport {
  const targetDate = date ?? localDateString(new Date());
  const dossiersDir = join(gleanRoot, 'dossiers');
  if (!existsSync(dossiersDir)) return { date: targetDate, projects: [] };

  const slugs = safeReaddir(dossiersDir).sort();
  const projects: ProjectGroup[] = [];

  for (const slug of slugs) {
    const projPath = join(dossiersDir, slug);
    try { if (!statSync(projPath).isDirectory()) continue; } catch { continue; }
    const indexPath = join(projPath, targetDate, 'INDEX.md');
    if (!existsSync(indexPath)) continue;
    const parsed = parseIndex(indexPath);
    if (!parsed) continue;
    projects.push({
      project_slug: slug,
      project_path: parsed.project_path,
      entries: parsed.entries,
    });
  }

  return { date: targetDate, projects };
}

function parseIndex(path: string): { project_path?: string; entries: IndexEntry[] } | null {
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch { return null; }
  const m = content.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  let fm: { project_path?: string; entries?: unknown[] };
  try { fm = parseYaml(m[1]) as typeof fm; } catch { return null; }
  if (!fm || !Array.isArray(fm.entries)) return null;
  const entries: IndexEntry[] = [];
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
  return { project_path: fm.project_path, entries };
}

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
```

### Step 4: Run the tests to verify they pass

Run:
```bash
cd /c/Glean && npx vitest run src/lib/today.test.ts
```
Expected: 4 passed.

Also run `npx tsc --noEmit` to confirm no type errors:
```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no output.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/today.ts src/lib/today.test.ts && git commit -m "feat(today): findTodayDossiers scanner

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `renderToday` formatter (TDD)

**Files:**
- Create: `C:\Glean\src\lib\render-today.ts`
- Create: `C:\Glean\src\lib\render-today.test.ts`

### Step 1: Write the failing tests

Create `C:\Glean\src\lib\render-today.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderToday } from './render-today.js';
import type { TodayReport } from './today.js';

describe('renderToday', () => {
  it('renders the empty-case message when no projects', () => {
    const r: TodayReport = { date: '2026-05-26', projects: [] };
    expect(renderToday(r, false)).toBe('No glean dossiers for 2026-05-26.');
  });

  it('renders a single project plain (no ANSI codes)', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        project_path: 'C:\\Glean',
        entries: [
          { title: 'Handle TODO in src/a.ts', status: 'ok', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\research-handle-todo-a-L1\\OUT.md', type: 'research-dossier' },
          { title: 'Pre-fetch docs for lodash', status: 'ok-fallback', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\docs\\lodash.md', type: 'fetch-docs' },
          { title: 'Bad task', status: 'failed', output: '', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, false);
    expect(s).not.toMatch(/\x1b\[/); // no ANSI escapes
    expect(s).toContain('GLEAN today — 2026-05-26');
    expect(s).toContain('▸ glean');
    expect(s).toContain('3 tasks');
    expect(s).toContain('✓ ok');
    expect(s).toContain('✓ ok-fallback');
    expect(s).toContain('✗ failed');
    expect(s).toContain('Handle TODO in src/a.ts');
    expect(s).toContain('(no output)');
  });

  it('renders with ANSI color codes when useColor is true', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'foo',
        entries: [
          { title: 'ok task', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
          { title: 'bad task', status: 'failed', output: '', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, true);
    expect(s).toMatch(/\x1b\[1m/); // bold (header + project line)
    expect(s).toMatch(/\x1b\[32m/); // green for ok
    expect(s).toMatch(/\x1b\[31m/); // red for failed
    expect(s).toMatch(/\x1b\[2m/);  // dim for paths
  });

  it('replaces gleanRoot prefix with ~/glean in output paths', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [
          { title: 't', status: 'ok', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\x\\OUT.md', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('~/glean/dossiers/glean/2026-05-26/x/OUT.md');
    expect(s).not.toContain('C:\\Users\\u\\glean\\dossiers');
  });
});
```

### Step 2: Run the tests to verify they fail

Run:
```bash
cd /c/Glean && npx vitest run src/lib/render-today.test.ts
```
Expected: FAIL with "Cannot find module './render-today.js'".

### Step 3: Implement `render-today.ts`

Create `C:\Glean\src\lib\render-today.ts`:

```ts
import type { TodayReport, IndexEntry } from './today.js';

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

const PROJECT_LINE_WIDTH = 60;
const STATUS_COLUMN_WIDTH = 12;

export function renderToday(report: TodayReport, useColor: boolean): string {
  if (report.projects.length === 0) {
    return `No glean dossiers for ${report.date}.`;
  }
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];
  lines.push(c.bold(`GLEAN today — ${report.date}`));
  lines.push('');

  for (let pi = 0; pi < report.projects.length; pi++) {
    const p = report.projects[pi];
    const taskCount = `${p.entries.length} tasks`;
    const left = `▸ ${p.project_slug}`;
    const padding = Math.max(2, PROJECT_LINE_WIDTH - left.length - taskCount.length);
    lines.push(c.bold(`${left}${' '.repeat(padding)}${taskCount}`));

    for (const e of p.entries) {
      const isOk = e.status === 'ok' || e.status === 'ok-fallback';
      const icon = isOk ? c.green('✓') : c.red('✗');
      const status = isOk ? c.green(e.status.padEnd(STATUS_COLUMN_WIDTH)) : c.red(e.status.padEnd(STATUS_COLUMN_WIDTH));
      lines.push(`  ${icon} ${status} ${e.title}`);
      const outputDisplay = e.output ? normalizePath(e.output) : '(no output)';
      lines.push(`                 ${c.dim(outputDisplay)}`);
    }

    if (pi < report.projects.length - 1) lines.push('');
  }

  return lines.join('\n');
}

function normalizePath(p: string): string {
  // Find ".../glean/dossiers/..." and replace the prefix up through "glean" with "~/glean".
  // Also normalize backslashes to forward slashes for display.
  const m = p.match(/^(.*?[/\\])glean[/\\]dossiers[/\\](.*)$/);
  if (m) {
    return `~/glean/dossiers/${m[2].replace(/\\/g, '/')}`;
  }
  return p.replace(/\\/g, '/');
}
```

### Step 4: Run the tests to verify they pass

Run:
```bash
cd /c/Glean && npx vitest run src/lib/render-today.test.ts
```
Expected: 4 passed.

Also confirm types:
```bash
cd /c/Glean && npx tsc --noEmit
```
Expected: no output.

### Step 5: Commit

```bash
cd /c/Glean && git add src/lib/render-today.ts src/lib/render-today.test.ts && git commit -m "feat(today): renderToday formatter with ANSI color toggle

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Wire the `today` subcommand in `cli.ts`

**Files:**
- Modify: `C:\Glean\src\cli.ts`

This task has no new unit test — the integration test in Task 5 covers the wiring. The CLI wiring itself is mechanical glue.

### Step 1: Add imports to `cli.ts`

Open `C:\Glean\src\cli.ts`. Find the existing import block at the top. Add two new imports near `import { runPipeline } from './lib/pipeline.js';`:

```ts
import { findTodayDossiers } from './lib/today.js';
import { renderToday } from './lib/render-today.js';
```

### Step 2: Define the `today` subcommand

Add the following `defineCommand` block after the existing `repairCmd` definition (around line 82 in the current file) and before the `root` command definition:

```ts
const todayCmd = defineCommand({
  meta: { name: 'today', description: 'Show today\'s glean dossiers across all projects' },
  async run() {
    const report = findTodayDossiers(gleanRoot());
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(renderToday(report, useColor) + '\n');
  },
});
```

### Step 3: Register `todayCmd` on the root command

Find the existing `root` defineCommand:

```ts
const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd },
});
```

Change to:

```ts
const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd },
});
```

### Step 4: Build and smoke-test the CLI

Run:
```bash
cd /c/Glean && npm run build
```
Expected: clean tsc output, no errors.

Run a manual smoke test (the actual integration assertion lands in Task 5; this just confirms the command runs at all):

```bash
cd /c/Glean && node bin/glean.js today
```
Expected: either prints a real `GLEAN today — <date>` block (if there are dossiers in `%USERPROFILE%\glean\dossiers\`) OR prints `No glean dossiers for <date>.` and exits 0. Either is correct.

If the command crashes, do NOT proceed — fix it. Most likely cause: an import path typo or missing `findTodayDossiers` / `renderToday` export.

### Step 5: Run the full test suite to confirm no regression

```bash
cd /c/Glean && npm test
```
Expected: previous 95 passing tests still pass; the 8 new tests from Tasks 2–3 also pass. Total: 103 passing + 1 skipped (`npm test` count varies; the key check is zero failures).

### Step 6: Commit

```bash
cd /c/Glean && git add src/cli.ts && git commit -m "feat(cli): add 'glean today' subcommand

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: End-to-end integration test

**Files:**
- Create: `C:\Glean\test\integration\v15-today.test.ts`

### Step 1: Write the test

Create `C:\Glean\test\integration\v15-today.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 15: glean today CLI', () => {
  it('prints a grouped report when dossiers exist for today', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-home-'));
    const today = localDateString(new Date());
    const dossierDir = join(home, 'glean', 'dossiers', 'demoproj', today);
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\demoproj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - title: "Handle TODO in src/a.ts"',
      '    status: ok',
      '    output: "C:\\\\Users\\\\u\\\\glean\\\\dossiers\\\\demoproj\\\\' + today + '\\\\x\\\\OUT.md"',
      '    type: research-dossier',
      '---',
      '',
      '# body ignored',
      '',
    ].join('\n'));

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`GLEAN today — ${today}`);
    expect(res.stdout).toContain('▸ demoproj');
    expect(res.stdout).toContain('1 tasks');
    expect(res.stdout).toContain('Handle TODO in src/a.ts');
    expect(res.stdout).toContain('ok');
  });

  it('prints the empty-case message when no dossiers exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-empty-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const today = localDateString(new Date());
    expect(res.stdout).toContain(`No glean dossiers for ${today}.`);
  });
});

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
```

### Step 2: Run the integration test

Run:
```bash
cd /c/Glean && npx vitest run test/integration/v15-today.test.ts
```
Expected: 2 passed.

### Step 3: Run the full suite

```bash
cd /c/Glean && npm test
```
Expected: ~105 passing + 1 skipped. Zero failures.

Also confirm build + lint:
```bash
cd /c/Glean && npm run build && npm run lint
```
Expected: both exit 0.

### Step 4: Commit

```bash
cd /c/Glean && git add test/integration/v15-today.test.ts && git commit -m "test(today): end-to-end CLI integration test

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
  "version": "0.2.0",
```
to:
```json
  "version": "0.2.1",
```

### Step 2: Add the CHANGELOG entry

Open `C:\Glean\CHANGELOG.md`. The file currently starts with:

```markdown
# Changelog

## v0.2.0 — 2026-05-25
```

Insert a new v0.2.1 section between `# Changelog` and `## v0.2.0`:

```markdown
## v0.2.1 — 2026-05-26

Read-only terminal view for daily dossiers.

### Added
- `glean today` subcommand. Scans `~/glean/dossiers/*/<today>/INDEX.md` across all projects, parses each YAML frontmatter, and prints a grouped report to stdout. ANSI-colored when interactive (`process.stdout.isTTY`), plain when piped or redirected. No flags in this release.
- New modules `src/lib/today.ts` (scanner — returns a structured `TodayReport`) and `src/lib/render-today.ts` (formatter — takes report + `useColor`, returns the string to print). Pure, side-effect-free, fully unit-tested.

### Why
The previous consumption surface was "open `~/glean/dossiers/<project>/<date>/INDEX.md` in an editor." `glean today` collapses that to a single command. This is the terminal slice of the broader "Output adapters" Tracked item; the Notion / Slack / email mirrors remain deferred.

### Compatibility
Non-breaking. Same CLI surface plus one new subcommand. No engine changes — `pipeline.ts`, `executor.ts`, discovery modules, and `memory.db` are untouched. Empty-case (`No glean dossiers for <date>.`) exits 0.

### Tests
- Suite: 95 + 1 skip → ~105 + 1 skip.
- 4 new scanner unit tests in `src/lib/today.test.ts`.
- 4 new formatter unit tests in `src/lib/render-today.test.ts`.
- 2 new CLI integration tests in `test/integration/v15-today.test.ts`.

```

### Step 3: Update ROADMAP.md

Open `C:\Glean\docs\ROADMAP.md`.

(a) Update the header:
```markdown
**Last updated:** 2026-05-26 (post-v0.2.1; glean today shipped)
**Current release:** [v0.2.1](https://github.com/Jonny-boy9000/glean/releases/tag/v0.2.1) (commit `<TBD>`)
```
(The commit SHA will be filled in after merge in Task 7. Leave `<TBD>` for now.)

(b) Find the "Smaller v0.2-shaped features" section in Tracked backlog. The current bullet for output adapters reads:

```markdown
- **Output adapters: `glean today` + Notion/Slack/email** (~150 LOC) — addresses "folder is a bad consumption surface" without building a web app. `glean today` pretty-prints the latest INDEX.md inline in the terminal. Optional adapters mirror the same content to a Notion page, Slack channel, or email. Engine unchanged; just adds output surfaces beyond the local folder. (Cheap first step toward what the critique called "inbox UI.")
```

Replace with:

```markdown
- **Output adapters: Notion/Slack/email mirrors** (~100 LOC remaining) — the terminal slice (`glean today`) shipped in v0.2.1. What remains: optional adapters that mirror the same content to a Notion page, Slack channel, or email. Each adds OAuth + network surface — only worth doing once `glean today` proves useful in dogfood. (Cheap first step toward what the critique called "inbox UI.")
```

(c) Add a new entry to the **Done** section at the top of that list (between v0.2.0 and v0.1.2):

```markdown
- **v0.2.1** (2026-05-26, tag `v0.2.1`) — `glean today` terminal subcommand. Scans `~/glean/dossiers/*/<today>/INDEX.md` and prints a grouped, ANSI-colored report to stdout. Read-only, no engine changes. Ships the terminal slice of "Output adapters" — Notion/Slack/email mirrors remain deferred. See [v0.2.1 spec](./superpowers/specs/2026-05-25-glean-today-design.md), [v0.2.1 plan](./superpowers/plans/2026-05-26-glean-today.md).
```

### Step 4: Verify everything still builds and tests pass

```bash
cd /c/Glean && npm run build && npm test && npm run lint
```
Expected: all three exit 0.

### Step 5: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/ROADMAP.md && git commit -m "chore: bump to v0.2.1 + CHANGELOG + roadmap

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Merge to main and tag

**Files:** none

### Step 1: Switch to main and merge

```bash
cd /c/Glean && git checkout main && git merge --no-ff v0.2.1 -m "Merge v0.2.1 glean today into main"
```
Expected: merge commit on main.

### Step 2: Tag

```bash
cd /c/Glean && git tag -a v0.2.1 -m "v0.2.1 — glean today terminal subcommand"
```

### Step 3: Update ROADMAP commit SHA

Get the merge SHA:
```bash
cd /c/Glean && git log --oneline -1 main
```

Edit `C:\Glean\docs\ROADMAP.md` and replace `<TBD>` in the header with the actual SHA (8 chars). Example: if the merge SHA is `abcd1234e567...`, change `commit `<TBD>`` to `commit `abcd123``.

Then commit:
```bash
cd /c/Glean && git add docs/ROADMAP.md && git commit -m "docs(roadmap): fill in v0.2.1 commit SHA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Step 4: Verify final state

```bash
cd /c/Glean && git log --oneline -8 && git tag -l 'v0.2.*' && cat package.json | grep version
```
Expected: merge commit visible, `v0.2.0` and `v0.2.1` tags both present, `"version": "0.2.1"`.

### Step 5: Do NOT push without user approval

Per `CLAUDE.md` and global git rules, do not push until the user explicitly says so. When they do, the command is:
```bash
cd /c/Glean && git push origin main --follow-tags
```

---

## Done-when checklist (mirrors spec §1)

- [x] `glean today` invocable; scans `<gleanRoot>/dossiers/*/<today>/INDEX.md`; prints grouped report. (Task 4 + Task 5)
- [x] `src/lib/today.ts` exports `findTodayDossiers(gleanRoot, date?): TodayReport`. (Task 2)
- [x] `src/lib/render-today.ts` exports `renderToday(report, useColor): string`. (Task 3)
- [x] `src/cli.ts` registers `today` subcommand wiring scanner → renderer with `isTTY` color detection. (Task 4)
- [x] Empty case prints `No glean dossiers for <YYYY-MM-DD>.` exit 0. (Task 3 + Task 5 second test)
- [x] No new writes (substrate-isolation invariant). (Tasks 2–4 — verified by code inspection in self-review.)
- [x] `npm test`, `npm run build`, `npm run lint` all exit 0. (Task 5 + Task 6 verify.)
- [x] `CHANGELOG.md` has v0.2.1 entry. (Task 6)
- [x] `docs/ROADMAP.md` updated — terminal slice shipped, mirrors deferred remain Tracked. (Task 6 + Task 7)
