import { describe, it, expect } from 'vitest';
import { BASE_DENY, DRAFT_IMPL_DENY } from './deny.js';

describe('deny-list', () => {
  it('BASE_DENY contains the four core blocked prefixes', () => {
    expect(BASE_DENY).toContain('Bash(git push:*)');
    expect(BASE_DENY).toContain('Bash(git checkout main:*)');
    expect(BASE_DENY).toContain('Bash(gh pr merge:*)');
    expect(BASE_DENY).toContain('Bash(gh pr create:*)');
  });

  it('DRAFT_IMPL_DENY is a strict superset of BASE_DENY', () => {
    for (const prefix of BASE_DENY.split(' ')) {
      expect(DRAFT_IMPL_DENY).toContain(prefix);
    }
    expect(DRAFT_IMPL_DENY.length).toBeGreaterThan(BASE_DENY.length);
  });

  it('DRAFT_IMPL_DENY closes the ref-mutation bypass holes', () => {
    expect(DRAFT_IMPL_DENY).toContain('Bash(git switch:*)');
    expect(DRAFT_IMPL_DENY).toContain('Bash(git branch:*)');
    expect(DRAFT_IMPL_DENY).toContain('Bash(git reset:*)');
    expect(DRAFT_IMPL_DENY).toContain('Bash(git worktree:*)');
  });
});
