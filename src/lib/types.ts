export type CandidateType = 'research-dossier' | 'fetch-docs' | 'draft-impl';

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
  candidate_row_id?: number;
};

export type RunReason =
  | 'completed'
  | 'no-candidates'
  | 'budget-exhausted'
  | 'rate-limit'
  | 'stop-sentinel'
  | 'lock-busy'
  | 'crashed'
  // v0.8 drain core (shared contract — the D-morning lane depends on these
  // exact strings; they are persisted as the run's exit_reason).
  | 'session-paused'
  | 'weekly-drained'
  | 'no-progress'
  | 'ambiguous-signal'
  | 'discovery-failed'
  // A drain "tick" that found the window not yet eligible to run (no-op; no
  // pipeline invoked, no memory run row).
  | 'not-eligible'
  // v0.8.2 item 3: a drain tick held off because now() is within the anti-spill
  // margin before a known weekly reset (no-op; no burst, refuses to spill into
  // next week's fresh allowance).
  | 'anti-spill';

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
  // v0.8: when a run ends on a rate-limit, the classified signal (session vs
  // weekly vs ambiguous) the drain wrapper uses to decide the next move.
  classification?: import('./classify.js').RateLimitClassification;
  // v0.8: STABLE evidence_hashes of the tasks that genuinely COMPLETED this run
  // (status 'ok'/'ok-fallback' ONLY — failed/timeout/rate-limit tasks are NOT
  // recorded, so a later drain tick re-attempts them). The drain wrapper unions
  // these into its skip-set so a re-entry does not redo completed work
  // (candidate ids are random per discovery and cannot match across bursts).
  completed_evidence_hashes?: string[];
  // v0.8.2 item 1: true iff this burst produced at least one NON-TRIVIAL output
  // (a dossier with bytes, or a draft whose diff touched ≥1 file with ≥1 changed
  // line). Used by the drain wrapper's no-progress backstop: a burst that "ran
  // tasks but they were all empty" is NOT productive and counts toward the
  // circuit breaker. Optional + inert for the bare `glean run` path (only the
  // drain wrapper reads it).
  productive?: boolean;
};

export type DrainTrigger = {
  day?: string;            // e.g. 'Thursday'
  time?: string;           // e.g. '18:00'
  repeat_minutes?: number; // repetition interval within the trigger window
  duration_hours?: number; // how long the trigger window stays active
  // v0.8.2 item 1: configurable circuit-breaker threshold. The number of
  // consecutive genuinely-unproductive bursts before runDrain stops the window
  // with 'no-progress'. Optional — defaults to 3 (the prior hard-coded constant)
  // when unset, so a config without it is byte-identical to pre-v0.8.2 behavior.
  max_unproductive?: number;
  // v0.8.2 item 3: anti-spill pre-emptive margin in MINUTES. When now() is within
  // this many minutes before a KNOWN weekly reset, runDrain holds off the burst
  // (returns 'anti-spill') rather than starting work that could spill into next
  // week's fresh allowance. Optional — defaults to 15 in runDrain when unset.
  anti_spill_margin_minutes?: number;
};

// v0.9 project portfolio: per-project priority dial. 'off' is absolute (the
// project is never drained); absent on a CONFIGURED project means 'normal'.
export type ProjectPriority = 'off' | 'low' | 'normal' | 'high';

export type GleanConfig = {
  claude_bin?: string;
  projects?: Record<string, { base_branch?: string; test_command?: string; priority?: ProjectPriority }>;
  drain_trigger?: DrainTrigger;
};

// Discriminated output of a task (T7).
// - 'file':   a dossier/fetch-docs run wrote a markdown file at `path`.
// - 'branch': a draft-impl run committed to `branch` (off `base`) in a linked
//             worktree; the diff-stat fields feed the receipt/INDEX.
// draft_tests status: glean's OWN deterministic check — after the session
// commits, glean runs the project's test_command in the worktree.
//   'pass' → exit 0, 'fail' → non-zero, 'none' → no command configured / unrunnable.
export type DraftTestStatus = 'pass' | 'fail' | 'none';

export type TaskOutput =
  | { kind: 'file'; path: string }
  | { kind: 'branch'; branch: string; base: string; worktree: string; files: number; insertions: number; deletions: number; tests: DraftTestStatus };

export type TaskResult = {
  status: 'ok' | 'ok-fallback' | 'timeout' | 'failed' | 'rate-limit';
  elapsed_ms: number;
  output?: TaskOutput;
  stderr_tail?: string[];
  // v0.8: present only on a 'rate-limit' result — the classified rate-limit
  // signal (session vs weekly vs ambiguous) derived from the spawn's stderr.
  classification?: import('./classify.js').RateLimitClassification;
};
