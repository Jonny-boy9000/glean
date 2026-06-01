import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Memory } from './memory.js';
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
