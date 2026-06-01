import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { executeOne } from './executor.js';
import * as jobobject from './jobobject.js';
import type { Candidate } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(__dirname, '..', '..', 'test', 'fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh');

function tmpRoot() { return mkdtempSync(join(tmpdir(), 'glean-exec-')); }
function tmpRepo() {
  const r = mkdtempSync(join(tmpdir(), 'glean-exec-repo-'));
  writeFileSync(join(r, 'README.md'), 'hi');
  return r;
}

function candidate(): Candidate {
  return {
    id: 'task-1', evidence_hash: 'h', type: 'research-dossier',
    project_path: tmpRepo(),
    evidence: { kind: 'todo', file: 'README.md', todo_lines: [{ line: 1, text: 'TODO' }] },
    est_value: 50, est_tokens: 1000, status: 'pending',
  };
}

describe('executeOne', () => {
  it('writes OUT.md on clean exit', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'r1',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
    });
    expect(result.status).toBe('ok');
    expect(result.output?.kind).toBe('file');
    const filePath = result.output?.kind === 'file' ? result.output.path : undefined;
    expect(existsSync(filePath!)).toBe(true);
    expect(readFileSync(filePath!, 'utf8')).toContain('fake dossier');
  });

  it('detects rate-limit and returns rate-limit status', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'r1',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'rate-limit.yaml') },
    });
    expect(result.status).toBe('rate-limit');
  });

  it('kills on task timeout', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'r1',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 500,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'timeout.yaml') },
    });
    expect(result.status).toBe('timeout');
  });

  it('produces distinct work dirs for TODOs at different lines in same file', async () => {
    const root = tmpRoot();
    const repo = tmpRepo();
    writeFileSync(join(repo, 'foo.ts'), 'a\nb\nc\nd\n');
    const c1: Candidate = {
      id: 'task-A', evidence_hash: 'hA', type: 'research-dossier',
      project_path: repo,
      evidence: { kind: 'todo', file: 'foo.ts', todo_lines: [{ line: 42, text: 'TODO' }] },
      est_value: 50, est_tokens: 1000, status: 'pending',
    };
    const c2: Candidate = {
      id: 'task-B', evidence_hash: 'hB', type: 'research-dossier',
      project_path: repo,
      evidence: { kind: 'todo', file: 'foo.ts', todo_lines: [{ line: 99, text: 'TODO' }] },
      est_value: 50, est_tokens: 1000, status: 'pending',
    };
    const ctx = {
      runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
    };
    const r1 = await executeOne(c1, ctx);
    const r2 = await executeOne(c2, ctx);
    const p1 = r1.output?.kind === 'file' ? r1.output.path : '';
    const p2 = r2.output?.kind === 'file' ? r2.output.path : '';
    expect(p1).not.toEqual(p2);
    expect(p1).toMatch(/-L42/);
    expect(p2).toMatch(/-L99/);
  });

  it('clears the timeout handle on normal exit (no dangling timers)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    try {
      const root = tmpRoot();
      const result = await executeOne(candidate(), {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(result.status).toBe('ok');
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('draft-impl: provisions a worktree, captures the prep-branch diff stat', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-repo-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });
    const mainHead = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();

    const root = tmpRoot();
    const result = await executeOne(
      {
        id: 'draft-1', evidence_hash: 'h', type: 'draft-impl',
        project_path: repo,
        evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: implement feature' }] },
        est_value: 50, est_tokens: 1000, status: 'pending',
      },
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000, baseBranch: 'main',
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
      },
    );

    expect(result.status).toBe('ok');
    expect(result.output?.kind).toBe('branch');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.branch).toBe('prep/glean-draft-1');
    expect(result.output.base).toBe('main');
    expect(result.output.files).toBeGreaterThanOrEqual(1);
    expect(result.output.insertions).toBeGreaterThanOrEqual(1);
    // worktree exists and prompt.md is NOT inside it (scratch lives outside)
    expect(existsSync(result.output.worktree)).toBe(true);
    expect(existsSync(join(result.output.worktree, 'prompt.md'))).toBe(false);
    // commit landed on the prep branch beyond base
    const prepCommits = execSync('git rev-list main..prep/glean-draft-1 --count', { cwd: repo, encoding: 'utf8' }).trim();
    expect(Number(prepCommits)).toBeGreaterThanOrEqual(1);
    // main HEAD untouched
    expect(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim()).toBe(mainHead);
  });

  it('draft-impl: recovers from a stale index.lock left by a killed child (T8)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-lock-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    const root = tmpRoot();
    const result = await executeOne(
      {
        id: 'draft-lock', evidence_hash: 'h', type: 'draft-impl',
        project_path: repo,
        evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
        est_value: 50, est_tokens: 1000, status: 'pending',
      },
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000, baseBranch: 'main',
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-lock-leftover.yaml') },
      },
    );

    // No crash; the stale lock was cleared so the auto-commit fallback succeeded.
    expect(result.status).toBe('ok');
    expect(result.output?.kind).toBe('branch');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    // the leftover lock is gone
    const lockAbs = execSync('git rev-parse --path-format=absolute --git-path index.lock', { cwd: result.output.worktree, encoding: 'utf8' }).trim();
    expect(existsSync(lockAbs)).toBe(false);
    // the edited file was committed
    const committed = execSync('git show --stat prep/glean-draft-lock', { cwd: repo, encoding: 'utf8' });
    expect(committed).toContain('feature.ts');
  });

  it('draft-impl: spawns with a SCOPED Bash allow-list, never bare Bash (CRITICAL 1)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-allow-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    const spy = vi.spyOn(jobobject, 'spawnInJob');
    try {
      const root = tmpRoot();
      await executeOne(
        {
          id: 'draft-allow', evidence_hash: 'h', type: 'draft-impl',
          project_path: repo,
          evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: implement feature' }] },
          est_value: 50, est_tokens: 1000, status: 'pending',
        },
        {
          runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
          templatesDir: join(__dirname, '..', '..', 'templates'),
          taskTimeoutMs: 30_000, baseBranch: 'main',
          env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
        },
      );
      expect(spy).toHaveBeenCalled();
      // Find the --allowedTools value passed to the spawn.
      const call = spy.mock.calls[0];
      const args = call[1] as string[];
      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThanOrEqual(0);
      const allow = args[idx + 1];
      // The scoped allow-list, not the old bare-Bash grant.
      expect(allow).not.toBe('Bash Edit Write');
      const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
      expect(tokens).not.toContain('Bash'); // bare Bash must be absent
      expect(allow).toContain('Bash(git add:*)');
      expect(allow).toContain('Bash(git commit:*)');
      expect(allow).toContain('Bash(npm test:*)');
      expect(allow).toContain('Edit');
      expect(allow).toContain('Write');
    } finally {
      spy.mockRestore();
    }
  });

  it('draft-impl: skips with a warning when base_branch is not configured', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-nobase-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    const root = tmpRoot();
    const result = await executeOne(
      {
        id: 'draft-2', evidence_hash: 'h', type: 'draft-impl',
        project_path: repo,
        evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: x' }] },
        est_value: 50, est_tokens: 1000, status: 'pending',
      },
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000, // no baseBranch
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
      },
    );
    expect(result.status).toBe('failed');
    expect(result.output).toBeUndefined();
    // no worktree was created
    let listed = '';
    try { listed = execSync('git worktree list', { cwd: repo, encoding: 'utf8' }); } catch { /* ignore */ }
    expect(listed).not.toContain('prep/glean-draft-2');
  });

  it('invokes recordOutcome callback exactly once with the final status and fields', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-exec-cb-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-exec-home-'));
    mkdirSync(join(home, 'glean', 'templates'), { recursive: true });
    copyFileSync(
      join(process.cwd(), 'templates', 'research-dossier.md'),
      join(home, 'glean', 'templates', 'research-dossier.md'),
    );

    const calls: Array<{ status: string; fields: Record<string, unknown> }> = [];
    const candidate: Candidate = {
      id: 'c-1',
      evidence_hash: 'h1',
      type: 'research-dossier',
      project_path: repo,
      evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: x' }] },
      est_value: 0.5,
      est_tokens: 500,
      status: 'pending',
    };
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    const result = await executeOne(candidate, {
      runId: 'r-1',
      gleanRoot: join(home, 'glean'),
      claudeBin: fakeClaude,
      templatesDir: join(process.cwd(), 'templates'),
      taskTimeoutMs: 60_000,
      env: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml'),
      },
      recordOutcome: (status, fields) => calls.push({ status, fields }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(result.status);
    expect(calls[0].fields.duration_ms).toBe(result.elapsed_ms);
  });
});
