import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, EvidenceTodo } from './types.js';
import { evidenceHash } from './dedup.js';

const MAX_HITS = 200;
const TODO_RE = /^(.+?):(\d+):(.*)$/;

export async function discoverGitTodos(projectPath: string): Promise<Candidate[]> {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', projectPath, 'grep', '-nE', '(TODO|FIXME|XXX|HACK)\\b', '--', ':!node_modules', ':!dist', ':!build'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (e) {
    // git grep exits non-zero when no matches; treat as empty
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    return [];
  }

  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_HITS);
  const byFile = new Map<string, { line: number; text: string }[]>();
  for (const ln of lines) {
    const m = ln.match(TODO_RE);
    if (!m) continue;
    const [, file, lineStr, text] = m;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ line: Number(lineStr), text: text.trim() });
  }

  return [...byFile.entries()].map(([file, todo_lines]) => {
    const ev: EvidenceTodo = { kind: 'todo', file, todo_lines };
    const cand: Candidate = {
      id: uuid(),
      evidence_hash: '',
      type: 'research-dossier',
      project_path: projectPath,
      evidence: ev,
      est_value: 0,
      est_tokens: 6000,
      status: 'pending',
    };
    cand.evidence_hash = evidenceHash(cand);
    return cand;
  });
}
