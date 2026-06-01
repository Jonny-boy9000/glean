import { describe, it, expect } from 'vitest';
import { renderEntry, type IndexEntryRecord } from './pipeline.js';

describe('renderEntry (T11 type-aware INDEX rendering)', () => {
  it('renders a branch (draft-impl) entry with cd-into-worktree review + worktree-remove discard', () => {
    const entry: IndexEntryRecord = {
      task_id: 't1', evidence_hash: 'h', type: 'draft-impl', title: 'Handle TODO in a.ts', status: 'ok',
      branch: 'prep/glean-t1', base: 'main',
      worktree: 'C:/glean/work/handle-todo-t1',
      files: 2, insertions: 47, deletions: 3,
    };
    const out = renderEntry(entry);
    expect(out).toContain('prep/glean-t1');
    expect(out).toContain('+47 / -3 across 2 file(s)');
    // Review: cd into the worktree (NOT git checkout prep/... which fails)
    expect(out).toContain('cd C:/glean/work/handle-todo-t1');
    expect(out).not.toContain('git checkout prep/glean-t1');
    // Discard: worktree remove --force + branch -D (NOT rm -rf)
    expect(out).toContain('worktree remove --force C:/glean/work/handle-todo-t1');
    expect(out).toContain('branch -D prep/glean-t1');
  });

  it('renders a file entry unchanged (Read: <path>)', () => {
    const entry: IndexEntryRecord = {
      task_id: 't2', evidence_hash: 'h', type: 'research-dossier', title: 'Some dossier', status: 'ok',
      output: '/glean/dossiers/proj/2026-06-01/research-x/OUT.md',
    };
    const out = renderEntry(entry);
    expect(out).toContain('Read: `/glean/dossiers/proj/2026-06-01/research-x/OUT.md`');
    expect(out).not.toContain('worktree');
    expect(out).not.toContain('cd ');
  });
});
