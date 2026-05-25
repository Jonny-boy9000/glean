# `glean today` — Terminal Dossier View Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-25
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Add a `glean today` CLI subcommand that finds every INDEX.md generated today across all projects in `~/glean/dossiers/`, parses each, and renders them grouped by project to the terminal. Read-only, no engine interaction. Ships as `v0.2.1`. Does NOT include the external adapters (Notion / Slack / email) from the original "Output adapters" Tracked item — only the terminal slice.

---

## 1. Goal and success criteria

The current consumption surface for glean's output is "open `~/glean/dossiers/<project>/<date>/INDEX.md` in an editor." That's friction Jonny hits every time he wants to see what the latest run produced. `glean today` collapses that to a single command that prints a readable summary inline.

This release adds the terminal output surface only. The full "Output adapters" Tracked item also envisioned Notion / Slack / email mirrors, but each of those adds OAuth, network, and dep weight. Shipping `glean today` alone validates whether the inline view is actually useful before committing to any external integration.

**Done when:**

1. `glean today` invocable from the CLI. It scans `<gleanRoot>/dossiers/*/YYYY-MM-DD/INDEX.md` for the current local-tz calendar day and prints a grouped report to stdout.
2. New module `src/lib/today.ts` exports `findTodayDossiers(gleanRoot: string, date?: string): TodayReport` — a pure scan + parse function with no I/O beyond reading files.
3. New module `src/lib/render-today.ts` exports `renderToday(report: TodayReport, useColor: boolean): string` — a pure formatter.
4. `src/cli.ts` registers a `today` subcommand (citty), wires scanner → renderer, detects color via `process.stdout.isTTY`, prints to stdout, exits 0.
5. When no dossiers exist for today, prints `No glean dossiers for <YYYY-MM-DD>.` and exits 0 (not an error).
6. Recording-failure compatibility is irrelevant — this command never writes anywhere. It only reads INDEX.md files.
7. `npm test`, `npm run build`, `npm run lint` all exit 0. New unit + integration tests cover scan correctness, render format (with and without color), and end-to-end CLI behavior.
8. `CHANGELOG.md` has a `v0.2.1` entry.
9. `docs/ROADMAP.md` notes that the terminal slice of "Output adapters" has shipped; the Notion / Slack / email parts remain in Tracked backlog with an updated description.

## 2. Locked decisions (from brainstorm)

- **Strategic move:** `glean today` over alternatives (POSIX port, learning loop on memory substrate, api-key fallback, draft-pr-reply). Selected because (a) Jonny's stated optimization criterion is his own dogfood quality, (b) this is the only candidate that changes the daily user experience, (c) cheapest possible step (~120 LOC), (d) generates feedback about what the *next* adapter should optimize for.
- **Scope:** terminal output only. No Notion / Slack / email mirrors in this release.
- **Default scope:** all of today's dossiers, across all projects, grouped by project. Not CWD-scoped, not most-recent-only.
- **Format:** ANSI-colored when interactive (`process.stdout.isTTY`), plain ASCII when piped. No `chalk` dep — raw ANSI escape sequences inline.
- **CLI surface:** zero flags. No `--date`, no `--project`, no `--json`, no `--watch`. Add when an actual use case appears.
- **Empty case:** print `No glean dossiers for <date>.`, exit 0. Not an error.
- **Engine isolation:** does not modify `pipeline.ts`, `executor.ts`, or any discovery module. Does not read from `memory.db`. Reads only the human-facing INDEX.md files (the right source for human-facing output).

## 3. Architecture

Two new pure modules plus a small CLI registration. The scanner returns structured data; the renderer turns it into a string. Splitting them isolates testable units — the scanner is testable without ANSI noise; the renderer is testable against fixture data without filesystem setup.

```
glean today
  ├─ resolve gleanRoot from %USERPROFILE%\glean (existing state.ts helper)
  ├─ findTodayDossiers(gleanRoot)
  │     └─ glob dossiers/*/YYYY-MM-DD/INDEX.md
  │     └─ parse YAML frontmatter from each
  │     └─ return TodayReport
  ├─ renderToday(report, process.stdout.isTTY)
  └─ process.stdout.write(rendered + '\n')
```

The current INDEX.md format (set by `pipeline.ts` `appendIndex`) is a YAML frontmatter block followed by a human-readable markdown list. We parse the frontmatter (authoritative, structured data) and ignore the markdown body (derived).

## 4. Data shape

```ts
export type IndexEntryStatus =
  | 'ok'
  | 'ok-fallback'
  | 'failed'
  | 'timeout'
  | 'rate-limit';

export type IndexEntry = {
  title: string;
  status: IndexEntryStatus;
  output: string;                           // path to OUT.md (may be empty for failed tasks)
  type: 'research-dossier' | 'fetch-docs';
};

export type ProjectGroup = {
  project_slug: string;
  project_path?: string;                    // from frontmatter when present
  entries: IndexEntry[];                    // in original order from INDEX.md
};

export type TodayReport = {
  date: string;                             // YYYY-MM-DD in local tz
  projects: ProjectGroup[];                 // sorted alphabetically by slug
};
```

Per-day-per-project INDEX.md is already a single file — `pipeline.ts` reads the existing INDEX, appends new entries, and rewrites. So multiple runs in one day all share one INDEX. No cross-run merging needed in `today.ts`.

## 5. Module details

### 5.1 `src/lib/today.ts`

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';

export function findTodayDossiers(gleanRoot: string, date?: string): TodayReport {
  const targetDate = date ?? localDateString(new Date());
  const dossiersDir = join(gleanRoot, 'dossiers');
  if (!existsSync(dossiersDir)) return { date: targetDate, projects: [] };

  const projectSlugs = safeReaddir(dossiersDir).sort();
  const projects: ProjectGroup[] = [];

  for (const slug of projectSlugs) {
    const indexPath = join(dossiersDir, slug, targetDate, 'INDEX.md');
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
  // Read file, extract frontmatter block via /^---\n([\s\S]+?)\n---/ regex,
  // yamlParse it, coerce entries[] into IndexEntry[]. Return null on parse failure
  // (don't throw — a corrupt INDEX shouldn't kill the report).
}

function localDateString(d: Date): string {
  // YYYY-MM-DD in local timezone (matches pipeline.ts's `today()` helper)
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
```

The `date` parameter exists for testability (fixture dossiers under fixed dates). The CLI never passes it; `localDateString(new Date())` is the runtime default.

### 5.2 `src/lib/render-today.ts`

```ts
import type { TodayReport } from './today.js';

export function renderToday(report: TodayReport, useColor: boolean): string {
  // Build line-by-line. Header, then per-project block.
  // Empty case: 'No glean dossiers for <date>.'
}

// Internal helpers — ANSI sequences inline (no chalk dep)
const ANSI = {
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:     (s: string) => `\x1b[2m${s}\x1b[0m`,
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
};
```

When `useColor` is false, all ANSI helpers degrade to the identity function. The recommended pattern: a `c` factory `const c = useColor ? ANSI : { bold: s=>s, dim: s=>s, green: s=>s, red: s=>s }`, then `c.bold(text)` everywhere downstream.

### 5.3 Render format (normative)

Plain mode (no ANSI):

```
GLEAN today — 2026-05-25

▸ glean                                              5 tasks
  ✓ ok           Handle TODO in src/cli.ts
                 ~/glean/dossiers/glean/2026-05-25/research-handle-todo-src-cli-ts-L42/OUT.md
  ✓ ok           Pre-fetch docs for better-sqlite3
                 ~/glean/dossiers/glean/2026-05-25/docs/better-sqlite3.md
  ✗ failed       Handle TODO in lib/foo.ts
                 (no output)

▸ other-project                                      2 tasks
  ✓ ok-fallback  Some title
                 ~/glean/dossiers/other-project/2026-05-25/research-some-title-L1/OUT.md
```

Rules:

- Header line: `GLEAN today — <YYYY-MM-DD>`. Bold in color mode.
- Blank line after header.
- Per project: `▸ <slug>` left-aligned, then padding spaces, then `<N> tasks` right-aligned to column 60. If `slug + ' ' + 'N tasks'` is wider than 60, keep at least 2 spaces between them and let the line overflow — slug wins. Project header bold in color mode.
- Each entry: 2 spaces, then status icon (`✓` for `ok`/`ok-fallback`; `✗` for `failed`/`timeout`/`rate-limit`), 1 space, then status string right-padded to 12 chars (left-aligned, trailing spaces), 1 space, then title.
  - Icon color: green for `✓`, red for `✗`.
- Output line: 17 spaces, then path. Dim grey in color mode. If `output` is empty, print `(no output)` instead of a path.
- Path normalization: replace `<gleanRoot>` prefix with `~/glean` for readability (tilde-style even on Windows where `~` is just visual). If `gleanRoot` doesn't appear, print the raw `output` value.
- Blank line between projects (not after the last project).

Color-mode output is identical except status icon + status string are green or red, project header is bold, paths are dim, and the top header line is bold.

### 5.4 `src/cli.ts` integration

Add a `today` subcommand to the existing citty command tree. The subcommand definition:

```ts
const todayCommand = defineCommand({
  meta: { name: 'today', description: 'Show today\'s glean dossiers across all projects' },
  async run() {
    const root = gleanRoot();
    const report = findTodayDossiers(root);
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(renderToday(report, useColor) + '\n');
  },
});
```

Registered alongside the existing `run`, `stop`, `repair`, `version` subcommands. No new top-level imports beyond `findTodayDossiers`, `renderToday`, and `gleanRoot` (already in scope).

## 6. Module changes

| File | Change |
|---|---|
| `src/lib/today.ts` | **New.** Pure scanner. ~40 LOC including types. |
| `src/lib/today.test.ts` | **New.** Fixture-based scan tests. ~3–4 tests. |
| `src/lib/render-today.ts` | **New.** Pure formatter. ~50 LOC including ANSI helpers. |
| `src/lib/render-today.test.ts` | **New.** Format tests (plain + color). ~3–4 tests. |
| `src/cli.ts` | Add `today` subcommand. ~15 LOC delta. |
| `test/integration/v15-today.test.ts` | **New.** End-to-end CLI smoke. 1 test. |
| `package.json` | Bump version to `0.2.1`. |
| `CHANGELOG.md` | v0.2.1 entry. |
| `docs/ROADMAP.md` | Note terminal slice shipped; update "Output adapters" description to note remaining (Notion / Slack / email) parts. |

## 7. Testing plan

### 7.1 Scanner unit tests (`src/lib/today.test.ts`)

1. **Empty `~/glean/dossiers`** — returns `{ date, projects: [] }`. No throw.
2. **One project, today only** — fixture: `dossiers/foo/2026-05-25/INDEX.md` with 2 entries. Pass `date: '2026-05-25'`. Returns one project with 2 entries.
3. **Multiple projects, mixed dates** — fixtures: `dossiers/foo/2026-05-25/INDEX.md`, `dossiers/bar/2026-05-24/INDEX.md`. Pass `date: '2026-05-25'`. Returns only `foo`.
4. **Corrupt INDEX.md** — fixture with malformed frontmatter. Project is skipped (returned `projects` does not include it). No throw.

### 7.2 Renderer unit tests (`src/lib/render-today.test.ts`)

1. **Empty report** — renders `No glean dossiers for 2026-05-25.` (no trailing newline; CLI adds the `\n`).
2. **Single project, mixed statuses** — renders header, project line with task count, entries with correct icons (`✓` for ok, `✗` for failed), tilde-replaced paths. `useColor: false`. Assert no `\x1b` escape sequences in output.
3. **Color mode** — same input, `useColor: true`. Assert `\x1b[1m` (bold) appears in the header line. Assert `\x1b[32m` (green) appears on `ok` entries and `\x1b[31m` (red) appears on `failed` entries.
4. **Path normalization** — entry with `output: '<gleanRoot>/dossiers/foo/2026-05-25/x/OUT.md'` renders with `~/glean/...` prefix when `gleanRoot` is detectable in the path; raw output otherwise.

### 7.3 Integration test (`test/integration/v15-today.test.ts`)

Spawn `node bin/glean.js today` with `USERPROFILE` / `HOME` pointing at a temp directory that has a pre-populated `dossiers/<slug>/<today>/INDEX.md` with known entries. Assert:

- Exit code 0.
- stdout contains `GLEAN today —` header.
- stdout contains the project slug.
- stdout contains at least one expected entry title.

### 7.4 Regression discipline

The full existing test suite (95 passing + 1 skipped) must continue to pass. This release adds ~10 new tests; target total: ~105 passing + 1 skipped.

## 8. Out of scope (explicit)

- **No external adapters.** Notion, Slack, email, webhook — all separate. The Tracked-backlog "Output adapters" entry shrinks to just those.
- **No flags.** `--date`, `--project`, `--json`, `--watch`, `--failed-only` — none. Add only when an actual use case shows up.
- **No interactive UI.** No TUI, no pagination, no `less`-style paging, no `$EDITOR` launching.
- **No memory.db reads.** The `memory.db` substrate exists for future learning loops and machine-readable queries; human-facing output reads INDEX.md (the existing human-facing source of truth).
- **No engine changes.** `pipeline.ts`, `executor.ts`, and discovery modules are not touched.
- **No `glean yesterday` / `glean last`.** If asked for, those are trivial extensions but not built now.
- **No CWD detection.** The scope question explicitly rejected the CWD-aware variant in favor of cross-project.

## 9. Rollback / failure modes

- **Glob has no matches** — `findTodayDossiers` returns `{ date, projects: [] }`. Renderer prints `No glean dossiers for <date>.`. Exit 0.
- **Corrupt INDEX.md** — `parseIndex` returns `null`. The project is silently skipped. No throw. (Optional: a future `--strict` flag could surface parse errors; not built now.)
- **Filesystem error on `~/glean/dossiers`** (e.g., directory doesn't exist because glean was never run) — `safeReaddir` catches and returns `[]`. Renderer prints empty case. Exit 0.
- **Terminal doesn't support ANSI** — `process.stdout.isTTY` returns `false` when output is redirected; color is disabled automatically. For interactive terminals that don't honor ANSI (rare), the codes are printed literally — acceptable known issue; user can pipe through `cat` to strip if needed.

## 10. Open questions deferred

- Whether to add `--date YYYY-MM-DD` to inspect past days. Deferred until someone wants it; today's `glean today` works for the daily use case.
- Whether to add `--json` for scripting. Deferred — the `memory.db` substrate is the right source for programmatic queries; `glean today` is for humans.
- Whether to add path-clickability (terminal-hyperlink OSC 8 escape) on the output paths. Probably nice; deferred to a later patch if Jonny reports the friction.
- Whether to wire `glean today` into the optional SessionStart hook (so dossiers print automatically when entering a project). That's the original `glean peek` from the deferred sub-projects list; it builds on `today` and is a separate item.
