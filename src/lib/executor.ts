import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, createWriteStream } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, TaskResult } from './types.js';
import { spawnInJob } from './jobobject.js';
import { render } from './render.js';

const RATE_LIMIT_RE = /(rate limit|429|usage limit|5-hour limit|weekly limit)/i;

export type ExecCtx = {
  runId: string;
  gleanRoot: string;
  claudeBin: string;
  templatesDir: string;
  taskTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
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
    '--disallowedTools', 'Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*)',
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
  const timerPromise = new Promise<'timeout'>((resolve) => {
    setTimeout(() => { timedOut = true; job.kill(); resolve('timeout'); }, ctx.taskTimeoutMs);
  });

  const exitCode = await Promise.race([job.exit, timerPromise.then(() => -2)]);
  stderrStream.end();
  jsonlStream.end();

  const elapsed_ms = Date.now() - start;

  if (rateLimited) return { status: 'rate-limit', elapsed_ms };
  if (timedOut || exitCode === -2) return { status: 'timeout', elapsed_ms };
  if (exitCode !== 0) {
    const tail = tailLines(readFileSync(stderrPath, 'utf8'), 50);
    return { status: 'failed', elapsed_ms, stderr_tail: tail };
  }

  // Look for output
  const outPath = c.type === 'research-dossier' ? join(workDir, 'OUT.md') : findFirstFile(workDir, /\.md$/);
  if (outPath && existsSync(outPath)) {
    const bytes = readFileSync(outPath).length;
    if (bytes < 50) {
      const fallback = extractLastAssistantText(jsonlPath);
      writeFileSync(outPath, fallback);
      return { status: 'ok-fallback', elapsed_ms, output_path: outPath };
    }
    return { status: 'ok', elapsed_ms, output_path: outPath };
  }
  // No output at all — fallback
  const fallback = extractLastAssistantText(jsonlPath);
  const fallbackPath = join(workDir, 'OUT.md');
  writeFileSync(fallbackPath, fallback);
  return { status: 'ok-fallback', elapsed_ms, output_path: fallbackPath };
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

function titleFor(c: Candidate): string {
  switch (c.evidence.kind) {
    case 'todo': return `Handle TODO in ${c.evidence.file}`;
    case 'jsonl': return c.evidence.ai_title;
    case 'pr': return `PR #${c.evidence.number}: ${c.evidence.title}`;
    case 'dep': return `Pre-fetch docs for ${c.evidence.package}`;
  }
}

function slugify(c: Candidate): string {
  const base = titleFor(c).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (c.evidence.kind === 'todo') {
    const line = c.evidence.todo_lines[0]?.line ?? 0;
    return `${base}-L${line}`;
  }
  return base;
}

function projectSlug(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function today(): string { return new Date().toISOString().slice(0, 10); }

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

function extractLastAssistantText(jsonlPath: string): string {
  try {
    const content = readFileSync(jsonlPath, 'utf8').split(/\r?\n/).reverse();
    for (const ln of content) {
      try {
        const o = JSON.parse(ln);
        const text = o?.message?.content?.[0]?.text ?? o?.delta?.text;
        if (typeof text === 'string' && text.length > 0) return text;
      } catch { /* skip */ }
    }
  } catch { /* file missing */ }
  return '_(no output produced)_';
}
