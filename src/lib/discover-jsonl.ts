import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Candidate, EvidenceJsonl } from './types.js';
import { evidenceHash } from './dedup.js';

const TODO_TITLE_RE = /\b(TODO|FIXME|fix|finish|continue|later|reminder)\b/i;

export function dashEncode(absPath: string): string {
  // Windows "C:\foo\bar" → "C--foo-bar" (each separator char becomes one dash)
  // POSIX "/home/x" → "-home-x"
  // Replace each individual separator character with a dash (no collapsing).
  return absPath.replace(/[\\/:]/g, '-');
}

export async function discoverJsonl(
  projectPath: string,
  opts: { projectsRoot?: string; sessionsDir?: string } = {},
): Promise<Candidate[]> {
  const sessionsDir =
    opts.sessionsDir ??
    join(opts.projectsRoot ?? defaultProjectsRoot(), dashEncode(projectPath));
  if (!existsSync(sessionsDir)) return [];

  const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  const candidates: Candidate[] = [];

  for (const f of files) {
    const filePath = join(sessionsDir, f);
    const aiTitle = findLastAiTitle(filePath);
    if (!aiTitle) continue;
    if (!TODO_TITLE_RE.test(aiTitle)) continue;

    const lastUserOrAssistantTs = findLastUserOrAssistantTimestamp(filePath);
    const sourceTime = lastUserOrAssistantTs ?? statSync(filePath).mtime.getTime();
    const idleHours = Math.max(0, Math.round((Date.now() - sourceTime) / 3600_000));

    const evidence: EvidenceJsonl = {
      kind: 'jsonl',
      session_id: f.replace(/\.jsonl$/, ''),
      ai_title: aiTitle,
      idle_hours: idleHours,
    };

    const cand: Candidate = {
      id: uuid(),
      evidence_hash: '',
      type: 'research-dossier',
      project_path: projectPath,
      evidence,
      est_value: 0, // computed in prioritizer
      est_tokens: 4000, // placeholder
      status: 'pending',
    };
    cand.evidence_hash = evidenceHash(cand);
    candidates.push(cand);
  }
  return candidates;
}

function findLastAiTitle(filePath: string): string | null {
  // Per Task 1 findings: aiTitle lives on records with type === "ai-title".
  // Scan backwards for the LAST such record (some sessions have multiple).
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        return obj.aiTitle;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function findLastUserOrAssistantTimestamp(filePath: string): number | null {
  // Per Task 1 findings: ai-title, last-prompt, permission-mode carry no timestamp.
  // Scan backwards for the last assistant or user record that has a valid timestamp.
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (
        obj &&
        (obj.type === 'assistant' || obj.type === 'user') &&
        typeof obj.timestamp === 'string'
      ) {
        const t = Date.parse(obj.timestamp);
        if (!isNaN(t)) return t;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function defaultProjectsRoot(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, '.claude', 'projects');
}
