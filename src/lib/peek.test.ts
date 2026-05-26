import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitRoot, findPeekDossier } from './peek.js';

describe('findGitRoot', () => {
  it('walks up and finds .git in an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-git-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  it('returns null when no .git is found walking up to filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBeNull();
  });
});

describe('findPeekDossier', () => {
  function writeIndex(gleanRoot: string, slug: string, date: string, entries: Array<{ task_id: string; title: string; status: string; output: string; type: string }>): void {
    const dir = join(gleanRoot, 'dossiers', slug, date);
    mkdirSync(dir, { recursive: true });
    const yaml = [
      '---',
      'run_id: r-1',
      `project_path: C:\\${slug}`,
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      ...entries.flatMap((e) => [
        `  - task_id: "${e.task_id}"`,
        `    title: "${e.title}"`,
        `    status: ${e.status}`,
        `    output: "${e.output}"`,
        `    type: ${e.type}`,
      ]),
      '---',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'INDEX.md'), yaml);
  }

  function todayDate(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  it('returns the matching project filtered when cwd is inside a git repo with a dossier', () => {
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos-'));
    const repoRoot = join(reposParent, 'myproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root-'));
    writeIndex(gleanRoot, 'myproj', todayDate(), [
      { task_id: 'task-1', title: 'Handle TODO', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);

    const report = findPeekDossier(gleanRoot, repoRoot);
    expect(report).not.toBeNull();
    expect(report!.projects).toHaveLength(1);
    expect(report!.projects[0].project_slug).toBe('myproj');
    expect(report!.projects[0].entries[0].title).toBe('Handle TODO');
  });

  it('returns null when cwd has no .git OR when no matching dossier exists', () => {
    // Sub-case A: no .git anywhere up
    const noGitDir = mkdtempSync(join(tmpdir(), 'glean-peek-nogit-cwd-'));
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-peek-root2-'));
    expect(findPeekDossier(gleanRoot, noGitDir)).toBeNull();

    // Sub-case B: .git exists but no dossier for this repo's slug
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-peek-repos2-'));
    const repoRoot = join(reposParent, 'otherproj');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    writeIndex(gleanRoot, 'unrelated', todayDate(), [
      { task_id: 'task-1', title: 'Other', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
    ]);
    expect(findPeekDossier(gleanRoot, repoRoot)).toBeNull();
  });
});
