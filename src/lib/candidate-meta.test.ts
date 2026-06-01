import { describe, it, expect } from 'vitest';
import { titleFor, today, sourceSignalFor, filePathFor } from './candidate-meta.js';
import type { Candidate } from './types.js';

function base(): Omit<Candidate, 'evidence'> {
  return {
    id: 'x', evidence_hash: 'h', type: 'research-dossier',
    project_path: '/p', est_value: 1, est_tokens: 1, status: 'pending',
  };
}

describe('candidate-meta', () => {
  it('titleFor covers all four evidence kinds', () => {
    expect(titleFor({ ...base(), evidence: { kind: 'todo', file: 'a.ts', todo_lines: [{ line: 1, text: 't' }] } }))
      .toBe('Handle TODO in a.ts');
    expect(titleFor({ ...base(), evidence: { kind: 'jsonl', session_id: 's', ai_title: 'My title', idle_hours: 2 } }))
      .toBe('My title');
    expect(titleFor({ ...base(), evidence: { kind: 'pr', number: 7, title: 'Fix', url: 'u', updated_at: '2020', review_comments: [] } }))
      .toBe('PR #7: Fix');
    expect(titleFor({ ...base(), evidence: { kind: 'dep', manifest: 'package.json', package: 'left-pad', added_at: '2020' } }))
      .toBe('Pre-fetch docs for left-pad');
  });

  it('sourceSignalFor maps evidence kinds', () => {
    expect(sourceSignalFor({ ...base(), evidence: { kind: 'jsonl', session_id: 's', ai_title: 't', idle_hours: 1 } })).toBe('jsonl');
    expect(sourceSignalFor({ ...base(), evidence: { kind: 'todo', file: 'a', todo_lines: [] } })).toBe('git-todo');
    expect(sourceSignalFor({ ...base(), evidence: { kind: 'pr', number: 1, title: 't', url: 'u', updated_at: '2020', review_comments: [] } })).toBe('gh-pr');
    expect(sourceSignalFor({ ...base(), evidence: { kind: 'dep', manifest: 'go.mod', package: 'p', added_at: '2020' } })).toBe('deps');
  });

  it('filePathFor returns file for todo/dep, null otherwise', () => {
    expect(filePathFor({ ...base(), evidence: { kind: 'todo', file: 'a.ts', todo_lines: [] } })).toBe('a.ts');
    expect(filePathFor({ ...base(), evidence: { kind: 'dep', manifest: 'go.mod', package: 'p', added_at: '2020' } })).toBe('go.mod');
    expect(filePathFor({ ...base(), evidence: { kind: 'jsonl', session_id: 's', ai_title: 't', idle_hours: 1 } })).toBeNull();
    expect(filePathFor({ ...base(), evidence: { kind: 'pr', number: 1, title: 't', url: 'u', updated_at: '2020', review_comments: [] } })).toBeNull();
  });

  it('today returns an ISO yyyy-mm-dd date', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
