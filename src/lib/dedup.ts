import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Candidate } from './types.js';

export function evidenceHash(c: Candidate): string {
  const norm = canonicalize({
    type: c.type,
    project_path: c.project_path,
    evidence: stripVolatile(c.evidence),
  });
  return createHash('sha256').update(norm).digest('hex');
}

function stripVolatile(ev: Candidate['evidence']): unknown {
  // Drop timestamp-ish fields so hash is stable across runs
  if (ev.kind === 'jsonl') {
    const { idle_hours: _ih, recent_turns: _rt, ...rest } = ev;
    return rest;
  }
  if (ev.kind === 'pr') {
    const { updated_at: _ua, review_comments: _rc, ...rest } = ev;
    return rest;
  }
  if (ev.kind === 'dep') {
    const { added_at: _aa, ...rest } = ev;
    return rest;
  }
  return ev;
}

function canonicalize(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonicalize).join(',') + ']';
  const keys = Object.keys(o as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize((o as Record<string, unknown>)[k])).join(',') + '}';
}

export function filterRecentlyProduced(
  candidates: Candidate[],
  dossierRoot: string,
  projectSlug: string,
  windowDays = 7,
): { kept: Candidate[]; skipped: string[] } {
  const projDir = join(dossierRoot, projectSlug);
  if (!existsSync(projDir)) return { kept: candidates, skipped: [] };

  const cutoff = Date.now() - windowDays * 86400_000;
  const recentHashes = new Set<string>();

  for (const dateDir of readdirSync(projDir)) {
    const d = parseDateDir(dateDir);
    if (d === null || d < cutoff) continue;
    const indexPath = join(projDir, dateDir, 'INDEX.md');
    if (!existsSync(indexPath)) continue;
    const hashes = extractHashesFromIndex(readFileSync(indexPath, 'utf8'));
    for (const h of hashes) recentHashes.add(h);
  }

  const kept: Candidate[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    if (recentHashes.has(c.evidence_hash)) skipped.push(c.evidence_hash);
    else kept.push(c);
  }
  return { kept, skipped };
}

function parseDateDir(name: string): number | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function extractHashesFromIndex(content: string): string[] {
  // Frontmatter between leading --- lines
  const m = content.match(/^---\n([\s\S]+?)\n---/);
  if (!m) return [];
  try {
    const fm = parseYaml(m[1]) as { entries?: { evidence_hash?: string }[] };
    return (fm.entries ?? []).map((e) => e.evidence_hash ?? '').filter(Boolean);
  } catch {
    return [];
  }
}
