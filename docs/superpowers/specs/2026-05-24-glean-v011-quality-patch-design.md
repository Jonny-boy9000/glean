# Glean v0.1.1 Quality Patch — Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-24
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Fix 10 items surfaced by the v0.1.0 dogfood and the two `.skip`-marked tests. Ships as a non-breaking `v0.1.1` patch. Does NOT include POSIX support, `draft-impl`, scheduling, or any roadmap item from the broader 28-item list (those each get their own spec).

---

## 1. Goal and success criteria

After the v0.1.0 dogfood run against `C:\Glean`, three classes of problems emerged: ~80% of discovered candidates were false positives in docs/tests/fixtures, 11 dossiers from the first attempt lost their content due to a stream-json parsing bug, and the executor module had three small internal bugs (timer leak, sentinel collision, slug collision). Plus two integration tests were left in `.skip` state. The v0.1.1 patch closes all of these.

**Done when:**

1. All 77 tests pass. 1 documented skip remains (v08 integration test, with a new `jobobject.test.ts` unit test as the real coverage).
2. A dogfood re-run against `C:\Glean` produces a candidate set with <30% of candidates from `docs/`, `test/`, or `*.md` paths (was ~80% in v0.1.0).
3. **Manual runtime validation:** running `glean repair --days 30` against the existing v0.1.0 dossier directory on the dev machine (where the 11 22-byte OUT.md files from the first dogfood attempt still live) recovers them all, or reports a clear per-file reason for any that can't be recovered.
4. `discover-deps` emits at least 1 `fetch-docs` candidate on a real dogfood run (was 0).
5. `npm test`, `npm run build`, `npm run lint` all exit 0.
6. `CHANGELOG.md` documents every user-visible behavior change.

## 2. Locked decisions (from brainstorm)

- **Scope:** all 10 items (4–13 from the consolidated roadmap) in one ship.
- **Filter strategy:** hard-exclude noise paths via path globs (no language-aware parsing, no new config schema). Soft-weight `vendor/`, `third_party/`, `*.config.*`, `*.lock` rather than excluding.
- **Lost-output recovery:** automatic repair pass on every `glean run` + standalone `glean repair` subcommand.
- **JSONL discovery:** multi-signal — emit candidate if ANY of (a) `aiTitle` regex match, (b) unfinished `tool_use` at end, (c) idle >24h AND >10 assistant turns.
- **Test gaps:** expose `--task-timeout` flag on `glean run`, revive v03-budget using it. Keep v08 `.skip` but add a focused jobobject unit test.
- **Patch shape:** five thematic commits on a single `v0.1.1` branch off `main@bde58c7`.
- **Versioning:** non-breaking patch. Same config schema, same CLI surface plus additions (`repair` subcommand, `--task-timeout` flag).

## 3. Module changes summary

| File | Change | Items |
|---|---|---|
| `src/lib/discover-git.ts` | Extend `git grep` pathspec exclusions: `*.md`, `*.test.*`, `docs/**`, `test/**`, `**/fixtures/**`, `*.min.*`, `*.generated.*`, `*-lock.*`, `*.lock`. | 4 |
| `src/lib/discover-jsonl.ts` | Rewrite single-pass file scan to compute `{ai_title, last_assistant_turn_at, assistant_turn_count, unfinished_tool_use}`. Emit candidate if any signal fires. Records `evidence.signal` field. | 9 |
| `src/lib/discover-deps.ts` | Add diagnostic ndjson logging. Likely fix: change `--diff-filter=M` → `--diff-filter=AM` so newly-added manifests are picked up. | 10 |
| `src/lib/prioritize.ts` | Add `pathPenalty()` that multiplies `est_value` by 0.7 for `todo` candidates whose `file` matches a soft-noise regex set. Applied after `scoreValue`. | 11 |
| `src/lib/executor.ts` | (a) Clear timeout handle via try/finally on every exit path. (b) Replace `-2` numeric sentinel with discriminated union `{kind: 'exit' \| 'timeout'}`. (c) Include line number in slug: `<base>-L<line>` for todo candidates. | 6, 7, 8 |
| `src/lib/repair.ts` (new) | Export `repairRecent(gleanRoot, days=7): RepairResult`. Walks recent dossier dirs, finds OUT.md <100 bytes, re-extracts assistant text from matching `<task-id>.jsonl` log, overwrites empty OUT.md, updates INDEX status to `ok-repaired`. | 5 |
| `src/lib/jsonl-extract.ts` (new) | Extracts `extractLastAssistantText` from `executor.ts` so `repair.ts` can share it. Pure function. | 5 (refactor) |
| `src/lib/pipeline.ts` | Call `repairRecent(opts.gleanRoot)` after lock acquire, before discovery. Log `repair.done` event with counts. | 5 |
| `src/cli.ts` | (a) Add `--task-timeout` flag on `run` (default `8m`), parses with extended `parseBudget` supporting `s\|m\|h`. (b) Add `repair` subcommand with `--run-id` and `--days` args. | 5, 12 |
| `src/lib/jobobject.test.ts` | Add Windows-path unit test mocking `child_process.execFile`, asserts `taskkill /PID … /T /F` is called. | 13 |
| `test/integration/v03-budget.test.ts` | Remove `.skip`. Add `--task-timeout 2s` so the test completes in seconds. | 12 |
| `test/integration/v08-jobobject.test.ts` | Update `.skip` comment to point at the new `jobobject.test.ts` unit test as the real coverage. | 13 |
| `test/integration/v11-repair.test.ts` (new) | E2E test for `glean repair`. | 5 |
| `test/integration/v12-task-timeout.test.ts` (new) | E2E test for `--task-timeout`. | 12 |
| `package.json` | Bump version to `0.1.1`. | Versioning |
| `CHANGELOG.md` (new) | Plain-language list of v0.1.1 changes. | Hygiene |
| `README.md` | Add "Changelog" link at bottom (one line). | Hygiene |

## 4. Detailed module behavior

### 4.1 `discover-git.ts` — scanner filter

Path exclusions live as a module constant, applied to the `git grep` invocation:

```ts
const PATH_EXCLUDES = [
  ':!node_modules', ':!dist', ':!build',          // existing
  ':!*.md', ':!*.test.*',                          // doc + test files
  ':!docs/**', ':!test/**', ':!**/fixtures/**',    // doc + test directories
  ':!*.min.*', ':!*.generated.*',                  // generated files
  ':!*-lock.*', ':!*.lock',                        // lockfiles
];
```

Backward-compat: existing tests for `discoverGitTodos` continue to pass since they only assert on signal-path TODOs.

### 4.2 `discover-jsonl.ts` — multi-signal

Single-pass scan replacing the current backward-search `findLastAiTitle`:

```ts
type SessionScan = {
  ai_title: string | null;
  last_assistant_turn_at: number | null;
  assistant_turn_count: number;
  unfinished_tool_use: boolean;
};

function scanSession(filePath: string): SessionScan {
  // Walks the file once, tracking the last seen tool_use without matching tool_result.
  // A subsequent assistant record clears the pending tool_use (assumes the next assistant
  // turn would have responded to the tool_result if one existed).
  // ...
}
```

Candidate emission:

```ts
const reasons: string[] = [];
if (scan.ai_title && TODO_TITLE_RE.test(scan.ai_title)) reasons.push('todo-title');
if (scan.unfinished_tool_use) reasons.push('unfinished-tool-use');
if (idleHours > 24 && scan.assistant_turn_count > 10) reasons.push('idle-with-content');
if (reasons.length === 0) continue;
```

The `EvidenceJsonl` type gains an optional `signal?: string` field:

```ts
export type EvidenceJsonl = {
  kind: 'jsonl';
  session_id: string;
  ai_title: string;          // empty string if scan.ai_title was null
  idle_hours: number;
  signal?: string;           // comma-joined list of which signals fired
  recent_turns?: string[];   // hydrated by executor at run-time (unchanged)
};
```

Backward-compat: `signal` is optional, default `'todo-title'` for callers that don't set it. Existing fixture-based test passes via the `todo-title` path.

### 4.3 `discover-deps.ts` — diagnostic + fix

The diagnostic phase adds ndjson event logging before each manifest probe:

```ts
appendOrchestratorLog(root, runId, { evt: 'deps.manifest', manifest, exists, recent_commits });
appendOrchestratorLog(root, runId, { evt: 'deps.diff', manifest, added_count, packages });
```

Likely fix (verified via the diagnostic run):

```ts
// before:
['log', '-p', '--since=14.days', '--diff-filter=M', '--', m]
// after:
['log', '-p', '--since=14.days', '--diff-filter=AM', '--', m]
```

If the diagnostic surfaces a different bug, the fix changes accordingly. Hard cap: +2 hours of diagnostic+fix work. Beyond that, defer to v0.1.2 with a `// TODO(v0.1.2)` in the code.

### 4.4 `prioritize.ts` — soft weighting

```ts
const SOFT_NOISE_PATTERNS = [
  /\/vendor\//, /\/third_party\//, /\.config\./, /\.lock$/,
];

function pathPenalty(c: Candidate): number {
  if (c.evidence.kind !== 'todo') return 1.0;
  return SOFT_NOISE_PATTERNS.some((re) => re.test(c.evidence.file)) ? 0.7 : 1.0;
}

// In prioritize(), after scoreValue:
for (const c of candidates) c.est_value = Math.round(c.est_value * pathPenalty(c));
```

Penalty is orthogonal to existing heuristics — multiplied in, not replacing.

### 4.5 `executor.ts` — three fixes

**Timer clear (#7):**

```ts
const timer = setTimeout(() => { timedOut = true; job.kill(); }, ctx.taskTimeoutMs);
try {
  const exitCode = await job.exit;
  // ...handle exit
} finally {
  clearTimeout(timer);
}
```

The existing `Promise.race` with `-2` sentinel is removed; the timer's side effect (setting `timedOut = true` and calling `job.kill()`) is the only signaling channel.

**Sentinel collision (#8):** Replace the numeric sentinel with internal state. After the try/finally:

```ts
if (timedOut) return { status: 'timeout', elapsed_ms };
if (rateLimited) return { status: 'rate-limit', elapsed_ms };
if (exitCode !== 0) return { status: 'failed', elapsed_ms, stderr_tail: ... };
// ...ok / ok-fallback paths
```

No more `-2` magic number.

**Slug collision (#6):**

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

### 4.6 `repair.ts` (new) — recovery

```ts
export type RepairResult = {
  scanned: number;
  repaired: { run_id: string; task_id: string; path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
};

export function repairRecent(gleanRoot: string, days = 7): RepairResult { ... }
```

Algorithm:

1. List date-named directories under `<gleanRoot>/dossiers/*/` within `days`.
2. For each, parse `INDEX.md` frontmatter to get the `run_id` and the entries (each with `task_id`, `output` path, `status`).
3. For each entry whose `output` exists as a file <100 bytes:
   - Locate `<gleanRoot>/logs/<run_id>/<task_id>.jsonl`. If missing → skip with reason `log-missing`.
   - Call `extractLastAssistantText(jsonlPath)` (from new `jsonl-extract.ts`).
   - If extracted text <100 bytes → skip with reason `extraction-too-short`.
   - Overwrite the OUT.md with extracted text.
   - Rewrite the INDEX.md frontmatter entry's status from `ok-fallback` to `ok-repaired`.
4. Return `RepairResult` with counts and details.

INDEX.md status transitions:
- `ok-fallback` → `ok-repaired` on successful repair
- Other statuses (`ok`, `failed`, `timeout`, etc.) are left alone

### 4.7 `jsonl-extract.ts` (new) — refactor

`extractLastAssistantText` moves from `executor.ts` to its own module so `repair.ts` can share it. The function signature stays the same; the executor imports it from `./jsonl-extract.js`.

### 4.8 `pipeline.ts` — repair hook

After `acquireLock` and before discovery:

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

The repair pass is silent unless it actually repairs something — no log spam on every run.

### 4.9 `cli.ts` — new surface

```ts
const runCmd = defineCommand({
  args: {
    project: { type: 'string', required: true },
    budget: { type: 'string', default: '60m' },
    'dry-run': { type: 'boolean', default: false },
    'task-timeout': { type: 'string', default: '8m', description: 'Per-task timeout (e.g. 8m, 30s, 2m)' },
  },
  async run({ args }) {
    // ...existing setup
    const taskTimeoutMs = parseBudget(args['task-timeout'] as string);
    const summary = await runPipeline({ ..., taskTimeoutMs });
  },
});

const repairCmd = defineCommand({
  meta: { name: 'repair', description: 'Re-extract missing OUT.md from recent JSONL logs (no Claude spawn)' },
  args: {
    'run-id': { type: 'string', description: 'Specific run to repair (default: all within --days)' },
    days: { type: 'string', default: '7' },
  },
  async run({ args }) {
    const days = Number(args.days);
    const result = repairRecent(gleanRoot(), days);
    // optionally filter to args['run-id']
    console.log(`scanned ${result.scanned}, repaired ${result.repaired.length}, failed ${result.failed.length}`);
    for (const r of result.repaired) console.log(`  ✓ ${r.path} (${r.bytes} bytes)`);
    for (const f of result.failed) console.error(`  ✗ ${f.path}: ${f.reason}`);
  },
});
```

`parseBudget` extends:

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

## 5. Testing strategy

| Test file | Existing | After v0.1.1 | New tests |
|---|---|---|---|
| `src/lib/discover-git.test.ts` | 4 | 7 | excludes `*.md`, excludes `*.test.ts`, excludes `docs/` subtree |
| `src/lib/discover-jsonl.test.ts` | 4 | 7 | unfinished-tool-use signal, idle-with-content signal, multi-signal combined |
| `src/lib/discover-deps.test.ts` | 1 | 2 | newly-added manifests via `--diff-filter=AM` |
| `src/lib/prioritize.test.ts` | 6 | 7 | soft-weights vendor/ paths to 0.7 |
| `src/lib/executor.test.ts` | 3 | 6 | timer cleared on exit, exit-code-vs-timeout distinction, distinct slugs for same file |
| `src/lib/repair.test.ts` (new) | 0 | 5 | repairs <100 byte OUT.md, skips substantive, skips missing log, skips short extraction, respects days window |
| `src/lib/jobobject.test.ts` | 2 | 3 | mocked `execFile` asserts `taskkill /T /F` args on Win32 |
| `test/integration/v03-budget.test.ts` | skipped | passing | unchanged assertion, runs in <30s via `--task-timeout 2s` |
| `test/integration/v08-jobobject.test.ts` | skipped | still skipped | comment updated to point at unit test |
| `test/integration/v11-repair.test.ts` (new) | 0 | 1 | E2E `glean repair` |
| `test/integration/v12-task-timeout.test.ts` (new) | 0 | 1 | E2E `--task-timeout` |
| **Suite total** | **58 + 2 skip** | **77 + 1 skip** | **+19 tests** |

### 5.1 Notable test choices

- **Timer leak test** uses `vi.useFakeTimers()` and asserts `vi.getTimerCount() === 0` after `executeOne` returns. Doesn't need a real time delay.
- **Sentinel collision test** uses a fake-claude scenario that exits with a non-zero code (not -2 specifically; the point is type-safety, not the literal value).
- **Repair tests** build fixtures: a tmpdir with `dossiers/proj/<date>/research-foo/OUT.md` (22 bytes), `logs/<run-id>/<task-id>.jsonl` (containing extractable text), and `INDEX.md` with matching frontmatter.
- **v11-repair integration test** spawns `node bin/glean.js repair --run-id <test-run-id>` against a hand-built dossier dir, asserts the OUT.md is overwritten.

## 6. Rollout

### 6.1 Branch + commit plan

Single `v0.1.1` branch off `main@bde58c7`. Five thematic commits + version bump:

| # | Commit message | Items | Approx LOC |
|---|---|---|---|
| 1 | `feat(discover): exclude noise paths from git grep + soft-weight vendored paths` | 4, 11 | +30 src, +30 test |
| 2 | `feat(discover-jsonl): multi-signal discovery (aiTitle, unfinished tool-use, idle-with-content)` | 9 | +80 src, +60 test, +3 fixtures |
| 3 | `fix(executor): clear timer on exit, type-safe sentinel, line-number in slug` | 6, 7, 8 | +20 src, +40 test |
| 4 | `feat(repair): auto-repair empty OUT.md from jsonl logs + glean repair subcommand` | 5 | +150 src (incl. new modules), +80 test |
| 5 | `feat(cli): --task-timeout flag; revive v03 budget test; fix discover-deps initial-commit case; jobobject unit test` | 10, 12, 13 | +60 src, +80 test |
| 6 | `chore: bump version to 0.1.1, add CHANGELOG.md` | versioning | +30 docs |

Estimated total: ~340 LOC src, ~290 LOC test, ~30 LOC docs.

### 6.2 Commit ordering rationale

- Commit 1 is the safest pure-filter addition — first to land so the dogfood diagnostic in commit 5 runs against the post-filter candidate set.
- Commit 2 before commit 4 so the repair pass sees the new candidate types.
- Commit 3 is independent — sits with the internal cleanup work.
- Commit 4 before commit 5 — `glean repair` CLI wrapper needs the underlying module.
- Commit 5 last — diagnoses `discover-deps` against the most recent state.

### 6.3 Acceptance criteria

1. All 77 tests pass. 1 documented skip remains.
2. Dogfood re-run produces a candidate set with <30% from noise paths.
3. `glean repair` against the v0.1.0 dossier dir recovers the 11 historical 22-byte OUT.md files.
4. `discover-deps` emits at least 1 candidate on a real dogfood run.
5. `npm test`, `npm run build`, `npm run lint` all exit 0.
6. `CHANGELOG.md` lists every behavior change.
7. README has a "Changelog" link at the bottom.

### 6.4 Explicit non-goals

- No new `config.json` schema fields.
- No language-aware parsing (tree-sitter, etc.).
- No POSIX work.
- No `draft-impl`, scheduling, or other roadmap items.
- No npm publish.

### 6.5 Rollback plan

If a regression surfaces post-tag:
- `git revert <commit-sha>` per-commit (each is independently revertable).
- Cut `v0.1.2` immediately.
- If the regression is in `repair.ts` and is urgent: revert the pipeline.ts call site (one-line revert) — the standalone `glean repair` command stays usable.

### 6.6 Risks

| Risk | Mitigation |
|---|---|
| Repair pass slows down every `glean run` if dossier history is large | Bounded to last 7 days; "skip if OUT.md ≥100 bytes" is one statSync per file. Worst-case ~100ms for 100 files. Acceptable. |
| JSONL multi-signal over-discovers, flooding candidates.json | Ranking already caps jsonl `est_value` at 50 vs 100 for todo. If real-world floods, tune threshold in v0.1.2. |
| `--diff-filter=AM` isn't the discover-deps bug | Diagnostic logging runs first. Hard cap +2 hours; if undiagnosed, defer to v0.1.2 with a `// TODO(v0.1.2)`. |
| Cross-platform path-exclusion semantics differ | `git grep` pathspecs work identically on Win/POSIX. No risk. |

## 7. Out of scope (subsequent v0.1.x or v0.2 specs)

- POSIX port — issue #1.
- `draft-impl` worktree drafting.
- Scheduling (Task Scheduler / cron / launchd).
- `glean discard` / `gc` / `peek` subcommands.
- SessionStart hook.
- Resume-after-crash.
- Rate-limit back-off ladder + circuit breaker.
- Multi-project per run.
- Parallelism.
- `npm publish` / demo screenshot / terminal GIF.

Each gets its own brainstorm → spec → plan cycle when prioritized.

---

*Brainstorm session: 2026-05-24. Four-section design walkthrough approved before this doc was written.*
