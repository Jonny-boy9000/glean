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

type SessionScan = {
  ai_title: string | null;
  last_assistant_turn_at: number | null;
  assistant_turn_count: number;
  unfinished_tool_use: boolean;
};

function scanSession(filePath: string): SessionScan {
  const scan: SessionScan = {
    ai_title: null,
    last_assistant_turn_at: null,
    assistant_turn_count: 0,
    unfinished_tool_use: false,
  };
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  let pendingToolUse = false;
  for (const ln of lines) {
    let obj: { type?: string; aiTitle?: string; timestamp?: string; tool_use?: unknown; tool_result?: unknown };
    try {
      obj = JSON.parse(ln);
    } catch {
      continue;
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      scan.ai_title = obj.aiTitle;
    }
    if (obj.type === 'assistant') {
      scan.assistant_turn_count++;
      if (typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (!isNaN(t)) scan.last_assistant_turn_at = t;
      }
      if (obj.tool_use) pendingToolUse = true;
      else pendingToolUse = false;
    }
    if (obj.type === 'tool_result' || obj.tool_result) {
      pendingToolUse = false;
    }
  }
  scan.unfinished_tool_use = pendingToolUse;
  return scan;
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
    const scan = scanSession(filePath);

    const sourceTime = scan.last_assistant_turn_at ?? statSync(filePath).mtime.getTime();
    const idleHours = Math.max(0, Math.round((Date.now() - sourceTime) / 3600_000));

    const reasons: string[] = [];
    if (scan.ai_title && TODO_TITLE_RE.test(scan.ai_title)) reasons.push('todo-title');
    if (scan.unfinished_tool_use) reasons.push('unfinished-tool-use');
    if (idleHours > 24 && scan.assistant_turn_count > 10) reasons.push('idle-with-content');
    if (reasons.length === 0) continue;

    const evidence: EvidenceJsonl = {
      kind: 'jsonl',
      session_id: f.replace(/\.jsonl$/, ''),
      ai_title: scan.ai_title ?? '',
      idle_hours: idleHours,
      signal: reasons.join(','),
    };

    const cand: Candidate = {
      id: uuid(),
      evidence_hash: '',
      type: 'research-dossier',
      project_path: projectPath,
      evidence,
      est_value: 0,
      est_tokens: 4000,
      status: 'pending',
    };
    cand.evidence_hash = evidenceHash(cand);
    candidates.push(cand);
  }
  return candidates;
}

function defaultProjectsRoot(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, '.claude', 'projects');
}
