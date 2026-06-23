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

// v0.9 discover-docs: an actionable item mined from a project's own planning
// docs (ROADMAP/TODO/BACKLOG/handoff "up next" lists and unchecked `- [ ]`
// task items). `file` is project-relative with forward slashes; `line` is the
// 1-based line of the item (volatile — stripped from the dedup hash, see
// dedup.ts, so an edit above the item does not re-hash it).
export type EvidenceDoc = {
  kind: 'doc';
  file: string;
  heading: string;
  item_text: string;
  line: number;
};

export type Evidence = EvidenceTodo | EvidenceJsonl | EvidencePr | EvidenceDep | EvidenceDoc;

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
  | 'anti-spill'
  // PIECE 2: a drain tick held off because now() is within the configured
  // morning buffer BEFORE the user's typical first-prompt time (no-op; no burst,
  // so prep is finished before the workday and the drain doesn't bleed into
  // fresh capacity). Opt-in (pacing.morning_buffer_hours > 0); never counts as
  // unproductive.
  | 'morning-anti-spill'
  // PIECE 3: a nightly/scheduled drain tick that the pacing gate told to spend
  // nothing this week (recommendTier tier === 'skip'). Opt-in (pacing.enabled).
  | 'pace-skip'
  // A spawn surfaced an expired/missing subscription login (UNVERIFIED shape —
  // capture-armed in spawn-claude). An expired token kills every later spawn, so
  // the run stops cleanly here rather than masquerading as "all failed". Exit 50.
  | 'auth-error';

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

// ---- v0.9 capacity governor: usage accounting + pacing ---------------------

// Model family buckets for weighted-token pacing. 'unknown' catches model ids
// that match none of the three families (weighted 1.0 — sonnet-equivalent —
// per ASSUMPTION[ADR-0005]).
export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'unknown';

// One LOCAL calendar day of RAW token totals per model family, summed from
// `~/.claude/projects/**/*.jsonl` usage blocks (internal loader, ADR-0007).
// Raw = input + output + cache_creation + cache_read; weighting is pacing.ts's
// job so the accounting layer stays assumption-free.
export type DailyUsage = {
  date: string; // local YYYY-MM-DD
  tokens: Record<ModelFamily, number>;
};

// v0.9 capacity governor: pacing gate config. All optional — absent keys fall
// back to pacing.ts defaults (enabled, haircut 0, DEFAULT_THRESHOLDS).
export type WeekAnchor = {
  day: 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';
  time: string; // 24-h HH:MM, e.g. '03:00'
};

export type PacingConfig = {
  enabled?: boolean;
  haircut?: number; // 0..1 manual blind-spot discount
  thresholds?: { skip_above?: number; small_above?: number; normal_above?: number };
  // PIECE 1 (#3): the user's subscription week reset day/time. Absent → pacing
  // keeps the Monday-00:00 calendar week. Threaded into recommendTier (pure).
  week_anchor?: WeekAnchor;
  // PIECE 2: morning anti-spill buffer in hours. > 0 → a drain refuses to start
  // within this many hours before the user's typical first-prompt time. Absent /
  // 0 → OFF (default).
  morning_buffer_hours?: number;
};

export type GleanConfig = {
  claude_bin?: string;
  // ADR-0009: drop the draft-impl in-session test-command allow-list (hard-close).
  strict_spawn?: boolean;
  // ADR-0013: opt-in OS-sandbox enforcement (mac/Linux/WSL2; Narrow fallback on Windows).
  enforce_spawn?: boolean;
  projects?: Record<string, { base_branch?: string; test_command?: string; priority?: ProjectPriority }>;
  drain_trigger?: DrainTrigger;
  pacing?: PacingConfig;
  // v0.9 model routing (ADR-0006): per-task-type --model (alias or full id),
  // per-task-type --max-turns guard, and the task types eligible for the
  // 'large' pace-tier promotion. All optional — defaults live in
  // model-routing.ts and apply at resolution time.
  models?: Partial<Record<CandidateType, string>>;
  max_turns?: Partial<Record<CandidateType, number>>;
  pacing_promote?: CandidateType[];
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
  // Set when the spawn surfaced an auth failure (expired/missing login). The
  // pipeline stops the run with reason 'auth-error' on the first one (an expired
  // token dooms every later spawn). UNVERIFIED signal — see classify.ts.
  authExpired?: boolean;
};
