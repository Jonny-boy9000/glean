import { describe, it, expect } from 'vitest';
import { BASE_DENY, DRAFT_IMPL_DENY, draftImplAllowedTools, researchAllowedTools, DEFAULT_TEST_COMMAND_ALLOW, testCommandAllowFor } from './deny.js';

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

  it('DRAFT_IMPL_DENY blocks the -C / --git-dir / --work-tree escape forms', () => {
    expect(DRAFT_IMPL_DENY).toContain('Bash(git -C:*)');
    expect(DRAFT_IMPL_DENY).toContain('Bash(git --git-dir:*)');
    expect(DRAFT_IMPL_DENY).toContain('Bash(git --work-tree:*)');
  });
});

describe('draftImplAllowedTools (CRITICAL 1: scoped Bash allow-list)', () => {
  it('never grants bare Bash — only scoped Bash(...) prefixes plus Edit/Write', () => {
    const allow = draftImplAllowedTools(DEFAULT_TEST_COMMAND_ALLOW);
    // Tokenize on whitespace that is OUTSIDE Bash(...) parens (verb specs like
    // `Bash(git add:*)` contain an inner space that is not a token boundary).
    const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
    // Bare `Bash` (wholesale shell) must NOT be present as a standalone token.
    expect(tokens).not.toContain('Bash');
    // Every Bash entry must be a scoped Bash(...) prefix, never wholesale.
    for (const t of tokens) {
      if (t.startsWith('Bash')) expect(t).toMatch(/^Bash\(.+\)$/);
    }
    // Edit + Write are still granted (scoped via --add-dir elsewhere).
    expect(tokens).toContain('Edit');
    expect(tokens).toContain('Write');
  });

  it('grants the minimal git commit-cycle verbs proven by the spike', () => {
    const allow = draftImplAllowedTools(DEFAULT_TEST_COMMAND_ALLOW);
    expect(allow).toContain('Bash(git add:*)');
    expect(allow).toContain('Bash(git commit:*)');
    expect(allow).toContain('Bash(git status:*)');
    expect(allow).toContain('Bash(git diff:*)');
  });

  it('does NOT grant ref-mutating or publishing git verbs in the allow-list', () => {
    const allow = draftImplAllowedTools(DEFAULT_TEST_COMMAND_ALLOW);
    expect(allow).not.toContain('Bash(git push');
    expect(allow).not.toContain('Bash(git reset');
    expect(allow).not.toContain('Bash(git branch');
    expect(allow).not.toContain('Bash(git checkout');
    expect(allow).not.toContain('Bash(git -C');
  });

  it('appends caller-supplied (per-project) test-command prefixes', () => {
    const allow = draftImplAllowedTools(['Bash(pytest:*)', 'Bash(cargo test:*)']);
    expect(allow).toContain('Bash(pytest:*)');
    expect(allow).toContain('Bash(cargo test:*)');
  });

  it('default test allow-list covers the npm/node toolchain', () => {
    expect(DEFAULT_TEST_COMMAND_ALLOW).toContain('Bash(npm test:*)');
    expect(DEFAULT_TEST_COMMAND_ALLOW).toContain('Bash(npm run:*)');
    expect(DEFAULT_TEST_COMMAND_ALLOW).toContain('Bash(npx vitest:*)');
    expect(DEFAULT_TEST_COMMAND_ALLOW).toContain('Bash(node:*)');
  });
});

describe('researchAllowedTools (read-only scope for research-dossier spawns)', () => {
  it('grants the read tools Read/Grep/Glob', () => {
    const allow = researchAllowedTools();
    const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
    expect(tokens).toContain('Read');
    expect(tokens).toContain('Grep');
    expect(tokens).toContain('Glob');
  });

  it('grants only the read-only git/rg Bash verbs', () => {
    const allow = researchAllowedTools();
    expect(allow).toContain('Bash(git log:*)');
    expect(allow).toContain('Bash(git diff:*)');
    expect(allow).toContain('Bash(git show:*)');
    expect(allow).toContain('Bash(git status:*)');
    expect(allow).toContain('Bash(rg:*)');
  });

  it('never grants bare Bash (wholesale shell)', () => {
    const allow = researchAllowedTools();
    // Tokenize keeping Bash(...) specs intact; a bare grant is the standalone 'Bash'.
    const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
    expect(tokens).not.toContain('Bash');
    for (const t of tokens) {
      if (t.startsWith('Bash')) expect(t).toMatch(/^Bash\(.+\)$/);
    }
  });

  it('never grants write tools (Edit/Write/NotebookEdit)', () => {
    const allow = researchAllowedTools();
    expect(allow).not.toContain('Edit');
    expect(allow).not.toContain('Write');
    expect(allow).not.toContain('NotebookEdit');
  });

  it('does NOT grant ref-mutating or publishing git verbs', () => {
    const allow = researchAllowedTools();
    expect(allow).not.toContain('Bash(git push');
    expect(allow).not.toContain('Bash(git commit');
    expect(allow).not.toContain('Bash(git add');
    expect(allow).not.toContain('Bash(git reset');
  });
});

describe('draft-impl regression guard (research change must not alter it)', () => {
  it('draftImplAllowedTools output is byte-for-byte unchanged', () => {
    expect(draftImplAllowedTools(DEFAULT_TEST_COMMAND_ALLOW)).toBe(
      'Edit Write Bash(git add:*) Bash(git commit:*) Bash(git status:*) Bash(git diff:*) ' +
      'Bash(npm test:*) Bash(npm run:*) Bash(npx vitest:*) Bash(node:*)',
    );
  });

  it('DRAFT_IMPL_DENY output is byte-for-byte unchanged', () => {
    expect(DRAFT_IMPL_DENY).toBe(
      'Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*) ' +
      'Bash(git switch:*) Bash(git branch:*) Bash(git reset:*) Bash(git worktree:*) ' +
      'Bash(git -C:*) Bash(git --git-dir:*) Bash(git --work-tree:*)',
    );
  });
});

describe('testCommandAllowFor (per-project test_command → scoped prefix)', () => {
  it('falls back to the npm/node default when test_command is undefined', () => {
    expect(testCommandAllowFor(undefined)).toBe(DEFAULT_TEST_COMMAND_ALLOW);
  });

  it('wraps a configured test command into a single scoped Bash prefix', () => {
    expect(testCommandAllowFor('pytest')).toEqual(['Bash(pytest:*)']);
    expect(testCommandAllowFor('cargo test')).toEqual(['Bash(cargo test:*)']);
  });

  it('trims surrounding whitespace and ignores an empty command', () => {
    expect(testCommandAllowFor('  pnpm test  ')).toEqual(['Bash(pnpm test:*)']);
    expect(testCommandAllowFor('   ')).toBe(DEFAULT_TEST_COMMAND_ALLOW);
  });
});
