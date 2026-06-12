import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { executeOne, __diffStat, __commitsBeyondBase, __clearStaleIndexLock, __nowMs } from './executor.js';
import * as jobobject from './jobobject.js';
import { __terminateTree } from './jobobject.js';
import type { ChildProcess } from 'node:child_process';
import { researchAllowedTools } from './deny.js';
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

  // v0.8: a rate-limit result carries the classified signal derived from stderr.
  // The bundled rate-limit scenario ("5-hour limit reached, please retry later")
  // matches the rate-limit pattern but has no parseable reset horizon → ambiguous.
  it('attaches a rate-limit classification derived from the captured stderr', async () => {
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
    expect(result.classification).toBeDefined();
    expect(result.classification!.kind).toBe('ambiguous');
  });

  // A non-rate-limit (clean) result must NOT carry a classification.
  it('does not attach a classification on a clean exit', async () => {
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
    expect(result.classification).toBeUndefined();
  });

  // ── ADR-0001 self-capturing tripwire + resetsAt fallback ──────────────────
  // The first time a spawn is flagged rateLimited, the executor dumps the raw
  // stderr + a jsonl tail to <logDir>/<taskId>.BLOCK-CAPTURE.txt so the
  // never-captured real block shape captures itself. Best-effort, never throws.
  it('writes a .BLOCK-CAPTURE.txt with the stderr tail when rate-limited', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'rc',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'rate-limit.yaml') },
    });
    expect(result.status).toBe('rate-limit');
    const capturePath = join(root, 'logs', 'rc', 'task-1.BLOCK-CAPTURE.txt');
    expect(existsSync(capturePath)).toBe(true);
    const body = readFileSync(capturePath, 'utf8');
    expect(body).toContain('5-hour limit reached');
  });

  it('does NOT write a .BLOCK-CAPTURE.txt on a clean (non-rate-limited) exit', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'rc2',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
    });
    expect(result.status).toBe('ok');
    const capturePath = join(root, 'logs', 'rc2', 'task-1.BLOCK-CAPTURE.txt');
    expect(existsSync(capturePath)).toBe(false);
  });

  // When the stderr block carries no parseable reset moment but the captured
  // .jsonl holds a verified rate_limit_event.resetsAt, reset_at is back-filled
  // from it (kind stays as the stderr classifier decided — 'ambiguous' here).
  it('fills reset_at from the captured rate_limit_event when stderr lacks a timestamp', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'rc3',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'rate-limit-with-event.yaml') },
    });
    expect(result.status).toBe('rate-limit');
    expect(result.classification).toBeDefined();
    // stderr had no parseable horizon → kind stays ambiguous (unchanged behavior)...
    expect(result.classification!.kind).toBe('ambiguous');
    // ...but reset_at is enriched from the verified rate_limit_event resetsAt.
    expect(result.classification!.reset_at).toBe('2026-05-24T10:40:00.000Z');
  });

  // ── ADR-0003: structured stream-json 429 block (captured 2026-06-11) ───────
  // The real session-limit block arrives on STDOUT (rate_limit_event status
  // "rejected" + assistant message error:"rate_limit" + result is_error:true,
  // api_error_status:429) with EMPTY stderr and exit code 1. Before the fix the
  // executor classified this 'failed', so the pipeline kept spawning doomed tasks.
  it('flags a structured stream-json 429 block (empty stderr) as rate-limit', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'r429',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'structured-429.yaml') },
    });
    expect(result.status).toBe('rate-limit');
    expect(result.classification).toBeDefined();
    // resetsAt 1781197200 → 2026-06-11T17:00:00.000Z, in the past relative to any
    // test run after that date → < 6h away → session. The exact reset moment comes
    // from the rejected rate_limit_event, not the unparseable "resets 8pm" prose.
    expect(result.classification!.kind).toBe('session');
    expect(result.classification!.reset_at).toBe('2026-06-11T17:00:00.000Z');
    // the block-capture tripwire fires for the structured path too
    const capturePath = join(root, 'logs', 'r429', 'task-1.BLOCK-CAPTURE.txt');
    expect(existsSync(capturePath)).toBe(true);
  });

  // Warning telemetry (status allowed/allowed_warning) during a HEALTHY run must
  // NOT trip the structured detector — that was ADR-0001's near-miss.
  it('does NOT flag warning-only rate_limit_event telemetry: clean run stays ok', async () => {
    const root = tmpRoot();
    const result = await executeOne(candidate(), {
      runId: 'rwarn',
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      taskTimeoutMs: 30_000,
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit-with-warning-event.yaml') },
    });
    expect(result.status).toBe('ok');
    expect(result.classification).toBeUndefined();
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

  // ── ADR-0004: per-task timeout enforcement (2026-06-12 live bug) ───────────
  // Live run 2026-06-12-1711-41b981: an 8-min task ran 34.5 min because the
  // machine slept mid-task (single setTimeout can't fire while asleep, and its
  // firing promptly on resume is platform luck), and because a kill that fails
  // to take the child down left the executor awaiting job.exit forever. Two
  // invariants below: (1) the deadline is enforced against the WALL CLOCK, so a
  // sleep/resume jump still kills within seconds; (2) after a kill is issued the
  // executor force-resolves within a bounded grace even if the child never dies.

  it('ADR-0004: a kill that fails to terminate a wedged child still resolves within the bounded grace', async () => {
    const origTerminate = __terminateTree.impl;
    const leaked: ChildProcess[] = [];
    // Simulate the kill failing outright (taskkill error / wrong pid / etc.):
    // the terminate request "completes" but nothing dies. The wedged fake keeps
    // the stdout pipe open and emitting, exactly like the live api_retry loop.
    __terminateTree.impl = (child: ChildProcess) => { leaked.push(child); return Promise.resolve(); };
    try {
      const root = tmpRoot();
      const taskTimeoutMs = 1_000;
      const killGraceMs = 2_000;
      const t0 = Date.now();
      const result = await executeOne(candidate(), {
        runId: 'r-adr4-wedged', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs, killGraceMs,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'wedged.yaml') },
      });
      const elapsed = Date.now() - t0;
      expect(result.status).toBe('timeout');
      // Bounded: ~timeout + grace (+ slack), NOT the wedged child's 30s lifetime.
      expect(elapsed).toBeLessThan(2 * (taskTimeoutMs + killGraceMs));
      expect(result.elapsed_ms).toBeLessThan(2 * (taskTimeoutMs + killGraceMs));
    } finally {
      __terminateTree.impl = origTerminate;
      // Reap the deliberately-leaked children with the REAL terminate.
      for (const c of leaked) await origTerminate(c);
    }
  }, 20_000);

  it('ADR-0004: the deadline is wall-clock — a sleep/resume clock jump kills within seconds, not at timer due-time', async () => {
    const origNow = __nowMs.impl;
    const t0 = Date.now();
    // Simulate the 2026-06-12 sleep: after 1s of real run the wall clock has
    // jumped 30 minutes ahead (S3 sleep mid-task). A 5-minute setTimeout would
    // not fire for minutes of awake time; the wall-clock deadline check must
    // kill within ~a poll interval of the jump.
    __nowMs.impl = () => Date.now() + (Date.now() - t0 > 1_000 ? 30 * 60_000 : 0);
    try {
      const root = tmpRoot();
      const result = await executeOne(candidate(), {
        runId: 'r-adr4-sleep', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 5 * 60_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'timeout.yaml') },
      });
      expect(result.status).toBe('timeout');
      // The real (awake) elapsed time stays seconds, not minutes.
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      __nowMs.impl = origNow;
    }
  }, 20_000);

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

  // ── 2026-06-12 data-loss bug (run 2026-06-12-2109-f8628b): dossier dir collision ──
  // Two candidates whose titles slugify identically (or are blank) resolved to the
  // SAME dossier dir, so each task silently overwrote the previous task's OUT.md.
  // The dir must be unique per task: keep the readable slug, append the first 8
  // chars of the task id when the slug is empty OR the dir already exists. An
  // existing OUT.md from a different task must never be overwritten.
  describe('dossier dir collision (silent overwrite)', () => {
    const jsonlCandidate = (id: string, title: string, repo: string): Candidate => ({
      id, evidence_hash: `h-${id}`, type: 'research-dossier',
      project_path: repo,
      evidence: { kind: 'jsonl', session_id: `sess-${id}`, ai_title: title, idle_hours: 100, signal: 'idle-with-content' },
      est_value: 50, est_tokens: 4000, status: 'pending',
    });

    function ctxFor(root: string) {
      return {
        runId: 'r1', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      };
    }

    it('two SAME-TITLED candidates in one burst both keep their OUT.md in distinct dirs', async () => {
      const root = tmpRoot();
      const repo = tmpRepo();
      const ctx = ctxFor(root);
      const r1 = await executeOne(jsonlCandidate('aaaa1111-0000-4000-8000-000000000001', 'Continue the refactor', repo), ctx);
      const r2 = await executeOne(jsonlCandidate('bbbb2222-0000-4000-8000-000000000002', 'Continue the refactor', repo), ctx);
      const p1 = r1.output?.kind === 'file' ? r1.output.path : '';
      const p2 = r2.output?.kind === 'file' ? r2.output.path : '';
      expect(p1).not.toEqual(p2);
      // BOTH outputs survive — the second task never overwrote the first.
      expect(existsSync(p1)).toBe(true);
      expect(existsSync(p2)).toBe(true);
      // The first keeps the readable slug; the colliding second gets -<first-8-of-task-id>.
      expect(p1).toMatch(/research-continue-the-refactor[\\/]OUT\.md$/);
      expect(p2).toMatch(/research-continue-the-refactor-bbbb2222[\\/]OUT\.md$/);
    });

    it('two BLANK-titled candidates get distinct research-<first-8-of-task-id> dirs (live 2026-06-12 shape)', async () => {
      const root = tmpRoot();
      const repo = tmpRepo();
      const ctx = ctxFor(root);
      const r1 = await executeOne(jsonlCandidate('aaaa1111-0000-4000-8000-000000000001', '', repo), ctx);
      const r2 = await executeOne(jsonlCandidate('bbbb2222-0000-4000-8000-000000000002', '', repo), ctx);
      const p1 = r1.output?.kind === 'file' ? r1.output.path : '';
      const p2 = r2.output?.kind === 'file' ? r2.output.path : '';
      expect(p1).not.toEqual(p2);
      expect(existsSync(p1)).toBe(true);
      expect(existsSync(p2)).toBe(true);
      // A blank slug must never produce a bare 'research-' dir.
      expect(p1).toMatch(/research-aaaa1111[\\/]OUT\.md$/);
      expect(p2).toMatch(/research-bbbb2222[\\/]OUT\.md$/);
    });

    it('a dossier dir surviving from an earlier run is not overwritten either', async () => {
      const root = tmpRoot();
      const repo = tmpRepo();
      // Simulate yesterday's-run-today leftovers: the preferred dir already exists
      // with a different task's OUT.md in it.
      const { projectSlug } = await import('./state.js');
      const dateDir = new Date().toISOString().slice(0, 10);
      const preexisting = join(root, 'dossiers', projectSlug(repo), dateDir, 'research-continue-the-refactor');
      mkdirSync(preexisting, { recursive: true });
      writeFileSync(join(preexisting, 'OUT.md'), 'earlier task output — must survive');
      const r = await executeOne(jsonlCandidate('cccc3333-0000-4000-8000-000000000003', 'Continue the refactor', repo), ctxFor(root));
      const p = r.output?.kind === 'file' ? r.output.path : '';
      expect(p).toMatch(/research-continue-the-refactor-cccc3333[\\/]OUT\.md$/);
      expect(readFileSync(join(preexisting, 'OUT.md'), 'utf8')).toBe('earlier task output — must survive');
    });
  });

  it('clears the deadline checker on normal exit (no dangling timers)', async () => {
    // ADR-0004: the per-task deadline is a polled setInterval (wall-clock check),
    // so the no-dangling-handle guarantee is about clearInterval now.
    const clearSpy = vi.spyOn(global, 'clearInterval');
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

  // ── ADR-0002 P1 safety proof: the dossier spawn's ACTUAL argv carries the
  // read scope. researchAllowedTools() is unit-tested as a pure function in
  // deny.test.ts; this proves it (and both --add-dir grants) is really plumbed
  // into executeDossier's spawn — a regression that dropped either would leave
  // dossiers writing filename-based guesses (or a write-capable session) again.
  it('research-dossier: spawn argv grants --add-dir for BOTH the dossier dir and the project, plus the read-only allow-list (ADR-0002 P1)', async () => {
    const spy = vi.spyOn(jobobject, 'spawnInJob');
    try {
      const root = tmpRoot();
      const c = candidate();
      const result = await executeOne(c, {
        runId: 'r-adr2', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(result.status).toBe('ok');
      expect(spy).toHaveBeenCalled();
      // On Windows resolveSpawn wraps args as ['/c', bin, ...claudeArgs]; flag
      // scanning below is position-independent so it covers both platforms.
      const args = spy.mock.calls[0][1] as string[];

      // Read scope: one --add-dir per granted dir — the dossier output dir AND
      // the candidate's project_path (two distinct dirs at minimum).
      const addDirs: string[] = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--add-dir') addDirs.push(args[i + 1]);
      }
      expect(addDirs.map((d) => resolve(d))).toContain(resolve(c.project_path));
      expect(addDirs.some((d) => /[\\/]research-/.test(d))).toBe(true);
      expect(new Set(addDirs.map((d) => resolve(d))).size).toBeGreaterThanOrEqual(2);

      // Write-incapability: the allow-list is exactly researchAllowedTools() —
      // no bare Bash, no Edit/Write — so the project read grant cannot mutate.
      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThanOrEqual(0);
      const allow = args[idx + 1];
      expect(allow).toBe(researchAllowedTools());
      const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
      expect(tokens).not.toContain('Bash');
      expect(tokens).not.toContain('Edit');
      expect(tokens).not.toContain('Write');
    } finally {
      spy.mockRestore();
    }
  });

  // ── v0.9 model routing + --max-turns (ADR-0006): every spawn's ACTUAL argv
  // carries the resolved --model and the per-type --max-turns guard. The
  // resolution layer is unit-tested in model-routing.test.ts; these prove it is
  // really plumbed into runClaude's spawn-arg assembly (same proof style as the
  // ADR-0002 P1 test above).
  function argvFlag(args: string[], flag: string): string | undefined {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }

  it('spawn argv carries the task-type default --model and --max-turns (research-dossier → sonnet/24)', async () => {
    const spy = vi.spyOn(jobobject, 'spawnInJob');
    try {
      const root = tmpRoot();
      const result = await executeOne(candidate(), {
        runId: 'r-model-default', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(result.status).toBe('ok');
      const args = spy.mock.calls[0][1] as string[];
      expect(argvFlag(args, '--model')).toBe('sonnet');
      expect(argvFlag(args, '--max-turns')).toBe('24');
    } finally {
      spy.mockRestore();
    }
  });

  it('spawn argv carries haiku/8 for a fetch-docs task', async () => {
    const spy = vi.spyOn(jobobject, 'spawnInJob');
    try {
      const root = tmpRoot();
      const c: Candidate = { ...candidate(), type: 'fetch-docs' };
      const result = await executeOne(c, {
        runId: 'r-model-docs', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(result.status === 'ok' || result.status === 'ok-fallback').toBe(true);
      const args = spy.mock.calls[0][1] as string[];
      expect(argvFlag(args, '--model')).toBe('haiku');
      expect(argvFlag(args, '--max-turns')).toBe('8');
    } finally {
      spy.mockRestore();
    }
  });

  it('ctx.routing config overrides --model/--max-turns, and ctx.paceTier reaches resolution', async () => {
    const spy = vi.spyOn(jobobject, 'spawnInJob');
    try {
      const root = tmpRoot();
      // Config override threaded through ExecCtx…
      const r1 = await executeOne(candidate(), {
        runId: 'r-model-cfg', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        routing: { models: { 'research-dossier': 'claude-sonnet-4-5-20250929' }, max_turns: { 'research-dossier': 5 } },
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(r1.status).toBe('ok');
      const args1 = spy.mock.calls[0][1] as string[];
      expect(argvFlag(args1, '--model')).toBe('claude-sonnet-4-5-20250929');
      expect(argvFlag(args1, '--max-turns')).toBe('5');

      // …and the paceTier param reaches resolveModel ('small' demotes to haiku).
      const r2 = await executeOne(candidate(), {
        runId: 'r-model-tier', gleanRoot: root, claudeBin: FAKE_CLAUDE,
        templatesDir: join(__dirname, '..', '..', 'templates'),
        taskTimeoutMs: 30_000,
        paceTier: 'small',
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      });
      expect(r2.status).toBe('ok');
      const args2 = spy.mock.calls[1][1] as string[];
      expect(argvFlag(args2, '--model')).toBe('haiku');
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
