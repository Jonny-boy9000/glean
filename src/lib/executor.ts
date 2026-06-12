import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, createWriteStream, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, TaskResult, TaskOutput, DraftTestStatus } from './types.js';
import { spawnInJob } from './jobobject.js';
import { render } from './render.js';
import { extractLastAssistantText } from './jsonl-extract.js';
import { projectSlug } from './state.js';
import { titleFor, today } from './candidate-meta.js';
import { BASE_DENY, DRAFT_IMPL_DENY, draftImplAllowedTools, researchAllowedTools, DEFAULT_TEST_COMMAND_ALLOW } from './deny.js';
import { StringDecoder } from 'node:string_decoder';
import { classifyRateLimit, classifyStreamJson, isStreamBlockLine, parseRateLimitEventResetAt, type RateLimitClassification } from './classify.js';

// ADR-0003: the REAL `claude -p` block (session limit, captured 2026-06-11) is a
// STRUCTURED stream-json signal on stdout — see classify.ts:isStreamBlockLine —
// and that is now the PRIMARY detector (scanned live in runClaude below). This
// stderr regex is the FALLBACK for any block that arrives as stderr prose
// instead. ASSUMPTION[ADR-0003]: the weekly block shape is still unobserved;
// keep this fallback until it is captured. Kept in sync with classify.ts.
// 'session limit' added 2026-06-11 (the observed block wording).
const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit|session limit)/i;

// Classify the rate-limit signal (session vs weekly vs ambiguous). Only called
// when spawn.rateLimited is true. Hierarchy (ADR-0003):
//   1. structured stream-json block (VERIFIED session shape) — the in-memory
//      signal lines captured during streaming, else the .jsonl on disk;
//   2. stderr prose fallback (the old ADR-0001 path), enriched with any
//      rate_limit_event resetsAt from the stream.
// Tolerant of missing streams — an unreadable signal degrades to 'ambiguous'
// rather than crashing the run.
const STDERR_TAIL_BYTES = 4096;
// Bounded in-memory capture of signal-bearing stream-json lines (ADR-0003).
const STREAM_SIGNAL_BYTES = 16384;
// Cap for the stdout line-assembly buffer (a single stream-json event line is
// normally far smaller; a truncated over-long line just fails the JSON parse).
const STDOUT_LINE_BUF_MAX = 1024 * 1024;
function classifySpawnSignal(spawn: SpawnOutcome): RateLimitClassification {
  // 1. Structured stream-json block (PRIMARY). Prefer the in-memory lines
  // captured during streaming (no flush race); fall back to reading the
  // captured .jsonl only if empty.
  let streamText = spawn.streamSignalText ?? '';
  if (!streamText) {
    try { streamText = readFileSync(spawn.jsonlPath, 'utf8'); } catch { streamText = ''; }
  }
  const fromStream = classifyStreamJson(streamText);
  if (fromStream !== null) return fromStream;

  // 2. stderr fallback. Prefer the in-memory tail captured during streaming.
  let text = spawn.stderrText ?? '';
  if (!text) {
    try {
      const size = statSync(spawn.stderrPath).size;
      const fd = openSync(spawn.stderrPath, 'r');
      try {
        const start = Math.max(0, size - STDERR_TAIL_BYTES);
        const len = size - start;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        text = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      // Missing/unreadable stderr — classifyRateLimit('') returns ambiguous.
      text = '';
    }
  }
  const classification = classifyRateLimit(text);
  // Enrichment for the stderr fallback: it often carries no parseable reset
  // moment. When it doesn't, back-fill reset_at from the VERIFIED
  // rate_limit_event.resetsAt in the captured stream-json (.jsonl). This only
  // fills a missing timestamp — `kind` (the stderr classifier's decision) is
  // never changed. Best-effort: swallow any read/parse error so an unreadable
  // jsonl degrades to the stderr result.
  if (classification.reset_at === null) {
    try {
      const jsonl = readFileSync(spawn.jsonlPath, 'utf8');
      const resetAt = parseRateLimitEventResetAt(jsonl);
      if (resetAt !== null) {
        return { ...classification, reset_at: resetAt };
      }
    } catch {
      // Missing/unreadable jsonl — keep the stderr-only classification.
    }
  }
  return classification;
}

// ADR-0001/0002 self-capturing tripwire: whenever a spawn is flagged
// rateLimited, dump the full raw stderr + the last ~50 lines of the captured
// stream-json (.jsonl) to <logDir>/<taskId>.BLOCK-CAPTURE.txt. This is how the
// session-block shape captured itself on 2026-06-11; it stays armed because the
// WEEKLY block shape is still unobserved (ADR-0003). LOCAL file write only — no
// spawn, no network. Best-effort: NEVER throws out of the capture path.
const BLOCK_CAPTURE_JSONL_TAIL_LINES = 50;
function captureBlockSignal(taskId: string, logDir: string, spawn: SpawnOutcome): void {
  try {
    let stderrRaw = spawn.stderrText ?? '';
    // Prefer the full on-disk stderr, but the stream end() is async so the file
    // may not be flushed yet — fall back to the in-memory tail if the read is
    // empty or throws, so the capture is never blank when we have the signal.
    try {
      const fromFile = readFileSync(spawn.stderrPath, 'utf8');
      if (fromFile) stderrRaw = fromFile;
    } catch { /* keep the in-memory tail */ }
    let jsonlTail = '';
    try {
      const lines = readFileSync(spawn.jsonlPath, 'utf8').split(/\r?\n/);
      jsonlTail = lines.slice(-BLOCK_CAPTURE_JSONL_TAIL_LINES).join('\n');
    } catch { /* jsonl missing — capture stderr alone */ }
    const body =
      `# glean BLOCK-CAPTURE (ADR-0003 self-capturing tripwire)\n` +
      `# Task: ${taskId}\n` +
      `# Captured: ${new Date().toISOString()}\n` +
      `# A rate-limit flag fired for this task. The SESSION block shape is already\n` +
      `# verified (ADR-0003); if the signal below looks WEEKLY-shaped (a reset days\n` +
      `# away / a non-five_hour rateLimitType), the missing WEEKLY block has finally\n` +
      `# been captured — drop it into a fixture and supersede/close ADR-0003.\n` +
      `\n## raw stderr\n${stderrRaw}\n` +
      `\n## stream-json tail (last ${BLOCK_CAPTURE_JSONL_TAIL_LINES} lines)\n${jsonlTail}\n`;
    writeFileSync(join(logDir, `${taskId}.BLOCK-CAPTURE.txt`), body);
  } catch {
    // Capture is strictly best-effort diagnostics — never let it break a run.
  }
}

export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  // Per-project base branch (from config.json projects[path].base_branch).
  // Required for draft-impl; if absent, draft-impl candidates are skipped.
  // F5: prefer baseBranchFor (resolved per-candidate by the candidate's OWN
  // project_path) over the ambient baseBranch, so a multi-project run can't
  // provision a worktree off the wrong repo's base. baseBranch remains as a
  // single-project fallback.
  baseBranch?: string;
  baseBranchFor?: (projectPath: string) => string | undefined;
  // Per-project scoped test-command allow-list prefixes for draft-impl
  // (config.json projects[path].test_command, normalized to Bash(...) prefixes).
  // Absent → DEFAULT_TEST_COMMAND_ALLOW (npm/node toolchain).
  testCommandAllow?: readonly string[];
  // Per-project RAW test_command (config.json projects[path].test_command),
  // resolved by the candidate's OWN project_path. glean runs this itself in the
  // draft worktree AFTER the session commits to capture a deterministic test
  // status. Absent / unrunnable → 'none'. (The spawned session also runs tests,
  // but glean owns the surfaced result.)
  testCommandFor?: (projectPath: string) => string | undefined;
  // C1: REMAINING wall-clock budget for the whole run, measured at the moment
  // executeOne is called. The post-draft test run's timeout is clamped to this so
  // a draft committing near budget-end can never overrun `--budget` by up to the
  // 5-min test cap. If <= 0, the test run is SKIPPED ('none', not run). Absent →
  // treated as unbounded (single-task callers / unit tests without a budget).
  remainingBudgetMs?: number;
  // C1: STOP-sentinel probe. Checked just before the post-draft test run; if set,
  // the test run is SKIPPED ('none', not run) so `glean stop` bounds it. (Full
  // mid-run interruption of the blocking spawn is out of scope.)
  stopRequested?: () => boolean;
  recordOutcome?: (status: TaskResult['status'], fields: {
    dossier_path?: string;
    started_at?: number;
    ended_at?: number;
    duration_ms?: number;
    bytes_written?: number;
    stderr_rate_limit_hits?: number;
    draft_files?: number;
    draft_insertions?: number;
    draft_deletions?: number;
    prep_branch?: string;
    draft_tests?: string;
  }) => void;
};

// Result of a single claude -p spawn (shared by both task paths).
type SpawnOutcome = {
  exitCode: number;
  rateLimited: boolean;
  timedOut: boolean;
  stderrPath: string;
  // In-memory tail of stderr captured DURING streaming. Classifying this avoids a
  // flush race: stderrStream.end() is async, so re-reading the file immediately
  // could miss the final chunk and spuriously degrade session/weekly to ambiguous.
  stderrText: string;
  // ADR-0003: in-memory capture of the rate-limit-relevant stream-json stdout
  // lines (rate_limit_event / error results) collected DURING streaming, so the
  // structured classification never depends on the async .jsonl flush.
  streamSignalText: string;
  jsonlPath: string;
  // F7: true once runClaude has awaited job.exit AND any kill() — the entire
  // spawned process tree is confirmed dead, so the worktree's index.lock (if any)
  // is provably orphaned and safe to clear.
  descendantsDead: boolean;
};

export async function executeOne(c: Candidate, ctx: ExecCtx): Promise<TaskResult> {
  if (c.type === 'draft-impl') return executeDraftImpl(c, ctx);
  return executeDossier(c, ctx);
}

// ── Dossier / fetch-docs path (the original behavior) ───────────────────────
async function executeDossier(c: Candidate, ctx: ExecCtx): Promise<TaskResult> {
  const start = Date.now();
  const slug = slugify(c);
  const dossierDir = join(ctx.gleanRoot, 'dossiers', projectSlug(c.project_path), today());
  const workDir = c.type === 'research-dossier' ? join(dossierDir, `research-${slug}`) : join(dossierDir, 'docs');
  mkdirSync(workDir, { recursive: true });

  const hydrated = hydrateEvidence(c, ctx);
  const templatePath = pickTemplate(c, ctx);
  const templateBody = readFileSync(templatePath, 'utf8');
  const prompt = render(templateBody + SAFETY_FOOTER, hydrated);
  const promptPath = join(workDir, 'prompt.md');
  writeFileSync(promptPath, prompt);

  // research-dossier (ADR-0002): grant READ access to the project being researched
  // (in addition to the dossier output dir), and make the session write-incapable
  // via a scoped read-only allow-list. fetch-docs (`docs`) keeps the original
  // output-dir-only scope for now (separate roadmap item).
  const isResearch = c.type === 'research-dossier';
  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: workDir,
    addDir: isResearch ? [workDir, c.project_path] : workDir,
    deny: BASE_DENY,
    allowedTools: isResearch ? researchAllowedTools() : undefined,
  });

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
        stderr_rate_limit_hits: spawn.rateLimited ? 1 : 0,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`);
    }
    const result: TaskResult = { status, elapsed_ms };
    if (output_path) result.output = { kind: 'file', path: output_path };
    if (stderr_tail) result.stderr_tail = stderr_tail;
    // v0.8: surface the classified rate-limit signal so the drain wrapper can
    // decide session-paused vs weekly-drained vs ambiguous.
    if (status === 'rate-limit') result.classification = classifySpawnSignal(spawn);
    return result;
  };

  if (spawn.rateLimited) return finalize('rate-limit', undefined, undefined);
  if (spawn.timedOut) return finalize('timeout', undefined, undefined);
  if (spawn.exitCode !== 0) {
    const tail = tailLines(readFileSync(spawn.stderrPath, 'utf8'), 50);
    return finalize('failed', undefined, tail);
  }

  // research-dossier (ADR-0002): glean (the orchestrator) writes OUT.md from the
  // captured final assistant message — this is now the PRIMARY capture path, since
  // the read-only session can no longer write OUT.md itself.
  if (isResearch) {
    const outPath = join(workDir, 'OUT.md');
    const body = extractLastAssistantText(spawn.jsonlPath);
    writeFileSync(outPath, body);
    return finalize('ok', outPath, undefined);
  }

  // fetch-docs (`docs`): the session writes a markdown file itself; capture it,
  // falling back to the stream if it's missing/too small (unchanged behavior).
  const outPath = findFirstFile(workDir, /\.md$/);
  if (outPath && existsSync(outPath)) {
    const bytes = readFileSync(outPath).length;
    if (bytes < 50) {
      const fallback = extractLastAssistantText(spawn.jsonlPath);
      writeFileSync(outPath, fallback);
      return finalize('ok-fallback', outPath, undefined);
    }
    return finalize('ok', outPath, undefined);
  }
  // No output at all — fallback
  const fallback = extractLastAssistantText(spawn.jsonlPath);
  const fallbackPath = join(workDir, 'OUT.md');
  writeFileSync(fallbackPath, fallback);
  return finalize('ok-fallback', fallbackPath, undefined);
}

// ── draft-impl path (T6) ────────────────────────────────────────────────────
// Provision an isolated worktree on prep/glean-<taskid> off the configured base,
// let the spawned session implement + commit, then capture the branch diff stat.
// Glean scratch (prompt/logs) lives OUTSIDE the worktree so it is never swept
// into the user's draft commit.
async function executeDraftImpl(c: Candidate, ctx: ExecCtx): Promise<TaskResult> {
  const start = Date.now();

  const finalizeFail = (status: TaskResult['status'], stderr_tail?: string[]): TaskResult => {
    const elapsed_ms = Date.now() - start;
    try {
      ctx.recordOutcome?.(status, { started_at: start, ended_at: Date.now(), duration_ms: elapsed_ms, stderr_rate_limit_hits: 0 });
    } catch { /* ignore */ }
    const result: TaskResult = { status, elapsed_ms };
    if (stderr_tail) result.stderr_tail = stderr_tail;
    return result;
  };

  // F5: resolve base_branch from the candidate's OWN project_path (not an
  // ambient single value). Fall back to the legacy ambient baseBranch.
  const base = ctx.baseBranchFor?.(c.project_path) ?? ctx.baseBranch;
  // Guard: draft-impl requires a configured base_branch. Skip (failed) otherwise.
  if (!base) {
    process.stderr.write(`[draft-impl] skipping ${c.id}: no base_branch configured for ${c.project_path}\n`);
    return finalizeFail('failed', ['no base_branch configured for this project']);
  }
  const main = c.project_path;
  const branch = `prep/glean-${c.id}`;
  const slug = slugify(c);
  const worktree = join(ctx.gleanRoot, 'work', `${slug}-${c.id}`);

  // Provision the worktree. If it fails (e.g. bad base ref), skip cleanly.
  try {
    if (existsSync(worktree)) {
      // Stale leftover from a previous run — remove its registration first.
      try { execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' }); } catch { /* ignore */ }
      try { rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { execFileSync('git', ['-C', main, 'branch', '-D', branch], { stdio: 'ignore' }); } catch { /* branch may not exist */ }
    mkdirSync(join(ctx.gleanRoot, 'work'), { recursive: true });
    execFileSync('git', ['-C', main, 'worktree', 'add', worktree, '-b', branch, base], { stdio: 'pipe' });
  } catch (e) {
    process.stderr.write(`[draft-impl] worktree provisioning failed for ${c.id}: ${(e as Error).message}\n`);
    return finalizeFail('failed', [`worktree provisioning failed: ${(e as Error).message}`]);
  }

  // Render the prompt OUTSIDE the worktree (scratch dir) so it never gets
  // committed. Belt-and-braces: also exclude prompt.md via .git/info/exclude.
  const hydrated = hydrateEvidence(c, ctx);
  const templatePath = pickTemplate(c, ctx);
  const templateBody = readFileSync(templatePath, 'utf8');
  const prompt = render(templateBody, hydrated); // no OUT.md SAFETY_FOOTER for draft-impl
  const scratchDir = join(ctx.gleanRoot, 'work', '.glean-scratch', c.id);
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, 'prompt.md'), prompt);
  excludeFromWorktree(main, worktree, ['prompt.md', 'OUT.md']);

  // CRITICAL 1: pass a SCOPED Bash allow-list, never bare `Bash`. Bare `Bash`
  // would let the session run `git -C <main> push`, `rm -rf <main>`, or
  // `echo x > <main>/file` — none fully blockable by a prefix deny-list. The
  // allow-list (Edit/Write + git commit-cycle + per-project test command) is the
  // real boundary; DRAFT_IMPL_DENY stays as defense-in-depth.
  const allowedTools = draftImplAllowedTools(ctx.testCommandAllow ?? DEFAULT_TEST_COMMAND_ALLOW);
  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: worktree,
    addDir: worktree,
    deny: DRAFT_IMPL_DENY,
    allowedTools,
  });

  // Kill-mid-commit safety (T8/F7): a killed child may leave a stale index.lock
  // in the worktree, which would break the auto-commit/diff below. runClaude has
  // already awaited the descendant tree-kill, so the lock is provably orphaned
  // (spawn.descendantsDead) — clear it.
  clearStaleIndexLock(main, worktree, spawn.descendantsDead);

  // I4: a killed session (timeout / rate-limit) whose dirty tree we auto-commit
  // produces a SALVAGED partial, not a finished draft. We must not run/trust its
  // tests — a half-written change can pass or fail meaninglessly. Track it so the
  // test gate below records 'none'.
  const salvaged = spawn.rateLimited || spawn.timedOut;

  // F3: scope the auto-commit to the TODO's evidence file (+ new untracked
  // source), never blanket-stage tracked modifications.
  const evidenceFiles = c.evidence.kind === 'todo' ? [c.evidence.file] : [];
  if (spawn.rateLimited || spawn.timedOut) {
    // Even on interruption, try to salvage whatever was committed/edited.
    autoCommitIfDirty(worktree, evidenceFiles);
  } else if (spawn.exitCode === 0) {
    autoCommitIfDirty(worktree, evidenceFiles);
  }

  // Did anything land on the prep branch beyond base?
  const stat = diffStat(main, base, branch);

  const hasCommit = commitsBeyondBase(main, base, branch) > 0;

  // glean's OWN deterministic test check: only when a real, NON-salvaged commit
  // landed do we run the project's test_command IN the worktree and record
  // pass/fail/none. The spawned model also ran tests inside its session, but glean
  // can't see that result — so glean owns the surfaced status by running it itself.
  //
  // C1: clamp the test-run timeout to the REMAINING wall-clock budget (and SKIP
  // entirely if budget is exhausted or STOP is set) so a draft committing near
  // budget-end can't overrun `--budget`. I4: skip for salvaged partials.
  // Never let a test run throw out of the executor (runTestCommand catches → 'none').
  const remainingBudgetMs = ctx.remainingBudgetMs;       // undefined ⇒ unbounded
  const stopSet = ctx.stopRequested?.() ?? false;
  const skipTests =
    !hasCommit ||
    salvaged ||
    stopSet ||
    (remainingBudgetMs !== undefined && remainingBudgetMs <= 0);
  const tests: DraftTestStatus = skipTests
    ? 'none'
    : runTestCommand(ctx.testCommandFor?.(c.project_path), worktree, ctx.taskTimeoutMs, remainingBudgetMs);

  // C2: recompute elapsed AFTER the test run so the recorded per-task duration
  // includes the time glean spent running tests (the old position excluded it).
  const elapsed_ms = Date.now() - start;

  const finalize = (status: TaskResult['status'], output: TaskOutput | undefined, stderr_tail?: string[]): TaskResult => {
    try {
      ctx.recordOutcome?.(status, {
        started_at: start, ended_at: Date.now(), duration_ms: elapsed_ms,
        stderr_rate_limit_hits: spawn.rateLimited ? 1 : 0,
        draft_files: stat?.files, draft_insertions: stat?.insertions, draft_deletions: stat?.deletions,
        prep_branch: output?.kind === 'branch' ? output.branch : undefined,
        draft_tests: output?.kind === 'branch' ? output.tests : undefined,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`);
    }
    const result: TaskResult = { status, elapsed_ms };
    if (output) result.output = output;
    if (stderr_tail) result.stderr_tail = stderr_tail;
    // v0.8: surface the classified rate-limit signal (drain wrapper consumes it).
    if (status === 'rate-limit') result.classification = classifySpawnSignal(spawn);
    return result;
  };

  // F4: a real commit whose diff stat could not be read is NOT a clean success.
  // Coercing a null stat into a 0-file 'ok' would hide a measurement failure and
  // mislead the receipt. Treat (commit present, stat unreadable) as a failure so
  // status reflects reality; the worktree is kept for manual inspection.
  const statUnreadable = hasCommit && stat === null;
  if (spawn.rateLimited) {
    return hasCommit && !statUnreadable
      ? finalize('rate-limit', branchOutput(branch, base, worktree, stat, tests))
      : finalize('rate-limit', undefined);
  }
  if (spawn.timedOut) {
    return hasCommit && !statUnreadable
      ? finalize('timeout', branchOutput(branch, base, worktree, stat, tests))
      : finalize('timeout', undefined);
  }
  if (statUnreadable) {
    return finalize('failed', undefined, ['draft-impl: commit landed but diff stat was unreadable']);
  }
  if (hasCommit) {
    return finalize('ok', branchOutput(branch, base, worktree, stat, tests));
  }
  // Nothing committed and tree clean → failed, keep the worktree for inspection.
  const tail = (() => { try { return tailLines(readFileSync(spawn.stderrPath, 'utf8'), 20); } catch { return undefined; } })();
  return finalize('failed', undefined, tail);
}

function branchOutput(branch: string, base: string, worktree: string, stat: DiffStat | null, tests: DraftTestStatus): TaskOutput {
  return {
    kind: 'branch', branch, base, worktree,
    files: stat?.files ?? 0, insertions: stat?.insertions ?? 0, deletions: stat?.deletions ?? 0,
    tests,
  };
}

// Run the project's per-project `test_command` INSIDE the draft worktree to
// capture a deterministic pass/fail. This is glean's OWN check — the spawned
// `claude -p` session also runs tests, but its result is invisible to glean, so
// glean re-runs and owns the surfaced status.
//
// Status mapping (HEURISTIC — the only fully trustworthy signal is exit 0 → pass):
//   exit 0                                   → 'pass'
//   non-zero + env/setup-failure signature   → 'none'  (couldn't run cleanly)
//   non-zero otherwise                       → 'fail'  (a suite that ran + failed)
//   no command                               → 'none'
//   unrunnable first token / throw / timeout → 'none'  (NEVER crash the executor)
//
// I3 rationale: a fresh `git worktree` has no node_modules, so a real project's
// `npm test` exits nonzero with "Cannot find module" / "missing script" — that is
// an ENVIRONMENT failure (the suite never ran), NOT a genuine test failure. We
// inspect combined stdout/stderr for known setup-failure signatures and map those
// to 'none' so a bare worktree is never misreported as 'fail'. This is a best-
// effort heuristic; exit 0 → pass remains the clean, unambiguous signal.
//
// C1: `remainingBudgetMs` (when provided) clamps the run timeout so the test run
// can never exceed the run's remaining wall-clock `--budget`. The actual timeout
// is min(TEST_RUN_CAP_MS, taskTimeoutMs, remainingBudgetMs). The caller already
// SKIPS this function when remaining budget <= 0 or STOP is set.
const TEST_RUN_CAP_MS = 5 * 60_000;

// Case-insensitive substrings that indicate the test runner could not start
// (environment/setup failure), as opposed to a suite that ran and reported
// failures. Covers the common Node / shell / runner cases on both platforms.
const ENV_FAILURE_SIGNATURES = [
  'cannot find module',
  'module not found',
  'command not found',
  'is not recognized as an internal or external command', // Windows cmd.exe
  'enoent',
  'no test files found',
  'no tests found',
  'missing script',
  'cannot find package',
];

function looksLikeEnvFailure(output: string): boolean {
  const hay = output.toLowerCase();
  return ENV_FAILURE_SIGNATURES.some((sig) => hay.includes(sig));
}

function runTestCommand(
  testCommand: string | undefined,
  worktree: string,
  taskTimeoutMs: number,
  remainingBudgetMs?: number,
): DraftTestStatus {
  const cmd = testCommand?.trim();
  if (!cmd) return 'none';
  // Distinguish "test_command is not runnable on this machine" from "tests
  // failed": under `shell: true` a missing program returns exit 1 (cmd.exe /
  // sh), indistinguishable from a real failure by exit code alone. So resolve
  // the FIRST token (the program) on PATH first — if it isn't resolvable, this
  // is 'none' (not run), never 'fail'.
  if (!isProgramRunnable(firstToken(cmd))) return 'none';
  try {
    // C1: the test-run timeout is bounded by ALL of: the 5-min cap, the per-task
    // timeout, and the run's remaining wall-clock budget — so it can never push
    // the run past `--budget`.
    const bounds = [TEST_RUN_CAP_MS];
    if (taskTimeoutMs > 0) bounds.push(taskTimeoutMs);
    if (remainingBudgetMs !== undefined && remainingBudgetMs > 0) bounds.push(remainingBudgetMs);
    const timeout = Math.min(...bounds);
    const res = spawnSync(cmd, {
      cwd: worktree,
      shell: true,           // resolve PATH + allow "npm test"-style commands
      timeout,
      encoding: 'utf8',      // capture stdout/stderr to classify env-vs-real failures (I3)
      windowsHide: true,
    });
    // spawnSync sets .error on spawn failure (ENOENT) or timeout (ETIMEDOUT).
    if (res.error) return 'none';
    // A killed/timed-out child has signal set and status null → treat as 'none'.
    if (res.status === null) return 'none';
    if (res.status === 0) return 'pass';
    // I3: non-zero — distinguish "couldn't run" (env/setup) from "ran + failed".
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    return looksLikeEnvFailure(combined) ? 'none' : 'fail';
  } catch {
    return 'none';
  }
}

// First token of a command line (the program name), RESPECTING a leading
// double-quoted span so a quoted path containing spaces — e.g.
// `"C:\Program Files\nodejs\node.exe" test` — resolves as ONE token, not the
// truncated `"C:\Program` (I1). A bare (unquoted) first token splits on the
// first whitespace as before.
function firstToken(cmd: string): string {
  const s = cmd.trimStart();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end > 0) return s.slice(1, end);
    return s.slice(1); // unterminated quote — best effort
  }
  return s.split(/\s+/)[0] ?? '';
}

// True if `program` resolves to an executable on PATH (where/which) OR is an
// explicit path to an existing file. Used to map an unrunnable test_command to
// 'none' rather than a misleading 'fail'.
//
// I1: a quoted-path test_command resolves to an ABSOLUTE/RELATIVE program path
// (e.g. "C:\Program Files\nodejs\node.exe"). `where`/`which` only resolve bare
// names on PATH — handed a full path they fail — so we first short-circuit on an
// existing file at that path before falling back to the PATH finder.
function isProgramRunnable(program: string): boolean {
  if (!program) return false;
  // Explicit path to an existing file (covers quoted absolute/relative paths).
  if (/[\\/]/.test(program)) {
    try { if (existsSync(program)) return true; } catch { /* fall through */ }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

type DiffStat = { files: number; insertions: number; deletions: number };

// F4: use TWO-dot `base..branch` (branch-relative: what the prep branch added
// beyond base) for BOTH the diff stat and the commit count, so they answer the
// same "did anything land on the prep branch" question. Three-dot (symmetric)
// would fold in base-only changes when base has advanced past the branch point.
// All linked worktrees share one object store, so reading from the main dir
// works regardless of where the worktree lives (Windows-safe).
function diffStatImpl(main: string, base: string, branch: string): DiffStat | null {
  try {
    const out = execFileSync('git', ['-C', main, 'diff', '--numstat', `${base}..${branch}`], { encoding: 'utf8' });
    let files = 0, insertions = 0, deletions = 0;
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ins, del] = line.split('\t');
      files++;
      insertions += Number(ins) || 0;
      deletions += Number(del) || 0;
    }
    return { files, insertions, deletions };
  } catch { return null; }
}

// Injectable wrappers so tests can force a parse failure (null stat) and verify
// it is surfaced rather than coerced into a clean 0-file success.
function diffStat(main: string, base: string, branch: string): DiffStat | null {
  return diffStat.impl(main, base, branch);
}
diffStat.impl = diffStatImpl;

function commitsBeyondBaseImpl(main: string, base: string, branch: string): number {
  try {
    const out = execFileSync('git', ['-C', main, 'rev-list', '--count', `${base}..${branch}`], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}
function commitsBeyondBase(main: string, base: string, branch: string): number {
  return commitsBeyondBase.impl(main, base, branch);
}
commitsBeyondBase.impl = commitsBeyondBaseImpl;

// Test-only handles (prefixed __ to signal "do not use in production code").
export const __diffStat = diffStat;
export const __commitsBeyondBase = commitsBeyondBase;
export const __clearStaleIndexLock = clearStaleIndexLock;

// Auto-commit fallback for when the session edited but did not commit.
//
// F3: we deliberately do NOT blanket-stage tracked modifications (`git add -u`).
// A test run inside the worktree can rewrite a TRACKED snapshot/lockfile that is
// unrelated to the TODO; `git add -u` would silently land it in the user's draft.
// Instead we scope staging to:
//   - the evidence file(s) for the TODO (the file the model was asked to change), and
//   - new (untracked) non-ignored source files the model created (honors
//     .gitignore + our .git/info/exclude, so prompt.md/OUT.md and coverage/dist
//     stay out).
// Other tracked files the model deliberately touched are still picked up: the
// model is instructed to `git add` them itself, and any it staged before the
// kill survive (we never `git reset`). This keeps the auto-commit set explicit —
// no unrelated or secret file lands silently. Best-effort: clean tree is a no-op.
function autoCommitIfDirty(worktree: string, evidenceFiles: string[]): void {
  try {
    const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
    if (!status.trim()) return;
    // Stage the evidence file(s) the model was asked to change (if present/dirty).
    for (const f of evidenceFiles) {
      if (!f) continue;
      try { execFileSync('git', ['-C', worktree, 'add', '--', f], { stdio: 'ignore' }); } catch { /* missing/clean */ }
    }
    // Stage untracked-but-not-ignored files explicitly (new source the model
    // created). --others --exclude-standard filters .gitignore + info/exclude.
    const untracked = execFileSync(
      'git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'],
      { encoding: 'utf8' },
    ).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const f of untracked) {
      execFileSync('git', ['-C', worktree, 'add', '--', f], { stdio: 'ignore' });
    }
    // If after staging there is nothing, skip the commit.
    const staged = execFileSync('git', ['-C', worktree, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    if (!staged.trim()) return;
    execFileSync('git', ['-C', worktree, '-c', 'user.email=glean@local', '-c', 'user.name=glean', 'commit', '-m', 'glean: draft (review)'], { stdio: 'ignore' });
  } catch { /* best effort */ }
}

// Add glean scratch filenames to the worktree's .git/info/exclude so an
// auto-commit `git add` never sweeps them into the user's draft branch.
function excludeFromWorktree(main: string, worktree: string, patterns: string[]): void {
  try {
    // --path-format=absolute returns the resolved path directly; joining the
    // worktree to a (Windows-)absolute --git-path result yields a garbage path.
    const excludePath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim();
    if (!excludePath) return;
    let existing = '';
    try { existing = readFileSync(excludePath, 'utf8'); } catch { /* new file */ }
    const toAdd = patterns.filter((p) => !existing.includes(p));
    if (toAdd.length) {
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + toAdd.join('\n') + '\n');
    }
  } catch { /* best effort */ }
}

// T8/F7: remove a STALE index.lock left by a killed/exited child so the
// auto-commit/diff steps don't fail with "Another git process seems to be
// running".
//
// F7 — DO NOT delete a lock a live process still holds. The real guarantee is
// the caller's precondition: runClaude has already awaited spawnInJob.kill()
// (descendant tree-kill complete) AND job.exit, so by the time this runs the
// entire spawned process tree is dead — any surviving lock is provably orphaned.
// That is a stronger, non-racy signal than a wall-clock age heuristic, which is
// why we gate on `descendantsDead` rather than guessing from mtime. We still log
// the lock age for diagnostics.
function clearStaleIndexLock(main: string, worktree: string, descendantsDead: boolean): void {
  if (!descendantsDead) return; // never touch a lock while a holder may be alive
  try {
    // --path-format=absolute makes the returned path unambiguous; git -C runs in
    // the worktree so this resolves to the linked worktree's own index.lock.
    const lockPath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
      { encoding: 'utf8' },
    ).trim();
    if (!lockPath || !existsSync(lockPath)) return;
    let ageMs = Infinity;
    try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch { /* unknown age */ }
    rmSync(lockPath, { force: true });
    process.stderr.write(`[draft-impl] cleared stale index.lock in ${worktree} (age ${Number.isFinite(ageMs) ? Math.round(ageMs) + 'ms' : 'unknown'})\n`);
  } catch { /* best effort */ }
}

// ── Shared spawn helper ─────────────────────────────────────────────────────
async function runClaude(
  c: Candidate,
  ctx: ExecCtx,
  opts: { prompt: string; cwd: string; addDir: string | string[]; deny: string; allowedTools?: string },
): Promise<SpawnOutcome> {
  const logDir = join(ctx.gleanRoot, 'logs', ctx.runId);
  mkdirSync(logDir, { recursive: true });
  const stderrPath = join(logDir, `${c.id}.stderr`);
  const jsonlPath = join(logDir, `${c.id}.jsonl`);
  const stderrStream = createWriteStream(stderrPath);
  const jsonlStream = createWriteStream(jsonlPath);
  let rateLimited = false;
  // Bounded in-memory tail of stderr — classified for the rate-limit signal so we
  // never depend on the async file flush completing before we read it back.
  let stderrText = '';

  // Pass prompt via stdin to avoid Windows command-line length limits (~8191 chars).
  // --verbose is required for --output-format stream-json in -p (print) mode.
  // One --add-dir per granted read dir. research-dossier grants BOTH its output
  // dir AND the candidate's project_path (ADR-0002 A1: claude -p honors variadic
  // --add-dir for non-interactive read access).
  const addDirs = Array.isArray(opts.addDir) ? opts.addDir : [opts.addDir];
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--permission-mode', 'acceptEdits',
  ];
  // draft-impl is the first path that runs Bash (git commit, tests); pass explicit
  // --allowedTools so a headless -p run does not hang on an interactive approval.
  if (opts.allowedTools) claudeArgs.push('--allowedTools', opts.allowedTools);
  claudeArgs.push('--disallowedTools', opts.deny);
  claudeArgs.push('--session-id', uuid());

  // On Windows, .cmd files must be invoked via cmd.exe /c
  const [spawnCmd, spawnArgs] = resolveSpawn(ctx.claudeBin, claudeArgs);
  const job = spawnInJob(spawnCmd, spawnArgs, { cwd: opts.cwd, env: ctx.env, stdio: 'pipe' });

  if (job.child.stdin) {
    job.child.stdin.write(opts.prompt, 'utf8');
    job.child.stdin.end();
  }

  // Track every kill so we can await full descendant termination before any
  // post-spawn cleanup touches the worktree (F7).
  const kills: Promise<void>[] = [];

  // ADR-0003: live scan of the stream-json stdout for the STRUCTURED block
  // (rate_limit_event status "rejected" / result is_error+429 / message
  // error:"rate_limit" — the verified session-block shape). Line-buffered via a
  // StringDecoder so multi-byte UTF-8 split across chunks can't mangle a line;
  // signal-bearing lines are kept in memory (bounded) for classification so it
  // never depends on the async .jsonl flush.
  const stdoutDecoder = new StringDecoder('utf8');
  let stdoutBuf = '';
  let streamSignalText = '';
  const scanStdoutLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Cheap pre-filter mirroring classifyStreamJson: only consider lines that
    // could carry a rate-limit signal.
    if (!trimmed.includes('rate_limit') && !trimmed.includes('"is_error":true')) return;
    streamSignalText = (streamSignalText + trimmed + '\n').slice(-STREAM_SIGNAL_BYTES);
    if (!rateLimited && isStreamBlockLine(trimmed)) {
      rateLimited = true;
      // No kill needed once the child has already exited (the final-line scan).
      if (!exited) kills.push(job.kill());
    }
  };

  job.child.stdout?.on('data', (chunk: Buffer) => {
    jsonlStream.write(chunk);
    stdoutBuf += stdoutDecoder.write(chunk);
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      scanStdoutLine(stdoutBuf.slice(0, nl));
      stdoutBuf = stdoutBuf.slice(nl + 1);
    }
    // Bound a pathological no-newline stream; a truncated line later fails the
    // JSON parse harmlessly (the full stream is on disk regardless).
    if (stdoutBuf.length > STDOUT_LINE_BUF_MAX) stdoutBuf = stdoutBuf.slice(-STDOUT_LINE_BUF_MAX);
  });
  job.child.stderr?.on('data', (chunk: Buffer) => {
    stderrStream.write(chunk);
    stderrText = (stderrText + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    if (!rateLimited && RATE_LIMIT_RE.test(chunk.toString('utf8'))) {
      rateLimited = true;
      kills.push(job.kill());
    }
  });

  let timedOut = false;
  let exited = false;
  const timer = setTimeout(() => { timedOut = true; kills.push(job.kill()); }, ctx.taskTimeoutMs);

  let exitCode: number;
  try {
    exitCode = await job.exit;
  } finally {
    exited = true;
    clearTimeout(timer);
  }

  // F7: if we killed the job, wait for the tree-kill of all descendants to
  // finish so no live grandchild git can still hold the worktree's index.lock
  // when the caller proceeds to clear it.
  if (kills.length > 0) {
    try { await Promise.all(kills); } catch { /* best effort */ }
  }

  // Flush the decoder + scan any final line that arrived without a trailing
  // newline, so a block signal on the very last stream line is never missed.
  scanStdoutLine(stdoutBuf + stdoutDecoder.end());

  stderrStream.end();
  jsonlStream.end();

  // We reach here only after job.exit resolved and (above) all kills were
  // awaited, so the spawned process tree is fully dead.
  const outcome: SpawnOutcome = { exitCode, rateLimited, timedOut, stderrPath, stderrText, streamSignalText, jsonlPath, descendantsDead: true };

  // ADR-0003 self-capturing tripwire: each spawn flagged rateLimited writes its
  // OWN capture file (keyed by task id `<id>.BLOCK-CAPTURE.txt`), so the
  // never-yet-observed real block shape captures itself the first time it ever
  // happens. Per-task (not once-global) — distinct task ids never collide.
  // Best-effort, never throws.
  if (rateLimited) captureBlockSignal(c.id, logDir, outcome);

  return outcome;
}

const SAFETY_FOOTER = '\n\nspeculative — produce a draft, never push, write findings to `OUT.md` in the current working directory.\n';

function pickTemplate(c: Candidate, ctx: ExecCtx): string {
  const userDir = join(ctx.gleanRoot, 'templates');
  const name = c.type === 'research-dossier' ? 'research-dossier.md'
    : c.type === 'draft-impl' ? 'draft-impl.md'
    : 'fetch-docs.md';
  const userPath = join(userDir, name);
  if (existsSync(userPath)) return userPath;
  return join(ctx.templatesDir, name);
}

function hydrateEvidence(c: Candidate, _ctx: ExecCtx): Candidate {
  const cloned: Candidate = JSON.parse(JSON.stringify(c));
  // Compute a title for the template
  (cloned as Candidate & { title?: string }).title = titleFor(cloned);
  if (cloned.evidence.kind === 'todo') {
    try {
      const lines = readFileSync(join(cloned.project_path, cloned.evidence.file), 'utf8').split(/\r?\n/);
      const first = cloned.evidence.todo_lines[0]?.line ?? 1;
      const from = Math.max(0, first - 100);
      const to = Math.min(lines.length, first + 100);
      cloned.evidence.file_excerpt = lines.slice(from, to).slice(0, 200).join('\n');
    } catch { /* leave undefined */ }
  }
  if (cloned.evidence.kind === 'jsonl') {
    // Reading the actual session file is optional; leave empty for MVP if unavailable
    cloned.evidence.recent_turns = [];
  }
  return cloned;
}

function slugify(c: Candidate): string {
  const base = titleFor(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (c.evidence.kind === 'todo') {
    const line = c.evidence.todo_lines[0]?.line ?? 0;
    return `${base}-L${line}`;
  }
  return base;
}

function tailLines(s: string, n: number): string[] {
  const lines = s.split(/\r?\n/);
  return lines.slice(-n);
}

function findFirstFile(dir: string, re: RegExp): string | undefined {
  try {
    const f = readdirSync(dir).find((n) => re.test(n));
    return f ? join(dir, f) : undefined;
  } catch { return undefined; }
}

/**
 * On Windows, .cmd files cannot be spawned directly — they must be run through cmd.exe.
 * Returns [command, args] suitable for spawnInJob.
 */
function resolveSpawn(bin: string, args: string[]): [string, string[]] {
  if (process.platform === 'win32') {
    // On Windows, bare command names like "claude" resolve to "claude.cmd"
    // in npm-global dirs. .cmd files must be invoked via cmd.exe /c.
    if (bin.toLowerCase().endsWith('.cmd')) {
      return ['cmd', ['/c', bin, ...args]];
    }
    // If the bin has no extension, probe for a .cmd variant on PATH.
    // This handles config { claude_bin: "claude" } on Windows where only
    // claude.cmd is executable by CreateProcess.
    if (!bin.includes('.')) {
      try {
        const cmdPath = execFileSync('where', [bin + '.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        if (cmdPath) return ['cmd', ['/c', cmdPath, ...args]];
      } catch { /* no .cmd found on PATH, fall through */ }
    }
  }
  return [bin, args];
}
