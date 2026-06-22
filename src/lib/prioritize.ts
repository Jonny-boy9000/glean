import type { Candidate } from './types.js';

const TYPE_WEIGHT: Record<Candidate['type'], number> = {
  'draft-impl': 1.0,
  'research-dossier': 1.0,
  'fetch-docs': 0.2,
};

const SOFT_NOISE_PATTERNS = [
  /vendor\//, /third_party\//, /\.config\./, /\.lock$/,
];

function pathPenalty(c: Candidate): number {
  if (c.evidence.kind !== 'todo') return 1.0;
  const todoEvidence = c.evidence as { kind: 'todo'; file: string };
  return SOFT_NOISE_PATTERNS.some((re) => re.test(todoEvidence.file)) ? 0.7 : 1.0;
}

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
    case 'doc':
      // v0.9 discover-docs: 28 — a planning-doc item is explicit human intent
      // (someone wrote it into a roadmap/handoff), so it ranks just UNDER the
      // jsonl idle-session base of 30 (jsonl scores 30–50 with the idle bonus):
      // a session the user actually had open still wins, but a roadmap item
      // beats path-penalized TODO noise. Within-pass ordering (ROADMAP > TODO >
      // handoff > others) is preserved by discover-docs' emit order + the
      // stable sort in prioritize().
      return 28;
  }
}

export function prioritize(candidates: Candidate[], budgetMs: number, elapsedMs: number): Candidate[] {
  const remaining = budgetMs - elapsedMs;
  // Reserve the last 5 minutes of a run for cheap fetch-docs tasks only.
  // (Previously this used 30 * 60_000 which wrongly filtered everything on
  //  a 30-minute budget because remaining ≈ budgetMs at run start.)
  const onlyDocs = remaining < 5 * 60_000;
  const eligible = onlyDocs ? candidates.filter((c) => c.type === 'fetch-docs') : [...candidates];

  // wave-2: scoring is now IDEMPOTENT. The vendor/noise path penalty is folded
  // INTO score() (computed from the candidate each call) instead of mutating
  // c.est_value. That made the old `for ... c.est_value *= penalty` a footgun:
  // a second prioritize() call compounded the 0.7 factor (0.49, 0.343, …) and
  // reordered the queue. est_value is now immutable after scoreValue(), so the
  // in-run re-rank loop (pipeline.ts) can call prioritize() once per task safely.
  eligible.sort((a, b) => score(b) - score(a));
  eligible.forEach((c, i) => (c.rank = i + 1));
  return eligible;
}

export function score(c: Candidate): number {
  // pathPenalty is applied HERE (not by mutating est_value) so prioritize() is
  // idempotent — see prioritize() comment.
  return TYPE_WEIGHT[c.type] * ((c.est_value * pathPenalty(c)) / Math.log(c.est_tokens + 1));
}
