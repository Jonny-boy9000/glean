import type { Candidate } from './types.js';

const TYPE_WEIGHT: Record<Candidate['type'], number> = {
  'research-dossier': 1.0,
  'fetch-docs': 0.2,
};

export function scoreValue(c: Candidate, hints: { fileMtime?: number } = {}): number {
  if (c.type === 'fetch-docs') return 30;
  switch (c.evidence.kind) {
    case 'todo': {
      const todoCount = c.evidence.todo_lines.length;
      const days = hints.fileMtime ? Math.floor((Date.now() - hints.fileMtime) / 86400_000) : 30;
      const recency = Math.max(0, 30 - days);
      return Math.min(100, todoCount * 20 + recency);
    }
    case 'jsonl': {
      const idleBonus = Math.min(20, c.evidence.idle_hours);
      return Math.min(100, 30 + idleBonus);
    }
    case 'pr': {
      const comments = c.evidence.review_comments.length;
      const daysOpen = Math.min(14, Math.floor((Date.now() - new Date(c.evidence.updated_at).getTime()) / 86400_000));
      return Math.min(100, 40 + comments * 15 + daysOpen);
    }
    case 'dep':
      return 30;
  }
}

export function prioritize(candidates: Candidate[], budgetMs: number, elapsedMs: number): Candidate[] {
  const remaining = budgetMs - elapsedMs;
  const onlyDocs = remaining < 30 * 60_000;
  const eligible = onlyDocs ? candidates.filter((c) => c.type === 'fetch-docs') : [...candidates];

  eligible.sort((a, b) => score(b) - score(a));
  eligible.forEach((c, i) => (c.rank = i + 1));
  return eligible;
}

function score(c: Candidate): number {
  return TYPE_WEIGHT[c.type] * (c.est_value / Math.log(c.est_tokens + 1));
}
