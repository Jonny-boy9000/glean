export type CandidateType = 'research-dossier' | 'fetch-docs';

export type EvidenceTodo = {
  kind: 'todo';
  file: string;
  todo_lines: { line: number; text: string }[];
  // Hydrated by executor at run-time:
  file_excerpt?: string;
};

export type EvidenceJsonl = {
  kind: 'jsonl';
  session_id: string;
  ai_title: string;
  idle_hours: number;
  signal?: string;
  // Hydrated by executor at run-time:
  recent_turns?: string[];
};

export type EvidencePr = {
  kind: 'pr';
  number: number;
  title: string;
  url: string;
  updated_at: string;
  review_comments: { author: string; body: string; path?: string; line?: number }[];
};

export type EvidenceDep = {
  kind: 'dep';
  manifest: 'package.json' | 'requirements.txt' | 'go.mod' | 'Cargo.toml' | 'pyproject.toml';
  package: string;
  added_at: string;
};

export type Evidence = EvidenceTodo | EvidenceJsonl | EvidencePr | EvidenceDep;

export type CandidateStatus = 'pending' | 'running' | 'ok' | 'ok-fallback' | 'timeout' | 'failed' | 'rate-limit' | 'skipped';

export type Candidate = {
  id: string;
  evidence_hash: string;
  type: CandidateType;
  project_path: string;
  evidence: Evidence;
  est_value: number;
  est_tokens: number;
  rank?: number;
  status: CandidateStatus;
};

export type RunReason =
  | 'completed'
  | 'no-candidates'
  | 'budget-exhausted'
  | 'rate-limit'
  | 'stop-sentinel'
  | 'lock-busy'
  | 'crashed';

export type RunSummary = {
  run_id: string;
  started_at: string;
  ended_at: string;
  reason: RunReason;
  budget_ms: number;
  elapsed_ms: number;
  candidates_total: number;
  ran: number;
  skipped_dedup: number;
  failed: number;
  timed_out: number;
  exit_code: number;
};

export type GleanConfig = {
  claude_bin?: string;
  projects?: Record<string, { base_branch?: string }>;
};

export type TaskResult = {
  status: 'ok' | 'ok-fallback' | 'timeout' | 'failed' | 'rate-limit';
  elapsed_ms: number;
  output_path?: string;
  stderr_tail?: string[];
};
