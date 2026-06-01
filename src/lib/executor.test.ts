import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { executeOne, __diffStat, __commitsBeyondBase, __clearStaleIndexLock } from './executor.js';
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

  it('F7: clearStaleIndexLock refuses to delete a lock while descendants may be alive', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-f7-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), 'x\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    // Plant a lock at the repo's real index path.
    const lockPath = execSync('git rev-parse --path-format=absolute --git-path index.lock', { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(lockPath, '');
    expect(existsSync(lockPath)).toBe(true);

    // descendantsDead=false → a live holder might own the lock → must NOT delete.
    __clearStaleIndexLock(repo, repo, false);
    expect(existsSync(lockPath)).toBe(true);

    // descendantsDead=true → the tree is confirmed dead → safe to clear.
    __clearStaleIndexLock(repo, repo, true);
    expect(existsSync(lockPath)).toBe(false);
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

  it('F5: resolves base_branch per-candidate from the candidate project_path', async () => {
    // Two repos with DIFFERENT base branch names. The executor must key the
    // base off the candidate's OWN project_path, not an ambient single value —
    // otherwise it could provision a worktree off the wrong repo's base.
    const repoA = mkdtempSync(join(tmpdir(), 'glean-f5-A-'));
    execSync('git init -q -b trunk', { cwd: repoA });
    execSync('git config user.email t@t', { cwd: repoA });
    execSync('git config user.name t', { cwd: repoA });
    writeFileSync(join(repoA, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repoA });

    const root = tmpRoot();
    const result = await executeOne(
      {
        id: 'f5', evidence_hash: 'h', type: 'draft-impl',
        project_path: repoA,
        evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: implement feature' }] },
        est_value: 50, est_tokens: 1000, status: 'pending',
      },
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        // No ambient baseBranch — a per-candidate resolver keyed on project_path.
        baseBranchFor: (p: string) => (p === repoA ? 'trunk' : 'main'),
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
      },
    );
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    // worktree was provisioned off repoA's actual base branch (trunk), not main.
    expect(result.output.base).toBe('trunk');
    const count = execSync('git rev-list trunk..prep/glean-f5 --count', { cwd: repoA, encoding: 'utf8' }).trim();
    expect(Number(count)).toBeGreaterThanOrEqual(1);
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

  it('F4: diffStat and commitsBeyondBase use the SAME two-dot base..branch range', () => {
    // draft-impl provisions `worktree add -b branch base`, so base never advances
    // during a run — base IS the branch point. Both helpers must read the same
    // two-dot `base..branch` range so the commit count and the diff stat answer
    // one consistent "what did the prep branch add" question (no three-dot drift).
    const repo = mkdtempSync(join(tmpdir(), 'glean-f4-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), 'base\n');
    execSync('git add . && git commit -q -m base', { cwd: repo });
    // branch off base, add ONE commit touching ONE file
    execSync('git checkout -q -b prep/x', { cwd: repo });
    writeFileSync(join(repo, 'b.ts'), 'branchonly\n');
    execSync('git add . && git commit -q -m branchcommit', { cwd: repo });

    const commits = __commitsBeyondBase(repo, 'main', 'prep/x');
    const stat = __diffStat(repo, 'main', 'prep/x');
    expect(commits).toBe(1);
    expect(stat).not.toBeNull();
    expect(stat!.files).toBe(1); // exactly b.ts

    // Both helpers must read the literal two-dot range string (no '...').
    const diffSrc = __diffStat.impl.toString();
    const commitSrc = __commitsBeyondBase.impl.toString();
    expect(diffSrc).toContain('${base}..${branch}');
    expect(diffSrc).not.toContain('${base}...${branch}');
    expect(commitSrc).toContain('${base}..${branch}');
  });

  it('F3: auto-commit does NOT blanket-stage an unrelated tracked file a test run rewrote', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-f3-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    // A tracked lockfile/snapshot that a test run might rewrite — unrelated to the TODO.
    writeFileSync(join(repo, 'lock.json'), '{"v":1}\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    const root = tmpRoot();
    const result = await executeOne(
      {
        id: 'f3', evidence_hash: 'h', type: 'draft-impl',
        project_path: repo,
        evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: implement feature' }] },
        est_value: 50, est_tokens: 1000, status: 'pending',
      },
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000, baseBranch: 'main',
        // This scenario edits a.ts + rewrites lock.json but does NOT commit, so
        // the auto-commit fallback runs. The unrelated lock.json must not land.
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-noncommit-dirty.yaml') },
      },
    );
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    const tree = execSync(`git show --stat ${result.output.branch}`, { cwd: repo, encoding: 'utf8' });
    // the evidence file the model edited landed...
    expect(tree).toContain('a.ts');
    // ...but the unrelated tracked file the "test run" rewrote did NOT.
    expect(tree).not.toContain('lock.json');
  });

  it('F4: a real commit with an unreadable diff stat does NOT report a clean ok', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-f4-null-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    // Force diffStat to return null even though commitsBeyondBase sees a commit.
    const origDiff = __diffStat.impl;
    __diffStat.impl = () => null;
    try {
      const root = tmpRoot();
      const result = await executeOne(
        {
          id: 'f4-null', evidence_hash: 'h', type: 'draft-impl',
          project_path: repo,
          evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO' }] },
          est_value: 50, est_tokens: 1000, status: 'pending',
        },
        {
          runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
          templatesDir: join(__dirname, '..', '..', 'templates'),
          taskTimeoutMs: 30_000, baseBranch: 'main',
          env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
        },
      );
      // A commit landed but the stat was unreadable — must NOT be a clean 'ok'.
      expect(result.status).toBe('failed');
    } finally {
      __diffStat.impl = origDiff;
    }
  });

  // ── draft-impl deterministic test-status capture (v0.7.1) ──────────────────
  // After a draft session commits, glean itself runs the project's test_command
  // in the worktree and records the outcome. exit 0 → 'pass', non-zero → 'fail',
  // no test_command OR unrunnable → 'none'. A throwing/failing test run must
  // NEVER crash the executor.
  function draftRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-tests-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });
    return repo;
  }
  function draftCandidate(repo: string, id: string): Candidate {
    return {
      id, evidence_hash: 'h', type: 'draft-impl',
      project_path: repo,
      evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 'TODO: implement feature' }] },
      est_value: 50, est_tokens: 1000, status: 'pending',
    };
  }
  function draftCtx(repo: string, root: string, testCommand: string | undefined) {
    return {
      runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000, baseBranch: 'main',
      testCommandFor: (_p: string) => testCommand,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
    };
  }

  it('draft-impl: a passing test_command yields output.tests === "pass"', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const result = await executeOne(draftCandidate(repo, 'dt-pass'), draftCtx(repo, root, 'node -e "process.exit(0)"'));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('pass');
  });

  it('draft-impl: a failing test_command yields output.tests === "fail"', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const result = await executeOne(draftCandidate(repo, 'dt-fail'), draftCtx(repo, root, 'node -e "process.exit(1)"'));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('fail');
  });

  it('draft-impl: no test_command configured yields output.tests === "none"', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const result = await executeOne(draftCandidate(repo, 'dt-none'), draftCtx(repo, root, undefined));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('none');
  });

  it('draft-impl: an unrunnable test_command yields "none" and never crashes the run', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const result = await executeOne(
      draftCandidate(repo, 'dt-throw'),
      draftCtx(repo, root, 'glean-nonexistent-binary-xyz --no-such-flag'),
    );
    // The run still succeeds (a commit landed); the test status degrades to 'none'.
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('none');
  });

  it('draft-impl: the captured tests status is forwarded to recordOutcome (draft_tests)', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const calls: Array<{ status: string; fields: Record<string, unknown> }> = [];
    const ctx = { ...draftCtx(repo, root, 'node -e "process.exit(0)"'), recordOutcome: (status: string, fields: Record<string, unknown>) => calls.push({ status, fields }) };
    const result = await executeOne(draftCandidate(repo, 'dt-rec'), ctx);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].fields.draft_tests).toBe('pass');
  });

  // I3: a fresh worktree has no node_modules → a real `npm test` exits nonzero
  // with an environment/setup signature. That must read as 'none' (couldn't run),
  // NOT 'fail' (a suite that ran and reported failures).
  it('draft-impl: an env/setup failure (Cannot find module) maps to "none", not "fail"', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    // node resolves on PATH, exits 1, and prints a "Cannot find module" signature.
    const cmd = `node -e "console.error('Error: Cannot find module \\'vitest\\''); process.exit(1)"`;
    const result = await executeOne(draftCandidate(repo, 'dt-env'), draftCtx(repo, root, cmd));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('none');
  });

  it('draft-impl: a genuine assertion failure (exit 1, no env signature) maps to "fail"', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const cmd = `node -e "console.error('AssertionError: expected 1 to equal 2'); process.exit(1)"`;
    const result = await executeOne(draftCandidate(repo, 'dt-assert'), draftCtx(repo, root, cmd));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('fail');
  });

  // I1: a quoted-path test_command must resolve the program respecting the quotes,
  // not split on the first space inside the quoted path.
  it('draft-impl: a quoted-path test_command resolves and runs (not a false "none")', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    // Quote the node binary's absolute path (which contains no space on CI, but the
    // PARSER must treat the whole quoted span as one token regardless).
    const nodePath = process.execPath;
    const cmd = `"${nodePath}" -e "process.exit(0)"`;
    const result = await executeOne(draftCandidate(repo, 'dt-quoted'), draftCtx(repo, root, cmd));
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('pass');
  });

  // I4: a killed/salvaged partial commit must NOT have its tests run/trusted.
  it('draft-impl: a timed-out salvaged draft reports tests "none", never running them', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-draft-i4-'));
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: implement feature\n');
    execSync('git add . && git commit -q -m init', { cwd: repo });

    const root = tmpRoot();
    // If the test command ran it would exit 0 ('pass'); a sentinel file proves it
    // never executed. Use the salvage scenario (edits a.ts, no commit) under a
    // short timeout so the session is KILLED and the dirty tree is auto-committed.
    const sentinel = join(root, 'ran.txt');
    const result = await executeOne(
      draftCandidate(repo, 'dt-i4'),
      {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 500, baseBranch: 'main',
        testCommandFor: (_p: string) => `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); process.exit(0)"`,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-noncommit-slow.yaml') },
      },
    );
    expect(result.status).toBe('timeout');
    // A salvaged commit may or may not exist depending on timing; if it did, the
    // tests must read 'none' and the command must NOT have run (no sentinel).
    if (result.output?.kind === 'branch') {
      expect(result.output.tests).toBe('none');
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  // C1: when remaining budget is exhausted the test run is skipped entirely.
  it('draft-impl: zero remaining budget skips the test run (tests "none", command never runs)', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const sentinel = join(root, 'budget-ran.txt');
    const result = await executeOne(draftCandidate(repo, 'dt-budget'), {
      runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000, baseBranch: 'main',
      remainingBudgetMs: 0,
      testCommandFor: (_p: string) => `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); process.exit(0)"`,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
    });
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('none');
    expect(existsSync(sentinel)).toBe(false);
  });

  // C1: an active STOP sentinel skips the test run entirely.
  it('draft-impl: STOP sentinel skips the test run (tests "none", command never runs)', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const sentinel = join(root, 'stop-ran.txt');
    const result = await executeOne(draftCandidate(repo, 'dt-stop'), {
      runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000, baseBranch: 'main',
      stopRequested: () => true,
      testCommandFor: (_p: string) => `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); process.exit(0)"`,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'draft-impl-commit.yaml') },
    });
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('none');
    expect(existsSync(sentinel)).toBe(false);
  });

  // C2: the recorded duration must include the test-run time.
  it('draft-impl: duration_ms covers the (slow) test run', async () => {
    const repo = draftRepo();
    const root = tmpRoot();
    const calls: Array<{ status: string; fields: Record<string, unknown> }> = [];
    // A test command that sleeps ~700ms so the test run is a measurable slice.
    const slow = `node -e "setTimeout(()=>process.exit(0), 700)"`;
    const ctx = {
      ...draftCtx(repo, root, slow),
      recordOutcome: (status: string, fields: Record<string, unknown>) => calls.push({ status, fields }),
    };
    const result = await executeOne(draftCandidate(repo, 'dt-dur'), ctx);
    expect(result.status).toBe('ok');
    if (result.output?.kind !== 'branch') throw new Error('expected branch output');
    expect(result.output.tests).toBe('pass');
    // elapsed_ms must cover the ~700ms test run (well above a no-test baseline).
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(600);
    expect(calls[0].fields.duration_ms).toBe(result.elapsed_ms);
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
