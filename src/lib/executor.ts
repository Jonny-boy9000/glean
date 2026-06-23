import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Candidate, TaskResult, TaskOutput, DraftTestStatus } from './types.js';
import { render } from './render.js';
import { extractLastAssistantText } from './jsonl-extract.js';
import { projectSlug } from './state.js';
import { titleFor, today } from './candidate-meta.js';
import { BASE_DENY, DRAFT_IMPL_DENY, draftImplAllowedTools, researchAllowedTools, DEFAULT_TEST_COMMAND_ALLOW } from './deny.js';
import { buildSandboxSettings } from './sandbox.js';
import type { ModelRoutingConfig, PaceTier } from './model-routing.js';
import { runClaude, classifySpawnSignal } from './spawn-claude.js';
import {
  diffStat, commitsBeyondBase, autoCommitIfDirty, excludeFromWorktree, clearStaleIndexLock,
  type DiffStat,
} from './draft-git.js';
import { runTestCommand } from './draft-test.js';

// F7 split (behavior-preserving): the claude -p spawn state machine + rate-limit
// signal glue live in spawn-claude.ts; git diff/commit/index-lock plumbing in
// draft-git.ts; the post-commit test runner in draft-test.ts. The __-prefixed
// test handles are re-exported below so existing test imports from ./executor.js
// keep resolving unchanged.
export { __nowMs } from './spawn-claude.js';
export { __diffStat, __commitsBeyondBase, __clearStaleIndexLock } from './draft-git.js';

export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  // ADR-0004: bounded grace after a kill is issued. If the child has not exited
  // within this many ms of the kill, the executor force-resolves (status
  // preserved, descendants treated as possibly alive) instead of waiting
  // forever on a process the kill failed to terminate. Absent → 5s default.
  killGraceMs?: number;
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
  // v0.9 model routing (ADR-0006): the config slice (models / max_turns /
  // pacing_promote) consumed by resolveModel/resolveMaxTurns. Absent → built-in
  // defaults (pool-aware 'sonnet' base; fetch-docs haiku).
  routing?: ModelRoutingConfig;
  // v0.9 pacing hook (wave-2 ready): optional pace tier threaded from
  // PipelineOpts. Absent → 'normal'. The REAL tier arrives with the pacing
  // engine (feat/usage-pacing); nothing here imports from it.
  paceTier?: PaceTier;
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
  // ADR-0013: resolved posture === 'enforce' (config.enforce_spawn set AND the OS
  // sandbox is available — mac/Linux/WSL2). When true, draft-impl/research spawns get
  // an inline `--settings` OS sandbox. Resolved once per run in cli.ts
  // (detectSandboxAvailability + resolveSpawnPosture). Absent → Narrow (the default,
  // and the only option on native Windows).
  enforceSpawn?: boolean;
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
  const workDir = c.type === 'research-dossier'
    ? uniqueResearchDir(dossierDir, slug, c.id)
    : join(dossierDir, 'docs');
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
  // ADR-0013: under enforce_spawn (sandbox available) confine this spawn's writes to
  // its output dir and deny-read $HOME secrets; research also re-allows reading the
  // project it researches. Undefined on Narrow/strict/Windows → argv byte-identical.
  const settings = ctx.enforceSpawn
    ? buildSandboxSettings({ writeRoot: workDir, readScopes: isResearch ? [c.project_path] : undefined })
    : undefined;
  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: workDir,
    addDir: isResearch ? [workDir, c.project_path] : workDir,
    deny: BASE_DENY,
    allowedTools: isResearch ? researchAllowedTools() : undefined,
    settings,
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
    // ADR-0009: flag an auth failure so the pipeline can stop the run cleanly.
    if (spawn.authError) result.authExpired = true;
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
    // ADR-0009 defense-in-depth: neuter git hooks in the disposable draft worktree
    // so an allow-listed `git commit` in the spawned session can't fire a repo
    // pre-commit / commit-msg hook (arbitrary code that would run OUTSIDE the
    // permission layer). Point core.hooksPath at an empty dir; best-effort.
    try {
      const noHooks = join(ctx.gleanRoot, 'work', '.glean-nohooks');
      mkdirSync(noHooks, { recursive: true });
      execFileSync('git', ['-C', worktree, 'config', 'core.hooksPath', noHooks], { stdio: 'ignore' });
    } catch { /* best effort — hook-neutering is defense-in-depth */ }
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

  // CRITICAL 1 / ADR-0009: pass a SCOPED Bash allow-list, never bare `Bash`. The
  // allow-list bounds WHICH tools the model can call (no bare `Bash` → no
  // `git -C <main> push` / `rm -rf <main>`); built-in Edit/Write are bounded to
  // this worktree via --add-dir. The one residual code-execution surface is the
  // test-command verb set (a runner spawns a subprocess outside the permission
  // layer) — narrowed to declared runners by default, removed entirely by
  // config.strict_spawn (ctx.testCommandAllow is already [] then; see cli.ts).
  // DRAFT_IMPL_DENY stays as in-session defense-in-depth.
  const allowedTools = draftImplAllowedTools(ctx.testCommandAllow ?? DEFAULT_TEST_COMMAND_ALLOW);
  // ADR-0013: under enforce_spawn (sandbox available) confine writes to the worktree
  // and deny-read $HOME secrets + the user's MAIN checkout (so the draft can't peek at
  // uncommitted main work). The sandbox auto-allows the shared .git refs/index but
  // keeps .git/hooks denied — complementing the hook-neuter above. Undefined on
  // Narrow/strict/Windows → argv byte-identical.
  const settings = ctx.enforceSpawn
    ? buildSandboxSettings({ writeRoot: worktree, denyReadExtra: [main] })
    : undefined;
  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: worktree,
    addDir: worktree,
    deny: DRAFT_IMPL_DENY,
    allowedTools,
    settings,
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
    // ADR-0009: flag an auth failure so the pipeline can stop the run cleanly.
    if (spawn.authError) result.authExpired = true;
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

// 2026-06-12 data-loss fix (run 2026-06-12-2109-f8628b): three same-day
// research-dossier tasks whose titles slugified identically (all blank) resolved
// to the SAME `research-` dir, and each task silently overwrote the previous
// task's OUT.md. The dossier dir must be unique PER TASK: keep the readable slug,
// but append the first 8 chars of the task id when the slug is empty OR the dir
// already exists (same-run collision or a leftover from an earlier run today).
// An existing OUT.md from a different task is therefore never overwritten.
function uniqueResearchDir(dossierDir: string, slug: string, taskId: string): string {
  const idSuffix = taskId.slice(0, 8);
  if (!slug) return join(dossierDir, `research-${idSuffix}`);
  const preferred = join(dossierDir, `research-${slug}`);
  if (!existsSync(preferred)) return preferred;
  return join(dossierDir, `research-${slug}-${idSuffix}`);
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
