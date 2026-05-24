import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { v4 as uuid } from 'uuid';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { Candidate, RunSummary, RunReason } from './types.js';
import { discoverJsonl } from './discover-jsonl.js';
import { discoverGit } from './discover-git.js';
import { discoverDeps } from './discover-deps.js';
import { filterRecentlyProduced } from './dedup.js';
import { prioritize, scoreValue } from './prioritize.js';
import { executeOne } from './executor.js';
import { acquireLock, releaseLock, isStopRequested, writeSummary, writeCandidatesJson, appendOrchestratorLog, ensureTemplatesDir } from './state.js';

export type PipelineOpts = {
  projectPath: string;
  gleanRoot: string;
  claudeBin: string;
  claudeEnv: NodeJS.ProcessEnv;
  budgetMs: number;
  taskTimeoutMs: number;
  dryRun: boolean;
  templatesDir: string;
  projectsRoot?: string; // override for tests
  ghBin?: string;
};

export async function runPipeline(opts: PipelineOpts): Promise<RunSummary> {
  const runId = newRunId();
  const start = Date.now();
  let reason: RunReason = 'completed';
  let exitCode = 0;
  let ran = 0, failed = 0, timed_out = 0;

  const lock = acquireLock(opts.gleanRoot, runId);
  if (!lock.acquired) {
    const summary: RunSummary = {
      run_id: runId, started_at: new Date(start).toISOString(), ended_at: new Date().toISOString(),
      reason: 'lock-busy', budget_ms: opts.budgetMs, elapsed_ms: 0,
      candidates_total: 0, ran: 0, skipped_dedup: 0, failed: 0, timed_out: 0, exit_code: 40,
    };
    writeSummary(opts.gleanRoot, runId, summary);
    return summary;
  }
  if (lock.recovered) appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'lock.stale_recovered' });

  let candidatesTotal = 0;
  let skippedCount = 0;

  try {
    ensureTemplatesDir(opts.gleanRoot, opts.templatesDir);
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'run.start', run_id: runId, project: opts.projectPath, budget_ms: opts.budgetMs });

    const [jsonl, git, deps] = await Promise.all([
      discoverJsonl(opts.projectPath, { projectsRoot: opts.projectsRoot }),
      discoverGit(opts.projectPath, { ghBin: opts.ghBin }),
      discoverDeps(opts.projectPath),
    ]);
    const all = [...jsonl, ...git, ...deps];
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'discover.done', jsonl: jsonl.length, git: git.length, deps: deps.length });

    const projSlug = projectSlug(opts.projectPath);
    const { kept, skipped } = filterRecentlyProduced(all, join(opts.gleanRoot, 'dossiers'), projSlug);
    skippedCount = skipped.length;
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'dedup.done', kept: kept.length, skipped: skipped.length });

    for (const c of kept) c.est_value = scoreValue(c, {});
    const ranked = prioritize(kept, opts.budgetMs, Date.now() - start);
    candidatesTotal = ranked.length;
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'rank.done', count: ranked.length });

    writeCandidatesJson(opts.gleanRoot, runId, { ranked, skipped_dedup: skipped });
    if (opts.dryRun) {
      reason = ranked.length === 0 ? 'no-candidates' : 'completed';
      return finalize();
    }

    if (ranked.length === 0) {
      reason = 'no-candidates';
      return finalize();
    }

    for (const c of ranked) {
      if (isStopRequested(opts.gleanRoot)) { reason = 'stop-sentinel'; exitCode = 30; break; }
      if (Date.now() - start >= opts.budgetMs) { reason = 'budget-exhausted'; exitCode = 10; break; }
      // Re-prioritize for end-of-budget filter
      const remaining = opts.budgetMs - (Date.now() - start);
      if (remaining < 30 * 60_000 && c.type !== 'fetch-docs') continue;

      appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'task.start', task_id: c.id, type: c.type });
      const result = await executeOne(c, {
        runId,
        gleanRoot: opts.gleanRoot,
        claudeBin: opts.claudeBin,
        templatesDir: opts.templatesDir,
        taskTimeoutMs: opts.taskTimeoutMs,
        env: opts.claudeEnv,
      });
      appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'task.end', task_id: c.id, status: result.status, elapsed_ms: result.elapsed_ms });

      if (result.status === 'rate-limit') {
        reason = 'rate-limit';
        exitCode = 20;
        break;
      }
      if (result.status === 'timeout') timed_out++;
      else if (result.status === 'failed') failed++;
      else ran++;

      if (result.output_path) appendIndex(opts.gleanRoot, projSlug, runId, c, result);
    }

    return finalize();
  } finally {
    releaseLock(opts.gleanRoot);
  }

  function finalize(): RunSummary {
    const summary: RunSummary = {
      run_id: runId,
      started_at: new Date(start).toISOString(),
      ended_at: new Date().toISOString(),
      reason,
      budget_ms: opts.budgetMs,
      elapsed_ms: Date.now() - start,
      candidates_total: candidatesTotal,
      ran, skipped_dedup: skippedCount, failed, timed_out,
      exit_code: exitCode,
    };
    writeSummary(opts.gleanRoot, runId, summary);
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'run.end', reason, ran, failed, timed_out });
    return summary;
  }
}

function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${ymd}-${hms}-${uuid().slice(0, 6)}`;
}

function projectSlug(p: string): string {
  return basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function appendIndex(root: string, projSlug: string, runId: string, c: Candidate, result: { status: string; output_path?: string }): void {
  const dir = join(root, 'dossiers', projSlug, today());
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, 'INDEX.md');
  let frontmatter: { run_id: string; project_path: string; generated_at: string; entries: unknown[] };
  if (existsSync(indexPath)) {
    const m = readFileSync(indexPath, 'utf8').match(/^---\n([\s\S]+?)\n---/);
    frontmatter = m
      ? { entries: [], ...yamlParse(m[1]) }
      : { run_id: runId, project_path: c.project_path, generated_at: new Date().toISOString(), entries: [] };
  } else {
    frontmatter = { run_id: runId, project_path: c.project_path, generated_at: new Date().toISOString(), entries: [] };
  }
  (frontmatter.entries as unknown[]).push({
    task_id: c.id, evidence_hash: c.evidence_hash, type: c.type,
    title: titleFor(c), output: result.output_path ?? '', status: result.status,
  });
  const yaml = yamlStringify(frontmatter);
  writeFileSync(indexPath, `---\n${yaml}---\n\n# Glean dossier — ${today()}\n\n${renderHumanList(frontmatter.entries as { title: string; output: string; status: string; evidence_hash: string }[])}`);
}

function renderHumanList(entries: { title: string; output: string; status: string }[]): string {
  return entries.map((e, i) => `${i + 1}. **${e.title}** — ${e.status}\n   - Read: \`${e.output}\``).join('\n\n');
}

function titleFor(c: Candidate): string {
  switch (c.evidence.kind) {
    case 'todo': return `Handle TODO in ${c.evidence.file}`;
    case 'jsonl': return c.evidence.ai_title;
    case 'pr': return `PR #${c.evidence.number}: ${c.evidence.title}`;
    case 'dep': return `Pre-fetch docs for ${c.evidence.package}`;
  }
}
