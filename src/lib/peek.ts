import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findTodayDossiers, type TodayReport } from './today.js';
import { projectSlug } from './state.js';

export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  let parent = dirname(dir);
  while (parent !== dir) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = parent;
    parent = dirname(dir);
  }
  // Check the root itself
  if (existsSync(join(dir, '.git'))) return dir;
  return null;
}

export function findPeekDossier(gleanRoot: string, cwd: string): TodayReport | null {
  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) return null;
  const slug = projectSlug(repoRoot);
  const all = findTodayDossiers(gleanRoot);
  const filtered = all.projects.filter((p) => p.project_slug === slug);
  if (filtered.length === 0) return null;
  return { date: all.date, projects: filtered };
}
