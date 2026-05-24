import { execFileSync } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import type { Candidate, EvidenceTodo } from './types.js';
import { evidenceHash } from './dedup.js';

export type GhOpts = {
  ghBin?: string;
  ghArgs?: string[]; // override entirely (for tests)
  skipComments?: boolean;
};

const PATH_EXCLUDES = [
  ':!node_modules', ':!dist', ':!build',
  ':!*.md', ':!*.test.*',
  ':!docs/**', ':!test/**', ':!**/fixtures/**',
  ':!*.min.*', ':!*.generated.*',
  ':!*-lock.*', ':!*.lock',
];

const MAX_HITS = 200;
const TODO_RE = /^(.+?):(\d+):(.*)$/;

export async function discoverGitTodos(projectPath: string): Promise<Candidate[]> {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', projectPath, 'grep', '-nE', '(TODO|FIXME|XXX|HACK)\\b', '--', ...PATH_EXCLUDES],
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

export async function discoverGitPrs(projectPath: string, opts: GhOpts = {}): Promise<Candidate[]> {
  const ghBin = opts.ghBin ?? 'gh';

  // Probe auth via the override args (tests) or actual gh
  if (!opts.ghArgs) {
    try {
      execFileSync(ghBin, ['auth', 'status'], { stdio: 'pipe' });
    } catch {
      return [];
    }
  }

  let listJson: string;
  try {
    const args = opts.ghArgs ?? ['pr', 'list', '--author', '@me', '--state', 'open', '--json', 'number,title,url,updatedAt'];
    listJson = execFileSync(ghBin, args, { cwd: projectPath, encoding: 'utf8' });
  } catch {
    return [];
  }

  let prs: { number: number; title: string; url: string; updatedAt: string }[];
  try {
    prs = JSON.parse(listJson);
  } catch {
    return [];
  }

  return prs.map((pr) => {
    const review_comments = opts.skipComments ? [] : fetchUnresolvedComments(ghBin, projectPath, pr.number);
    const cand: Candidate = {
      id: uuid(),
      evidence_hash: '',
      type: 'research-dossier',
      project_path: projectPath,
      evidence: { kind: 'pr', number: pr.number, title: pr.title, url: pr.url, updated_at: pr.updatedAt, review_comments },
      est_value: 0,
      est_tokens: 5000,
      status: 'pending',
    };
    cand.evidence_hash = evidenceHash(cand);
    return cand;
  });
}

function fetchUnresolvedComments(ghBin: string, cwd: string, prNumber: number): { author: string; body: string; path?: string; line?: number }[] {
  try {
    const json = execFileSync(
      ghBin,
      ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`],
      { cwd, encoding: 'utf8' },
    );
    const all = JSON.parse(json) as { user: { login: string }; body: string; path?: string; line?: number; in_reply_to_id?: number }[];
    return all
      .filter((c) => c.in_reply_to_id == null)
      .map((c) => ({ author: c.user.login, body: c.body, path: c.path, line: c.line }));
  } catch {
    return [];
  }
}

export async function discoverGit(projectPath: string, opts: GhOpts = {}): Promise<Candidate[]> {
  const [todos, prs] = await Promise.all([discoverGitTodos(projectPath), discoverGitPrs(projectPath, opts)]);
  return [...todos, ...prs];
}
