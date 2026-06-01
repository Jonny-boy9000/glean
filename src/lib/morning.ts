import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Memory } from './memory.js';
import { projectSlug } from './state.js';
import type { MorningReport, MorningBranchEntry, MorningFileEntry } from './render-morning.js';
import type { CandidateType } from './types.js';

// Source the most recent glean run for the "while you slept" receipt.
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
    const latest = memory.getLatestRunWithCandidates();
    if (!latest) return null;
    const { run, candidates } = latest;

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
  } finally {
    memory.close();
  }
}

// Map the DB draft_tests column to the renderer's test_status. Only a NULL (or
// unrecognized) value — a pre-v5 row — degrades to 'unknown'.
function normalizeTestStatus(v: string | null): MorningBranchEntry['test_status'] {
  if (v === 'pass' || v === 'fail' || v === 'none') return v;
  return 'unknown';
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
