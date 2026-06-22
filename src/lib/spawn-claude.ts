import { mkdirSync, writeFileSync, readFileSync, createWriteStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Candidate } from './types.js';
import { spawnInJob } from './jobobject.js';
import { StringDecoder } from 'node:string_decoder';
import { classifyRateLimit, classifyStreamJson, isStreamBlockLine, parseRateLimitEventResetAt, RATE_LIMIT_RE, AUTH_ERROR_RE, isStreamAuthErrorLine, type RateLimitClassification } from './classify.js';
import { resolveModel, resolveMaxTurns, type ModelRoutingConfig, type PaceTier } from './model-routing.js';

// ADR-0003: the REAL `claude -p` block (session limit, captured 2026-06-11) is a
// STRUCTURED stream-json signal on stdout — see classify.ts:isStreamBlockLine —
// and that is now the PRIMARY detector (scanned live in runClaude below). The
// RATE_LIMIT_RE imported from classify.ts is the FALLBACK for any block that
// arrives as stderr prose instead. ASSUMPTION[ADR-0003]: the weekly block shape
// is still unobserved; keep this fallback until it is captured.

const STDERR_TAIL_BYTES = 4096;
// Bounded in-memory capture of signal-bearing stream-json lines (ADR-0003).
const STREAM_SIGNAL_BYTES = 16384;
// Cap for the stdout line-assembly buffer (a single stream-json event line is
// normally far smaller; a truncated over-long line just fails the JSON parse).
const STDOUT_LINE_BUF_MAX = 1024 * 1024;
// ADR-0004: how often the per-task deadline is checked against the wall clock.
const TIMEOUT_POLL_MS = 250;
// ADR-0004: default bounded grace between issuing a kill and force-resolving.
const KILL_GRACE_MS = 5_000;

// Result of a single claude -p spawn (shared by both task paths).
export type SpawnOutcome = {
  exitCode: number;
  rateLimited: boolean;
  // ADR-0009 (UNVERIFIED, capture-armed): the spawn surfaced an expired/missing
  // subscription login (claude stderr prose, or a structured 401). The executor
  // flags the TaskResult and the pipeline stops the run with reason 'auth-error'.
  authError: boolean;
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
  // is provably orphaned and safe to clear. ADR-0004: false when the bounded
  // kill grace force-resolved the spawn (the tree may still be alive).
  descendantsDead: boolean;
};

// Narrow slice of ExecCtx that runClaude actually reads. Defined here (rather
// than importing ExecCtx from executor.ts) so spawn-claude.ts never depends on
// executor.ts — keeping the module graph acyclic. ExecCtx is a structural
// superset, so executor passes its full ctx where this is expected.
export type RunClaudeCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  taskTimeoutMs: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  routing?: ModelRoutingConfig;
  paceTier?: PaceTier;
};

// Classify the rate-limit signal (session vs weekly vs ambiguous). Only called
// when spawn.rateLimited is true. Hierarchy (ADR-0003):
//   1. structured stream-json block (VERIFIED session shape) — the in-memory
//      signal lines captured during streaming, else the .jsonl on disk;
//   2. stderr prose fallback (the old ADR-0001 path), enriched with any
//      rate_limit_event resetsAt from the stream.
// Tolerant of missing streams — an unreadable signal degrades to 'ambiguous'
// rather than crashing the run.
export function classifySpawnSignal(spawn: SpawnOutcome): RateLimitClassification {
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

// ADR-0001/0003 self-capturing tripwire: whenever a spawn is flagged
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

// ADR-0009 self-capturing tripwire: dump the raw stderr + the stream-json tail to
// <logDir>/<taskId>.AUTH-CAPTURE.txt the first time an auth-failure flag fires, so
// the never-yet-observed real auth-error shape documents itself (mirrors
// captureBlockSignal). LOCAL file write only; best-effort, NEVER throws.
function captureAuthSignal(taskId: string, logDir: string, spawn: SpawnOutcome): void {
  try {
    let stderrRaw = spawn.stderrText ?? '';
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
      `# glean AUTH-CAPTURE (ADR-0009 self-capturing tripwire)\n` +
      `# Task: ${taskId}\n` +
      `# Captured: ${new Date().toISOString()}\n` +
      `# An auth-failure flag fired for this task. The auth-error shape is UNVERIFIED\n` +
      `# (never captured). Drop the signal below into a classify.ts fixture + tighten\n` +
      `# AUTH_ERROR_RE / isStreamAuthErrorLine, then mark the shape VERIFIED.\n` +
      `\n## raw stderr\n${stderrRaw}\n` +
      `\n## stream-json tail (last ${BLOCK_CAPTURE_JSONL_TAIL_LINES} lines)\n${jsonlTail}\n`;
    writeFileSync(join(logDir, `${taskId}.AUTH-CAPTURE.txt`), body);
  } catch {
    // Capture is strictly best-effort diagnostics — never let it break a run.
  }
}

// Injectable wall-clock source for the per-task deadline check (fn.impl
// pattern, like diffStat) so tests can simulate a sleep/resume clock jump
// deterministically (ADR-0004).
function nowMs(): number {
  return nowMs.impl();
}
nowMs.impl = Date.now;
// Test-only handle (prefixed __ to signal "do not use in production code").
export const __nowMs = nowMs;

// ── Shared spawn helper ─────────────────────────────────────────────────────
// The render-and-spawn inputs for one `claude -p` invocation. `deny` is the
// load-bearing safety boundary (INVARIANT: appended unconditionally below as
// `--disallowedTools`, argv-asserted by the F2 tests).
export type RunClaudeOpts = { prompt: string; cwd: string; addDir: string | string[]; deny: string; allowedTools?: string };

// SEAM[ADR-0008]: `runClaude` IS the SUBSCRIPTION spawn backend. Subscription-auth
// is the headline and the only implemented backend; an opt-in API-key backend (the
// hedge against metered `claude -p` billing — ADR-0008 + the 2026-06-22 strategy
// memo) would implement this same contract and be selected explicitly in the
// executor. Not built today — this interface only marks where it slots in.
export interface SpawnBackend {
  readonly kind: 'subscription' | 'api-key';
  run(c: Candidate, ctx: RunClaudeCtx, opts: RunClaudeOpts): Promise<SpawnOutcome>;
}

// The only backend today. A future `apiKeyBackend: SpawnBackend` (ADR-0008) would
// be selected in the executor by an explicit opt-in; this conformance type-checks
// that `runClaude` satisfies the contract so the seam can't silently drift.
export const subscriptionBackend: SpawnBackend = { kind: 'subscription', run: runClaude };

export async function runClaude(
  c: Candidate,
  ctx: RunClaudeCtx,
  opts: RunClaudeOpts,
): Promise<SpawnOutcome> {
  const logDir = join(ctx.gleanRoot, 'logs', ctx.runId);
  mkdirSync(logDir, { recursive: true });
  const stderrPath = join(logDir, `${c.id}.stderr`);
  const jsonlPath = join(logDir, `${c.id}.jsonl`);
  const stderrStream = createWriteStream(stderrPath);
  const jsonlStream = createWriteStream(jsonlPath);
  let rateLimited = false;
  // ADR-0009 (UNVERIFIED): set when an auth-failure signal appears in the stream
  // or claude's stderr. Does not kill the spawn (it exits on its own); the
  // pipeline stops the whole run on the first one.
  let authError = false;
  // Bounded in-memory tail of stderr — classified for the rate-limit signal so we
  // never depend on the async file flush completing before we read it back.
  let stderrText = '';

  // Pass prompt via stdin to avoid Windows command-line length limits (~8191 chars).
  // --verbose is required for --output-format stream-json in -p (print) mode.
  // One --add-dir per granted read dir. research-dossier grants BOTH its output
  // dir AND the candidate's project_path (ADR-0002 A1: claude -p honors variadic
  // --add-dir for non-interactive read access).
  const addDirs = Array.isArray(opts.addDir) ? opts.addDir : [opts.addDir];
  // v0.9 model routing + runaway-loop guard (ASSUMPTION[ADR-0006]): every spawn
  // gets an explicit --model (config per-type → task-type default → pool-aware
  // 'sonnet', with the optional pace-tier override) and a per-type --max-turns
  // cap orthogonal to the wall-clock timeout. The resolved model is also logged
  // on the orchestrator's task.start event — aliases drift across generations.
  const model = resolveModel(c.type, ctx.routing ?? {}, ctx.paceTier ?? 'normal');
  const maxTurns = resolveMaxTurns(c.type, ctx.routing ?? {});
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--max-turns', String(maxTurns),
    ...addDirs.flatMap((d) => ['--add-dir', d]),
    '--permission-mode', 'acceptEdits',
  ];
  // draft-impl is the first path that runs Bash (git commit, tests); pass explicit
  // --allowedTools so a headless -p run does not hang on an interactive approval.
  // ASSUMPTION[ADR-0009]: this allow-list bounds tool-call NAMES, not what an
  // allow-listed interpreter subprocess then writes — that is defense-in-depth on
  // native Windows (no OS sandbox), narrowed by default + closable via strict_spawn.
  if (opts.allowedTools) claudeArgs.push('--allowedTools', opts.allowedTools);
  claudeArgs.push('--disallowedTools', opts.deny);
  claudeArgs.push('--session-id', randomUUID());

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

  let timedOut = false;
  let exited = false;
  let killIssued = false;
  let signalKillIssued!: () => void;
  const killIssuedSignal = new Promise<void>((resolve) => { signalKillIssued = resolve; });
  // Issue the (single) hard kill for this spawn — shared by the timeout
  // deadline and the rate-limit block scan, so the ADR-0004 bounded grace below
  // covers every kill source. Idempotent; a no-op once the child has exited
  // (e.g. the final-line block scan after exit).
  const issueKill = (): void => {
    if (killIssued || exited) return;
    killIssued = true;
    signalKillIssued();
    kills.push(job.kill());
  };

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
    // could carry a rate-limit OR auth signal.
    if (!trimmed.includes('rate_limit') && !trimmed.includes('"is_error":true')
      && !trimmed.includes('401') && !trimmed.includes('authentication')) return;
    streamSignalText = (streamSignalText + trimmed + '\n').slice(-STREAM_SIGNAL_BYTES);
    if (!rateLimited && isStreamBlockLine(trimmed)) {
      rateLimited = true;
      // issueKill no-ops once the child has already exited (the final-line scan).
      issueKill();
    }
    // ADR-0009 (UNVERIFIED): a structured 401 / authentication result. Flag only —
    // the spawn exits on its own; the pipeline stops the run on the first flag.
    if (!authError && isStreamAuthErrorLine(trimmed)) authError = true;
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
    const text = chunk.toString('utf8');
    stderrText = (stderrText + text).slice(-STDERR_TAIL_BYTES);
    if (!rateLimited && RATE_LIMIT_RE.test(text)) {
      rateLimited = true;
      issueKill();
    }
    // ADR-0009 (UNVERIFIED): claude's own auth-failure prose on stderr (not model
    // stdout content). Flag only — the spawn exits on its own.
    if (!authError && AUTH_ERROR_RE.test(text)) authError = true;
  });

  // INVARIANT[ADR-0004]: enforce the per-task timeout against the WALL CLOCK,
  // never a single setTimeout. Verified live (run 2026-06-12-1711-41b981): the machine slept
  // mid-task, no timer can fire during S3 sleep, and whether an overdue timer
  // fires promptly on resume is platform luck — the 8-min timeout landed 34.5
  // wall-clock minutes in. Polling Date.now() bounds the kill to ~one poll
  // interval after any resume/clock jump.
  const deadlineAt = nowMs() + ctx.taskTimeoutMs;
  const deadlineTimer = setInterval(() => {
    if (nowMs() >= deadlineAt) {
      clearInterval(deadlineTimer);
      timedOut = true;
      issueKill();
    }
  }, TIMEOUT_POLL_MS);

  // INVARIANT[ADR-0004]: once a kill is issued, the child gets a bounded grace to die. If
  // it survives (kill failed / shim killed but an orphan holds on), we must NOT
  // keep awaiting job.exit — that is exactly how a wedged `claude -p` could pin
  // the executor indefinitely. After the grace we force-resolve with the status
  // the kill was issued for and treat descendants as possibly alive.
  const killGraceMs = ctx.killGraceMs ?? KILL_GRACE_MS;
  const KILL_GRACE_EXPIRED = Symbol('kill-grace-expired');
  let graceTimer: NodeJS.Timeout | undefined;
  const graceExpired = killIssuedSignal.then(
    () => new Promise<typeof KILL_GRACE_EXPIRED>((resolve) => {
      if (exited) return; // child already reaped — never expire
      graceTimer = setTimeout(() => resolve(KILL_GRACE_EXPIRED), killGraceMs);
    }),
  );

  let exitCode: number;
  let forcedResolve = false;
  try {
    const raced = await Promise.race([job.exit, graceExpired]);
    if (raced === KILL_GRACE_EXPIRED) {
      forcedResolve = true;
      exitCode = -1;
      // Stop consuming a pipe a wedged/orphaned descendant may hold open
      // (detach listeners FIRST so a late chunk can't hit an ended write
      // stream), and drop our handles so the child can't keep glean alive.
      job.child.stdout?.removeAllListeners('data');
      job.child.stderr?.removeAllListeners('data');
      try { job.child.stdout?.destroy(); } catch { /* best effort */ }
      try { job.child.stderr?.destroy(); } catch { /* best effort */ }
      try { job.child.stdin?.destroy(); } catch { /* best effort */ }
      try { job.child.unref(); } catch { /* best effort */ }
    } else {
      exitCode = raced;
    }
  } finally {
    exited = true;
    clearInterval(deadlineTimer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }

  // F7: if we killed the job and the child DID exit, wait for the tree-kill of
  // all descendants to finish so no live grandchild git can still hold the
  // worktree's index.lock when the caller proceeds to clear it. Bounded by the
  // same grace (ADR-0004): kill() resolves only after taskkill/exit complete,
  // so an anomalous straggler must degrade descendantsDead, not hang the run.
  let descendantsDead = !forcedResolve;
  if (!forcedResolve && kills.length > 0) {
    let settleTimer: NodeJS.Timeout | undefined;
    try {
      const settled = await Promise.race([
        Promise.all(kills).then(() => true, () => true),
        new Promise<boolean>((resolve) => { settleTimer = setTimeout(() => resolve(false), killGraceMs); }),
      ]);
      if (!settled) descendantsDead = false;
    } finally {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    }
  }

  // Flush the decoder + scan any final line that arrived without a trailing
  // newline, so a block signal on the very last stream line is never missed.
  scanStdoutLine(stdoutBuf + stdoutDecoder.end());

  stderrStream.end();
  jsonlStream.end();

  // descendantsDead is true only when job.exit resolved AND every kill was
  // awaited to completion — a force-resolved (or straggling) tree is honestly
  // reported as possibly alive so worktree cleanup won't touch its locks (F7).
  const outcome: SpawnOutcome = { exitCode, rateLimited, authError, timedOut, stderrPath, stderrText, streamSignalText, jsonlPath, descendantsDead };

  // ADR-0003 self-capturing tripwire: each spawn flagged rateLimited writes its
  // OWN capture file (keyed by task id `<id>.BLOCK-CAPTURE.txt`), so the
  // never-yet-observed real block shape captures itself the first time it ever
  // happens. Per-task (not once-global) — distinct task ids never collide.
  // Best-effort, never throws.
  if (rateLimited) captureBlockSignal(c.id, logDir, outcome);
  // ADR-0009 self-capturing tripwire: the auth-failure shape is likewise
  // UNVERIFIED, so the first real one writes <id>.AUTH-CAPTURE.txt to document it.
  if (authError) captureAuthSignal(c.id, logDir, outcome);

  return outcome;
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
