import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, createWriteStream, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, TaskResult, TaskOutput } from './types.js';
import { spawnInJob } from './jobobject.js';
import { render } from './render.js';
import { extractLastAssistantText } from './jsonl-extract.js';
import { projectSlug } from './state.js';
import { titleFor, today } from './candidate-meta.js';
import { BASE_DENY, DRAFT_IMPL_DENY } from './deny.js';

const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit)/i;

export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  // Per-project base branch (from config.json projects[path].base_branch).
  // Required for draft-impl; if absent, draft-impl candidates are skipped.
  baseBranch?: string;
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
  }) => void;
};

// Result of a single claude -p spawn (shared by both task paths).
type SpawnOutcome = {
  exitCode: number;
  rateLimited: boolean;
  timedOut: boolean;
  stderrPath: string;
  jsonlPath: string;
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

  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: workDir,
    addDir: workDir,
    deny: BASE_DENY,
    allowedTools: undefined,
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
    return result;
  };

  if (spawn.rateLimited) return finalize('rate-limit', undefined, undefined);
  if (spawn.timedOut) return finalize('timeout', undefined, undefined);
  if (spawn.exitCode !== 0) {
    const tail = tailLines(readFileSync(spawn.stderrPath, 'utf8'), 50);
    return finalize('failed', undefined, tail);
  }

  // Look for output
  const outPath = c.type === 'research-dossier' ? join(workDir, 'OUT.md') : findFirstFile(workDir, /\.md$/);
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

  // Guard: draft-impl requires a configured base_branch. Skip (failed) otherwise.
  if (!ctx.baseBranch) {
    process.stderr.write(`[draft-impl] skipping ${c.id}: no base_branch configured for ${c.project_path}\n`);
    return finalizeFail('failed', ['no base_branch configured for this project']);
  }
  const base = ctx.baseBranch;
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

  const spawn = await runClaude(c, ctx, {
    prompt,
    cwd: worktree,
    addDir: worktree,
    deny: DRAFT_IMPL_DENY,
    allowedTools: 'Bash Edit Write',
  });

  // Kill-mid-commit safety (T8): a killed child may leave a stale index.lock in
  // the worktree, which would break the auto-commit/diff below. Clear it.
  clearStaleIndexLock(main, worktree);

  const elapsed_ms = Date.now() - start;

  if (spawn.rateLimited || spawn.timedOut) {
    // Even on interruption, try to salvage whatever was committed/edited.
    autoCommitIfDirty(worktree);
  } else if (spawn.exitCode === 0) {
    autoCommitIfDirty(worktree);
  }

  // Did anything land on the prep branch beyond base?
  const stat = diffStat(main, base, branch);
  const finalize = (status: TaskResult['status'], output: TaskOutput | undefined, stderr_tail?: string[]): TaskResult => {
    try {
      ctx.recordOutcome?.(status, {
        started_at: start, ended_at: Date.now(), duration_ms: elapsed_ms,
        stderr_rate_limit_hits: spawn.rateLimited ? 1 : 0,
        draft_files: stat?.files, draft_insertions: stat?.insertions, draft_deletions: stat?.deletions,
        prep_branch: output?.kind === 'branch' ? output.branch : undefined,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`);
    }
    const result: TaskResult = { status, elapsed_ms };
    if (output) result.output = output;
    if (stderr_tail) result.stderr_tail = stderr_tail;
    return result;
  };

  const hasCommit = commitsBeyondBase(main, base, branch) > 0;
  if (spawn.rateLimited) {
    return hasCommit
      ? finalize('rate-limit', branchOutput(branch, base, worktree, stat))
      : finalize('rate-limit', undefined);
  }
  if (spawn.timedOut) {
    return hasCommit
      ? finalize('timeout', branchOutput(branch, base, worktree, stat))
      : finalize('timeout', undefined);
  }
  if (hasCommit) {
    return finalize('ok', branchOutput(branch, base, worktree, stat));
  }
  // Nothing committed and tree clean → failed, keep the worktree for inspection.
  const tail = (() => { try { return tailLines(readFileSync(spawn.stderrPath, 'utf8'), 20); } catch { return undefined; } })();
  return finalize('failed', undefined, tail);
}

function branchOutput(branch: string, base: string, worktree: string, stat: DiffStat | null): TaskOutput {
  return {
    kind: 'branch', branch, base, worktree,
    files: stat?.files ?? 0, insertions: stat?.insertions ?? 0, deletions: stat?.deletions ?? 0,
  };
}

type DiffStat = { files: number; insertions: number; deletions: number };

// git -C <main> diff --stat <base>...<branch>. All linked worktrees share one
// object store so this reads correctly from the main dir regardless of where
// the worktree lives (works on Windows).
function diffStat(main: string, base: string, branch: string): DiffStat | null {
  try {
    const out = execFileSync('git', ['-C', main, 'diff', '--numstat', `${base}...${branch}`], { encoding: 'utf8' });
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

function commitsBeyondBase(main: string, base: string, branch: string): number {
  try {
    const out = execFileSync('git', ['-C', main, 'rev-list', '--count', `${base}..${branch}`], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

// Auto-commit fallback for when the session edited but did not commit. Stages:
//   - all tracked modifications/deletions (`git add -u`), plus
//   - new source files the model created, EXCLUDING anything the project's
//     .gitignore or our .git/info/exclude (prompt.md/OUT.md, see
//     excludeFromWorktree) ignores.
// We deliberately avoid a blanket `git add -A`: a test run inside the worktree
// can leave non-gitignored stray dirs (coverage/, dist/) that should not pollute
// the draft. Untracked files are enumerated and added by name so the staged set
// is explicit. Best-effort: a clean tree is a no-op.
function autoCommitIfDirty(worktree: string): void {
  try {
    const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
    if (!status.trim()) return;
    // Stage tracked modifications/deletions.
    execFileSync('git', ['-C', worktree, 'add', '-u'], { stdio: 'ignore' });
    // Stage untracked-but-not-ignored files explicitly (honors .gitignore +
    // .git/info/exclude because --others --exclude-standard filters them out).
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

// T8: remove a stale index.lock left by a killed child so the auto-commit/diff
// steps don't fail with "Another git process seems to be running".
function clearStaleIndexLock(main: string, worktree: string): void {
  try {
    // --path-format=absolute makes the returned path unambiguous; git -C runs in
    // the worktree so this resolves to the linked worktree's own index.lock.
    const lockPath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
      { encoding: 'utf8' },
    ).trim();
    if (lockPath && existsSync(lockPath)) {
      rmSync(lockPath, { force: true });
      process.stderr.write(`[draft-impl] cleared stale index.lock in ${worktree}\n`);
    }
  } catch { /* best effort */ }
}

// ── Shared spawn helper ─────────────────────────────────────────────────────
async function runClaude(
  c: Candidate,
  ctx: ExecCtx,
  opts: { prompt: string; cwd: string; addDir: string; deny: string; allowedTools?: string },
): Promise<SpawnOutcome> {
  const logDir = join(ctx.gleanRoot, 'logs', ctx.runId);
  mkdirSync(logDir, { recursive: true });
  const stderrPath = join(logDir, `${c.id}.stderr`);
  const jsonlPath = join(logDir, `${c.id}.jsonl`);
  const stderrStream = createWriteStream(stderrPath);
  const jsonlStream = createWriteStream(jsonlPath);
  let rateLimited = false;

  // Pass prompt via stdin to avoid Windows command-line length limits (~8191 chars).
  // --verbose is required for --output-format stream-json in -p (print) mode.
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir', opts.addDir,
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

  job.child.stdout?.on('data', (chunk: Buffer) => jsonlStream.write(chunk));
  job.child.stderr?.on('data', (chunk: Buffer) => {
    stderrStream.write(chunk);
    if (!rateLimited && RATE_LIMIT_RE.test(chunk.toString('utf8'))) {
      rateLimited = true;
      job.kill();
    }
  });

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

  return { exitCode, rateLimited, timedOut, stderrPath, jsonlPath };
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
