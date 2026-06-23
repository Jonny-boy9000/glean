import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderReceiptMarkdown } from './render-receipt.js';
import { parse as parseYaml } from 'yaml';
import { Memory } from './memory.js';
import { projectSlug, readDrainState } from './state.js';
import type { MorningReport, MorningBranchEntry, MorningFileEntry } from './render-morning.js';
import type { CandidateType } from './types.js';

// Source the most recent glean run(s) for the "while you slept" receipt.
// T6 (drain window aggregation): if a drain budget.json exists and has a
// drain_window_started_at, aggregate ALL runs in that window into one report.
// Falls back to single-latest-run mode (byte-identical to pre-T6 behavior)
// when: budget.json is absent or corrupt, OR there are zero runs in the window.
//
// memory.db is authoritative for the run + diff-stat; the dossier INDEX.md is
// the only place the worktree path is persisted, so branch entries join on it.
// Returns null when memory.db is absent or holds no runs (peek-style silent
// degradation — the caller prints a friendly "no recent run").
export function findMorningRun(gleanRoot: string): MorningReport | null {
  const dbPath = join(gleanRoot, 'memory.db');
  if (!existsSync(dbPath)) return null;

  let memory: Memory;
  try {
    memory = new Memory(dbPath);
  } catch {
    return null;
  }
  try {
    // T6: check for a drain window — try to aggregate multiple bursts first.
    const drainResult = readDrainState(gleanRoot);
    if (drainResult.kind === 'ok') {
      const sinceMs = Date.parse(drainResult.state.drain_window_started_at);
      if (Number.isFinite(sinceMs)) {
        const windowRuns = memory.getRunsWithCandidatesSince(sinceMs);
        if (windowRuns.length > 0) {
          return aggregateWindowRuns(windowRuns, gleanRoot);
        }
        // Window exists but zero runs in it — honest 0-burst report.
        return buildZeroBurstReport(drainResult.state.drain_window_started_at);
      }
    }

    // Fallback: single-latest-run (bare `glean run` — no drain window active).
    const latest = memory.getLatestRunWithCandidates();
    if (!latest) return null;
    return buildSingleRunReport(latest.run, latest.candidates, gleanRoot);
  } finally {
    memory.close();
  }
}

// Build a MorningReport from a single run's data. This is the pre-T6 path and
// must stay byte-identical to the old code so bare-`glean run` receipts don't change.
function buildSingleRunReport(
  run: { run_id: string; started_at: number; ended_at: number | null; project_path: string; exit_reason: string | null },
  candidates: Array<{
    candidate_slug: string;
    candidate_type: CandidateType;
    title: string;
    outcome: string | null;
    dossier_path: string | null;
    stderr_rate_limit_hits: number;
    draft_files: number | null;
    draft_insertions: number | null;
    draft_deletions: number | null;
    prep_branch: string | null;
    draft_tests: string | null;
  }>,
  gleanRoot: string,
): MorningReport {
  const slug = projectSlug(run.project_path);
  const indexEntries = loadIndexEntries(gleanRoot, slug, run.started_at);

  const branches: MorningBranchEntry[] = [];
  const files: MorningFileEntry[] = [];
  let rateLimitHits = 0;

  for (const c of candidates) {
    rateLimitHits += c.stderr_rate_limit_hits ?? 0;
    const isBranch = c.candidate_type === 'draft-impl' || c.prep_branch !== null;
    if (isBranch && c.prep_branch) {
      const idx = indexEntries.get(c.candidate_slug);
      branches.push({
        title: c.title,
        prep_branch: c.prep_branch,
        worktree: idx?.worktree ?? '',
        files: c.draft_files ?? idx?.files ?? 0,
        insertions: c.draft_insertions ?? idx?.insertions ?? 0,
        deletions: c.draft_deletions ?? idx?.deletions ?? 0,
        status: c.outcome ?? 'unknown',
        // draft_tests is glean's own deterministic test check (v5). A NULL value
        // means the row predates the migration → genuinely 'unknown'. A present
        // value is surfaced verbatim ('pass' | 'fail' | 'none').
        test_status: normalizeTestStatus(c.draft_tests),
      });
    } else if (c.candidate_type === 'draft-impl') {
      // I6: a draft-impl candidate that produced NO branch (provisioning or
      // commit failed) must still surface — otherwise a failed draft vanishes
      // from the receipt entirely. Render it as a branchless "attempted" entry
      // (empty prep_branch/worktree → render-morning emits the "nothing landed"
      // line and no fabricated review/discard commands).
      branches.push({
        title: c.title,
        prep_branch: '',
        worktree: '',
        files: 0,
        insertions: 0,
        deletions: 0,
        status: c.outcome ?? 'unknown',
        test_status: normalizeTestStatus(c.draft_tests),
      });
    } else if (c.dossier_path) {
      const idx = indexEntries.get(c.candidate_slug);
      files.push({
        title: c.title,
        status: c.outcome ?? 'unknown',
        output: idx?.output ?? c.dossier_path,
        type: c.candidate_type,
      });
    }
  }

  // No `bursts` field → single-run mode, byte-identical to pre-T6.
  return {
    run_id: run.run_id,
    project_path: run.project_path,
    main_repo: run.project_path,
    started_at: run.started_at,
    ended_at: run.ended_at,
    exit_reason: run.exit_reason,
    rate_limit_hits: rateLimitHits,
    branches,
    files,
  };
}

type RunRow = { run_id: string; started_at: number; ended_at: number | null; project_path: string; exit_reason: string | null };
type CandidateRow = {
  candidate_slug: string;
  candidate_type: CandidateType;
  title: string;
  outcome: string | null;
  dossier_path: string | null;
  stderr_rate_limit_hits: number;
  draft_files: number | null;
  draft_insertions: number | null;
  draft_deletions: number | null;
  prep_branch: string | null;
  draft_tests: string | null;
};

// T6: aggregate multiple drain-window runs into a single MorningReport.
// Branches are deduped by prep_branch (last-write wins); files by candidate_slug.
// Rate-limit hits are summed. started_at = window start (earliest run).
// ended_at = most recent run's ended_at. exit_reason = last run's exit_reason.
// run_id = latest run_id (most recent burst).
function aggregateWindowRuns(
  windowRuns: Array<{ run: RunRow; candidates: CandidateRow[] }>,
  gleanRoot: string,
): MorningReport {
  // windowRuns is sorted ASC by started_at (oldest first).
  const firstRun = windowRuns[0].run;
  const lastRun = windowRuns[windowRuns.length - 1].run;

  // Dedupe maps: last-write wins.
  const branchMap = new Map<string, MorningBranchEntry>();  // keyed by prep_branch
  const fileMap = new Map<string, MorningFileEntry>();       // keyed by candidate_slug
  let rateLimitHits = 0;
  // v0.8.1: summed ACTIVE minutes across bursts (each burst's ended_at - started_at).
  // More honest than the wall-clock window span; skips bursts that never finalized.
  let drainedMs = 0;

  for (const { run, candidates } of windowRuns) {
    if (run.ended_at !== null) drainedMs += Math.max(0, run.ended_at - run.started_at);
    const slug = projectSlug(run.project_path);
    const indexEntries = loadIndexEntries(gleanRoot, slug, run.started_at);

    for (const c of candidates) {
      rateLimitHits += c.stderr_rate_limit_hits ?? 0;
      const isBranch = c.candidate_type === 'draft-impl' || c.prep_branch !== null;
      if (isBranch && c.prep_branch) {
        const idx = indexEntries.get(c.candidate_slug);
        branchMap.set(c.prep_branch, {
          title: c.title,
          prep_branch: c.prep_branch,
          worktree: idx?.worktree ?? '',
          files: c.draft_files ?? idx?.files ?? 0,
          insertions: c.draft_insertions ?? idx?.insertions ?? 0,
          deletions: c.draft_deletions ?? idx?.deletions ?? 0,
          status: c.outcome ?? 'unknown',
          test_status: normalizeTestStatus(c.draft_tests),
        });
      } else if (c.candidate_type === 'draft-impl') {
        // I6: branchless failed draft — key by candidate_slug (no prep_branch).
        branchMap.set(`__branchless__${c.candidate_slug}`, {
          title: c.title,
          prep_branch: '',
          worktree: '',
          files: 0,
          insertions: 0,
          deletions: 0,
          status: c.outcome ?? 'unknown',
          test_status: normalizeTestStatus(c.draft_tests),
        });
      } else if (c.dossier_path) {
        const idx = indexEntries.get(c.candidate_slug);
        fileMap.set(c.candidate_slug, {
          title: c.title,
          status: c.outcome ?? 'unknown',
          output: idx?.output ?? c.dossier_path,
          type: c.candidate_type,
        });
      }
    }
  }

  return {
    run_id: lastRun.run_id,
    project_path: lastRun.project_path,
    main_repo: lastRun.project_path,
    started_at: firstRun.started_at,
    ended_at: lastRun.ended_at,
    exit_reason: lastRun.exit_reason,
    rate_limit_hits: rateLimitHits,
    branches: Array.from(branchMap.values()),
    files: Array.from(fileMap.values()),
    bursts: windowRuns.length,
    drained_minutes: Math.round(drainedMs / 60_000),
  };
}

// v0.8.1: write a durable, shareable RECEIPT.md for the latest run/drain window to
// the date-dossier dir, so the "while you slept" outcome survives the terminal and
// can be pasted into a PR/Slack. Best-effort: returns the path, or null on any
// failure (no run, write error) — MUST never throw out of a run's finalize path.
export function writeReceipt(gleanRoot: string): string | null {
  try {
    const report = findMorningRun(gleanRoot);
    if (report === null) return null;
    const slug = projectSlug(report.project_path);
    const date = localDateString(new Date(report.ended_at ?? report.started_at));
    const dir = join(gleanRoot, 'dossiers', slug, date);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'RECEIPT.md');
    writeFileSync(path, renderReceiptMarkdown(report) + '\n');
    return path;
  } catch {
    return null;
  }
}

// T6: when a drain window exists but zero runs have executed yet (the laptop was
// asleep the whole window), return an honest 0-burst report rather than null.
function buildZeroBurstReport(windowStartedAt: string): MorningReport {
  const startMs = Date.parse(windowStartedAt);
  return {
    run_id: '(none)',
    project_path: '',
    main_repo: '',
    started_at: Number.isFinite(startMs) ? startMs : Date.now(),
    ended_at: null,
    exit_reason: null,
    rate_limit_hits: 0,
    branches: [],
    files: [],
    bursts: 0,
  };
}

// Map the DB draft_tests column to the renderer's test_status. ADR-0014: pass
// through the 5 producer tokens; keep a legacy 'none' bucket for pre-ADR-0014 rows
// (irreducibly ambiguous — NOT reinterpreted as a precise state); a NULL or
// otherwise-unrecognized value (a pre-v5 / pre-feature row) degrades to 'unknown'.
function normalizeTestStatus(v: string | null): MorningBranchEntry['test_status'] {
  switch (v) {
    case 'pass': case 'fail': case 'env-blocked': case 'skipped': case 'no-command':
      return v;
    case 'none':
      return 'none'; // legacy literal — render as 'none', never 'unknown'
    default:
      return 'unknown';
  }
}

type IndexEntryLite = {
  worktree?: string;
  output?: string;
  files?: number;
  insertions?: number;
  deletions?: number;
};

// Read INDEX.md for the run's date and index its entries by task_id. The run's
// dossier lives under dossiers/<slug>/<run-date>/INDEX.md (executor uses the
// local date the task finished, which is the run's started_at date in practice).
function loadIndexEntries(gleanRoot: string, slug: string, startedAtMs: number): Map<string, IndexEntryLite> {
  const map = new Map<string, IndexEntryLite>();
  const projDir = join(gleanRoot, 'dossiers', slug);
  if (!existsSync(projDir)) return map;

  // Prefer the run's own date; fall back to scanning all date dirs so a run that
  // crossed midnight (or a clock skew) still resolves its worktree paths.
  const dates = new Set<string>([localDateString(new Date(startedAtMs))]);
  for (const d of safeReaddir(projDir)) {
    try { if (statSync(join(projDir, d)).isDirectory()) dates.add(d); } catch { /* skip */ }
  }

  for (const date of dates) {
    const indexPath = join(projDir, date, 'INDEX.md');
    if (!existsSync(indexPath)) continue;
    const entries = parseIndex(indexPath);
    for (const [taskId, lite] of entries) if (!map.has(taskId)) map.set(taskId, lite);
  }
  return map;
}

function parseIndex(path: string): Map<string, IndexEntryLite> {
  const out = new Map<string, IndexEntryLite>();
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch { return out; }
  const m = content.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return out;
  let fm: { entries?: unknown[] };
  try { fm = parseYaml(m[1]) as typeof fm; } catch { return out; }
  if (!fm || !Array.isArray(fm.entries)) return out;
  for (const raw of fm.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.task_id !== 'string') continue;
    out.set(e.task_id, {
      worktree: typeof e.worktree === 'string' ? e.worktree : undefined,
      output: typeof e.output === 'string' ? e.output : undefined,
      files: typeof e.files === 'number' ? e.files : undefined,
      insertions: typeof e.insertions === 'number' ? e.insertions : undefined,
      deletions: typeof e.deletions === 'number' ? e.deletions : undefined,
    });
  }
  return out;
}

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

// Re-export so the CLI can import the report type from one module if it prefers.
export type { MorningReport, MorningBranchEntry, MorningFileEntry, CandidateType };
