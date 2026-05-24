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

describe('discoverGitTodos path exclusions', () => {
  it('excludes TODOs in *.md files', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-git-md-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, 'NOTES.md'), '<!-- TODO: ignore me -->\n');
    writeFileSync(join(r, 'src.ts'), '// TODO: keep me\n');
    execSync('git add . && git commit -q -m i', { cwd: r });
    const cands = await discoverGitTodos(r);
    const files = cands.map(c => (c.evidence as { file: string }).file);
    expect(files.some(f => f.endsWith('NOTES.md'))).toBe(false);
    expect(files.some(f => f.endsWith('src.ts'))).toBe(true);
  });

  it('excludes TODOs in *.test.ts files', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-git-test-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, 'foo.test.ts'), '// TODO: ignore me\n');
    writeFileSync(join(r, 'foo.ts'), '// TODO: keep me\n');
    execSync('git add . && git commit -q -m i', { cwd: r });
    const cands = await discoverGitTodos(r);
    const files = cands.map(c => (c.evidence as { file: string }).file);
    expect(files.some(f => f.endsWith('foo.test.ts'))).toBe(false);
    expect(files.some(f => f.endsWith('foo.ts'))).toBe(true);
  });

  it('excludes TODOs under docs/ subtree', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-git-docs-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    mkdirSync(join(r, 'docs'));
    writeFileSync(join(r, 'docs', 'notes.txt'), 'TODO: ignore me\n');
    writeFileSync(join(r, 'real.ts'), '// TODO: keep me\n');
    execSync('git add . && git commit -q -m i', { cwd: r });
    const cands = await discoverGitTodos(r);
    const files = cands.map(c => (c.evidence as { file: string }).file);
    expect(files.some(f => f.startsWith('docs/'))).toBe(false);
    expect(files.some(f => f.endsWith('real.ts'))).toBe(true);
  });
});
