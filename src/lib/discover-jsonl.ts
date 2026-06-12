import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Candidate, EvidenceJsonl } from './types.js';
import { evidenceHash } from './dedup.js';

const TODO_TITLE_RE = /\b(TODO|FIXME|fix|finish|continue|later|reminder)\b/i;

export function dashEncode(absPath: string): string {
  // Windows "C:\foo\bar" → "C--foo-bar" (each separator char becomes one dash)
  // POSIX "/home/x" → "-home-x"
  // Replace each individual separator character with a dash (no collapsing).
  //
  // WARNING (verified live 2026-06-12, run 2026-06-12-1748-2e70ee): this does NOT
  // reproduce Claude Code's own encoding, which also munges '_', '.', spaces, etc.
  // to '-' ("C:\ClaudeCode_Work" → "C--ClaudeCode-Work"). Never use this to LOCATE
  // an existing history dir — use resolveSessionDirs(), which matches by the "cwd"
  // field inside the session lines. dashEncode is kept only as a compat fast path
  // for dirs whose sessions carry no cwd at all.
  return absPath.replace(/[\\/:]/g, '-');
}

/** Compare two absolute paths for identity (case-insensitive on win32). */
function samePath(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Extract the real project path a Claude Code history dir belongs to, from the
 * "cwd" field carried by its session .jsonl lines. Scans the newest file first
 * (real sessions open with cwd-less lines like "mode"/"queue-operation", so we
 * scan lines, not just line 1) and falls back to older files until a cwd is
 * found. Returns null when no session line in the dir carries a cwd.
 *
 * NOTE: dashboard-data.ts is growing similar logic (scanProjectRegistry) on a
 * separate branch; a later cleanup can unify the two.
 */
export function extractProjectCwd(sessionDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const newestFirst = files
    .map((f) => {
      const p = join(sessionDir, f);
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { p: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { p } of newestFirst) {
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.includes('"cwd"')) continue; // cheap pre-filter before JSON.parse
      try {
        const obj = JSON.parse(ln) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Resolve which history dir(s) under projectsRoot hold sessions for projectPath.
 * Source of truth is the "cwd" inside the session lines (Claude Code's dir-name
 * encoding is not reproducible from the path — see dashEncode warning). Multiple
 * dirs can resolve to the same cwd (e.g. worktree/salvage variants); all are
 * returned. A dir whose sessions carry no cwd is trusted only when its name
 * equals glean's naive dashEncode slug (compat fast path).
 */
export function resolveSessionDirs(projectPath: string, projectsRoot: string): string[] {
  const naiveSlug = dashEncode(projectPath);
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  for (const name of entries) {
    const dir = join(projectsRoot, name);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const cwd = extractProjectCwd(dir);
    if (cwd !== null ? samePath(cwd, projectPath) : name === naiveSlug) {
      dirs.push(dir);
    }
  }
  return dirs;
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
  const sessionDirs = opts.sessionsDir
    ? existsSync(opts.sessionsDir)
      ? [opts.sessionsDir]
      : []
    : resolveSessionDirs(projectPath, opts.projectsRoot ?? defaultProjectsRoot());

  const files: string[] = [];
  for (const dir of sessionDirs) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      files.push(join(dir, f));
    }
  }
  const candidates: Candidate[] = [];

  for (const filePath of files) {
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
      session_id: basename(filePath, '.jsonl'),
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
