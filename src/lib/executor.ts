import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, TaskResult } from './types.js';
import { spawnInJob } from './jobobject.js';
import { render } from './render.js';
import { extractLastAssistantText } from './jsonl-extract.js';
import { projectSlug } from './state.js';
import { titleFor, today } from './candidate-meta.js';
import { BASE_DENY } from './deny.js';

const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit)/i;

export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  recordOutcome?: (status: TaskResult['status'], fields: {
    dossier_path?: string;
    started_at?: number;
    ended_at?: number;
    duration_ms?: number;
    bytes_written?: number;
    stderr_rate_limit_hits?: number;
  }) => void;
};

export async function executeOne(c: Candidate, ctx: ExecCtx): Promise<TaskResult> {
  const start = Date.now();
  const slug = slugify(c);
  const dossierDir = join(ctx.gleanRoot, 'dossiers', projectSlug(c.project_path), today());
  const workDir = c.type === 'research-dossier' ? join(dossierDir, `research-${slug}`) : join(dossierDir, 'docs');
  mkdirSync(workDir, { recursive: true });

  const hydrated = hydrateEvidence(c, ctx);
  const templatePath = pickTemplate(c, ctx);
  const templateBody = readFileSync(templatePath, 'utf8');
  const prompt = render(templateBody + SAFETY_FOOTER, hydrated);
  writeFileSync(join(workDir, 'prompt.md'), prompt);

  const logDir = join(ctx.gleanRoot, 'logs', ctx.runId);
  mkdirSync(logDir, { recursive: true });
  const stderrPath = join(logDir, `${c.id}.stderr`);
  const jsonlPath = join(logDir, `${c.id}.jsonl`);
  const stderrStream = createWriteStream(stderrPath);
  const jsonlStream = createWriteStream(jsonlPath);
  let rateLimited = false;

  // Pass prompt via stdin to avoid Windows command-line length limits (~8191 chars).
  // Use -p with no argument; claude reads the prompt from stdin when piped.
  // --verbose is required for --output-format stream-json in -p (print) mode.
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--add-dir', workDir,
    '--permission-mode', 'acceptEdits',
    '--disallowedTools', BASE_DENY,
    '--session-id', uuid(),
  ];
  // On Windows, .cmd files must be invoked via cmd.exe /c
  const [spawnCmd, spawnArgs] = resolveSpawn(ctx.claudeBin, claudeArgs);
  const job = spawnInJob(spawnCmd, spawnArgs, { cwd: workDir, env: ctx.env, stdio: 'pipe' });

  // Write the prompt to stdin and close the stream so claude proceeds immediately.
  if (job.child.stdin) {
    job.child.stdin.write(prompt, 'utf8');
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
        stderr_rate_limit_hits: rateLimited ? 1 : 0,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`);
    }
    const result: TaskResult = { status, elapsed_ms };
    if (output_path) result.output = { kind: 'file', path: output_path };
    if (stderr_tail) result.stderr_tail = stderr_tail;
    return result;
  };

  if (rateLimited) return finalize('rate-limit', undefined, undefined);
  if (timedOut) return finalize('timeout', undefined, undefined);
  if (exitCode !== 0) {
    const tail = tailLines(readFileSync(stderrPath, 'utf8'), 50);
    return finalize('failed', undefined, tail);
  }

  // Look for output
  const outPath = c.type === 'research-dossier' ? join(workDir, 'OUT.md') : findFirstFile(workDir, /\.md$/);
  if (outPath && existsSync(outPath)) {
    const bytes = readFileSync(outPath).length;
    if (bytes < 50) {
      const fallback = extractLastAssistantText(jsonlPath);
      writeFileSync(outPath, fallback);
      return finalize('ok-fallback', outPath, undefined);
    }
    return finalize('ok', outPath, undefined);
  }
  // No output at all — fallback
  const fallback = extractLastAssistantText(jsonlPath);
  const fallbackPath = join(workDir, 'OUT.md');
  writeFileSync(fallbackPath, fallback);
  return finalize('ok-fallback', fallbackPath, undefined);
}

const SAFETY_FOOTER = '\n\nspeculative — produce a draft, never push, write findings to `OUT.md` in the current working directory.\n';

function pickTemplate(c: Candidate, ctx: ExecCtx): string {
  const userDir = join(ctx.gleanRoot, 'templates');
  const name = c.type === 'research-dossier' ? 'research-dossier.md' : 'fetch-docs.md';
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
