import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
  type: 'research-dossier' | 'fetch-docs';
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
    entries.push({
      title: e.title,
      status: e.status as IndexEntryStatus,
      output: typeof e.output === 'string' ? e.output : '',
      type: e.type === 'fetch-docs' ? 'fetch-docs' : 'research-dossier',
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
