import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Memory } from './memory.js';
import { projectSlug, readDrainState } from './state.js';
import type { CandidateType } from './types.js';

export type IndexEntryStatus =
  | 'ok'
  | 'ok-fallback'
  | 'failed'
  | 'timeout'
  | 'rate-limit';

export type IndexEntry = {
  title: string;
  status: IndexEntryStatus;
  output: string;
  type: CandidateType;
  task_id: string;                                                 // required join key
  duration_ms?: number;                                            // optional, from memory.db (Task 4)
  bytes_written?: number;                                          // optional, from memory.db (Task 4)
  rate_limit_hits?: number;                                        // optional, from memory.db (Task 4)
  user_rating?: 'kept' | 'discarded' | 'actioned' | null;          // optional, from memory.db (Task 4)
};

export type ProjectGroup = {
  project_slug: string;
  project_path?: string;
  entries: IndexEntry[];
};

export type TodayReport = {
  date: string;
  projects: ProjectGroup[];
};

export function findTodayDossiers(gleanRoot: string, date?: string): TodayReport {
  // v0.8.2 item 4: during an ACTIVE drain window, aggregate ALL runs in that
  // window into one project-grouped report (the same source of truth as
  // `glean morning`) so `today`/`peek` don't disagree with `morning` mid-drain.
  // STRICTLY gated above the legacy path: only when a budget.json parses, its
  // drain_window_started_at is a finite ms, AND ≥1 run falls inside the window.
  // Any other case falls through to the EXACT single-day code below
  // (byte-identical to pre-v0.8.2 behavior).
  const windowReport = tryWindowReport(gleanRoot, date);
  if (windowReport) return windowReport;

  const targetDate = date ?? localDateString(new Date());
  const dossiersDir = join(gleanRoot, 'dossiers');
  if (!existsSync(dossiersDir)) return { date: targetDate, projects: [] };

  const slugs = safeReaddir(dossiersDir).sort();
  const projects: ProjectGroup[] = [];

  for (const slug of slugs) {
    const projPath = join(dossiersDir, slug);
    try { if (!statSync(projPath).isDirectory()) continue; } catch { continue; }
    const indexPath = join(projPath, targetDate, 'INDEX.md');
    if (!existsSync(indexPath)) continue;
    const parsed = parseIndex(indexPath);
    if (!parsed) continue;
    projects.push({
      project_slug: slug,
      project_path: parsed.project_path,
      entries: parsed.entries,
    });
  }

  // Enrich entries with memory.db data when available. Silent on failure —
  // glean today should still work without telemetry, no stderr noise.
  const dbPath = join(gleanRoot, 'memory.db');
  if (existsSync(dbPath)) {
    try {
      const memory = new Memory(dbPath);
      try {
        const allSlugs: string[] = [];
        for (const p of projects) for (const e of p.entries) allSlugs.push(e.task_id);
        const enrichments = memory.findEnrichmentsBySlugs(allSlugs);
        for (const p of projects) {
          for (const e of p.entries) {
            const enr = enrichments.get(e.task_id);
            if (!enr) continue;
            if (enr.duration_ms !== null) e.duration_ms = enr.duration_ms;
            if (enr.bytes_written !== null) e.bytes_written = enr.bytes_written;
            e.rate_limit_hits = enr.stderr_rate_limit_hits;
            e.user_rating = enr.user_rating;
          }
        }
      } finally {
        memory.close();
      }
    } catch {
      // Silent degradation.
    }
  }

  return { date: targetDate, projects };
}

// v0.8.2 item 4: the gated window aggregator. Returns a TodayReport built from
// the drain window's runs (parallel to `morning`'s aggregation), or null to
// signal the caller to fall through to the legacy single-day path. Null is
// returned for EVERY non-window case: no/corrupt budget.json, an unparseable
// drain_window_started_at, or zero runs in the window — so a bare `glean run`
// (and a 0-burst active window with no runs yet) keeps the exact old behavior.
function tryWindowReport(gleanRoot: string, date?: string): TodayReport | null {
  const drainResult = readDrainState(gleanRoot);
  if (drainResult.kind !== 'ok') return null;
  const sinceMs = Date.parse(drainResult.state.drain_window_started_at);
  if (!Number.isFinite(sinceMs)) return null;

  const dbPath = join(gleanRoot, 'memory.db');
  if (!existsSync(dbPath)) return null;

  let memory: Memory;
  try {
    memory = new Memory(dbPath);
  } catch {
    return null;
  }
  try {
    const windowRuns = memory.getRunsWithCandidatesSince(sinceMs);
    if (windowRuns.length === 0) return null;  // honest fall-through (0-burst)
    return aggregateWindowToToday(windowRuns, gleanRoot, memory, date);
  } finally {
    memory.close();
  }
}

type WindowRun = {
  run: { run_id: string; started_at: number; ended_at: number | null; project_path: string; exit_reason: string | null };
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
  }>;
};

// Adapt the drain window's runs to today's project-grouped IndexEntry[] shape.
// Mirrors morning.aggregateWindowRuns: a candidate is a "branch" (output = the
// prep branch) when it is draft-impl or carries a prep_branch; otherwise it is a
// dossier "file" (output = dossier_path). Last-write-wins dedupe — branches by
// prep_branch, dossiers by candidate_slug — matches morning so the two surfaces
// agree. Grouping is by project_slug(run.project_path) so `peek` can still slice.
function aggregateWindowToToday(
  windowRuns: WindowRun[],
  gleanRoot: string,
  memory: Memory,
  date?: string,
): TodayReport {
  // Per-project dedupe maps, keyed inside each project group.
  const groups = new Map<string, {
    project_slug: string;
    project_path: string;
    branchEntries: Map<string, IndexEntry>;   // keyed by prep_branch (or __branchless__slug)
    fileEntries: Map<string, IndexEntry>;     // keyed by candidate_slug
  }>();

  for (const { run, candidates } of windowRuns) {
    const slug = projectSlug(run.project_path);
    let g = groups.get(slug);
    if (!g) {
      g = { project_slug: slug, project_path: run.project_path, branchEntries: new Map(), fileEntries: new Map() };
      groups.set(slug, g);
    }
    for (const c of candidates) {
      const isBranch = c.candidate_type === 'draft-impl' || c.prep_branch !== null;
      if (isBranch && c.prep_branch) {
        g.branchEntries.set(c.prep_branch, {
          title: c.title,
          status: normalizeStatus(c.outcome),
          output: c.prep_branch,
          type: c.candidate_type,
          task_id: c.candidate_slug,
        });
      } else if (c.candidate_type === 'draft-impl') {
        // Branchless failed draft — still surface it (parallels morning's I6).
        g.branchEntries.set(`__branchless__${c.candidate_slug}`, {
          title: c.title,
          status: normalizeStatus(c.outcome),
          output: '',
          type: c.candidate_type,
          task_id: c.candidate_slug,
        });
      } else if (c.dossier_path) {
        g.fileEntries.set(c.candidate_slug, {
          title: c.title,
          status: normalizeStatus(c.outcome),
          output: c.dossier_path,
          type: c.candidate_type,
          task_id: c.candidate_slug,
        });
      }
    }
  }

  const projects: ProjectGroup[] = [];
  for (const slug of Array.from(groups.keys()).sort()) {
    const g = groups.get(slug)!;
    const entries = [...g.branchEntries.values(), ...g.fileEntries.values()];
    projects.push({ project_slug: g.project_slug, project_path: g.project_path, entries });
  }

  // Reuse the SAME memory enrichment the single-day path applies (by task_id).
  try {
    const allSlugs: string[] = [];
    for (const p of projects) for (const e of p.entries) allSlugs.push(e.task_id);
    const enrichments = memory.findEnrichmentsBySlugs(allSlugs);
    for (const p of projects) {
      for (const e of p.entries) {
        const enr = enrichments.get(e.task_id);
        if (!enr) continue;
        if (enr.duration_ms !== null) e.duration_ms = enr.duration_ms;
        if (enr.bytes_written !== null) e.bytes_written = enr.bytes_written;
        e.rate_limit_hits = enr.stderr_rate_limit_hits;
        e.user_rating = enr.user_rating;
      }
    }
  } catch {
    // Silent degradation — match the single-day path.
  }

  return { date: date ?? localDateString(new Date()), projects };
}

// Map a DB outcome string to an IndexEntryStatus. The outcome vocabulary written
// by the executor ('ok' | 'ok-fallback' | 'failed' | 'timeout' | 'rate-limit')
// is the same set INDEX.md persists, so this is a passthrough for known values;
// anything else (incl. NULL) degrades to 'failed' rather than fabricating success.
function normalizeStatus(outcome: string | null): IndexEntryStatus {
  switch (outcome) {
    case 'ok':
    case 'ok-fallback':
    case 'failed':
    case 'timeout':
    case 'rate-limit':
      return outcome;
    default:
      return 'failed';
  }
}

function parseIndex(path: string): { project_path?: string; entries: IndexEntry[] } | null {
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch { return null; }
  const m = content.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return null;
  let fm: { project_path?: string; entries?: unknown[] };
  try { fm = parseYaml(m[1]) as typeof fm; } catch { return null; }
  if (!fm || !Array.isArray(fm.entries)) return null;
  const entries: IndexEntry[] = [];
  for (const raw of fm.entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.title !== 'string' || typeof e.status !== 'string') continue;
    if (typeof e.task_id !== 'string') continue;                      // skip entries without task_id
    entries.push({
      title: e.title,
      status: e.status as IndexEntryStatus,
      output: typeof e.output === 'string' ? e.output : '',
      type: e.type === 'fetch-docs' || e.type === 'draft-impl' ? e.type : 'research-dossier',
      task_id: e.task_id,
    });
  }
  return { project_path: fm.project_path, entries };
}

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
