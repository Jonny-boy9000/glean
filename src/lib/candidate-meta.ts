import type { Candidate } from './types.js';

// Shared candidate-derived metadata. Extracted from executor.ts and pipeline.ts
// (T2) so adding a new candidate type (e.g. draft-impl) updates exactly one place.

export function titleFor(c: Candidate): string {
  switch (c.evidence.kind) {
    case 'todo': return `Handle TODO in ${c.evidence.file}`;
    case 'jsonl': return c.evidence.ai_title;
    case 'pr': return `PR #${c.evidence.number}: ${c.evidence.title}`;
    case 'dep': return `Pre-fetch docs for ${c.evidence.package}`;
  }
}

export function sourceSignalFor(c: Candidate): 'jsonl' | 'git-todo' | 'gh-pr' | 'deps' {
  switch (c.evidence.kind) {
    case 'jsonl': return 'jsonl';
    case 'todo': return 'git-todo';
    case 'pr': return 'gh-pr';
    case 'dep': return 'deps';
  }
}

export function filePathFor(c: Candidate): string | null {
  switch (c.evidence.kind) {
    case 'todo': return c.evidence.file;
    case 'jsonl': return null;
    case 'pr': return null;
    case 'dep': return c.evidence.manifest;
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
