import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverGitTodos, discoverGitPrs } from './discover-git.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'glean-git-todo-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'foo.ts'), 'export const x = 1; // TODO: handle null\n// FIXME: extract\n');
  writeFileSync(join(repo, 'src', 'bar.ts'), 'export const y = 2;\n');
  execSync('git add . && git commit -q -m init', { cwd: repo });
});

describe('discoverGitTodos', () => {
  it('finds TODO/FIXME lines and groups by file', async () => {
    const cands = await discoverGitTodos(repo);
    expect(cands.length).toBe(1);
    const ev = cands[0].evidence as { kind: 'todo'; file: string; todo_lines: { line: number; text: string }[] };
    expect(ev.kind).toBe('todo');
    expect(ev.file.endsWith('foo.ts')).toBe(true);
    expect(ev.todo_lines.length).toBe(2);
  });

  it('returns empty array on non-git directory', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'glean-nogit-'));
    expect(await discoverGitTodos(noGit)).toEqual([]);
  });
});

describe('discoverGitPrs', () => {
  it('returns [] when gh binary path returns auth-failure exit code', async () => {
    const cands = await discoverGitPrs(repo, { ghBin: 'node', ghArgs: ['-e', 'process.exit(1)'] });
    expect(cands).toEqual([]);
  });

  it('parses gh pr list JSON', async () => {
    const json = JSON.stringify([
      { number: 7, title: 'My PR', url: 'https://example/7', updatedAt: '2026-05-20T00:00:00Z' },
    ]);
    const cands = await discoverGitPrs(repo, {
      ghBin: 'node',
      ghArgs: ['-e', `console.log(${JSON.stringify(json)})`],
      skipComments: true,
    });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as any).number).toBe(7);
  });
});
