import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { executeOne } from './executor.js';
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
    expect(existsSync(result.output_path!)).toBe(true);
    expect(readFileSync(result.output_path!, 'utf8')).toContain('fake dossier');
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
    expect(r1.output_path).not.toEqual(r2.output_path);
    expect(r1.output_path).toMatch(/-L42/);
    expect(r2.output_path).toMatch(/-L99/);
  });
});
