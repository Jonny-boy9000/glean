import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { Candidate, RunSummary, RunReason, TaskResult } from './types.js';
import { discoverJsonl } from './discover-jsonl.js';
import { discoverGit } from './discover-git.js';
import { discoverDeps } from './discover-deps.js';
import { filterRecentlyProduced } from './dedup.js';
import { prioritize, scoreValue } from './prioritize.js';
import { executeOne } from './executor.js';
import { acquireLock, releaseLock, isStopRequested, writeSummary, writeCandidatesJson, appendOrchestratorLog, ensureTemplatesDir, projectSlug } from './state.js';
import { repairRecent } from './repair.js';
import { Memory } from './memory.js';
import { runDossierExistenceSweep, SWEEP_AGE_MS } from './sweep.js';
import { gcWorktrees } from './gc.js';
import { titleFor, today, sourceSignalFor, filePathFor } from './candidate-meta.js';

function gleanVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}

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
  baseBranch?: string;   // per-project base branch for draft-impl (config.json) — single-project fallback
  baseBranchFor?: (projectPath: string) => string | undefined; // F5: per-candidate base resolver
  testCommandAllow?: readonly string[]; // per-project scoped test-command allow prefixes (draft-impl)
  testCommandFor?: (projectPath: string) => string | undefined; // per-project RAW test_command — glean runs it post-commit to capture test status
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

  let memory: Memory | null = null;
  try {
    memory = new Memory(join(opts.gleanRoot, 'memory.db'));
    memory.recordRun(runId, {
      project_path: opts.projectPath,
      budget_seconds: Math.round(opts.budgetMs / 1000),
      max_parallel: 1,
      glean_version: gleanVersion(),
    });
  } catch (e) {
    process.stderr.write(`[memory] warning: open/recordRun failed: ${(e as Error).message}\n`);
    memory = null;
  }

  if (memory) {
    try {
      const sweep = runDossierExistenceSweep(memory, Date.now(), SWEEP_AGE_MS);
      appendOrchestratorLog(opts.gleanRoot, runId, {
        evt: 'sweep.done',
        checked: sweep.checked,
        kept: sweep.kept,
        discarded: sweep.discarded,
      });
    } catch (e) {
      process.stderr.write(`[memory] warning: sweep failed: ${(e as Error).message}\n`);
    }
  }

  // CRITICAL 2: expire draft-impl worktrees + prep branches older than 21 days
  // (CLAUDE.md §5.6). Best-effort — gcWorktrees swallows all errors internally.
  try {
    const removed = gcWorktrees(opts.projectPath, opts.gleanRoot, Date.now());
    if (removed.length > 0) {
      appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'gc.done', removed: removed.length });
    }
  } catch (e) {
    process.stderr.write(`[gc] warning: worktree gc failed: ${(e as Error).message}\n`);
  }

  const repairResult = repairRecent(opts.gleanRoot);
  if (repairResult.repaired.length > 0) {
    appendOrchestratorLog(opts.gleanRoot, runId, {
      evt: 'repair.done',
      repaired: repairResult.repaired.length,
      skipped: repairResult.skipped.length,
      failed: repairResult.failed.length,
    });
  }

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
    // v0.7.0 thin slice: when a base_branch is configured, promote the single
    // highest est_value TODO candidate to draft-impl BEFORE ranking, so glean
    // writes a reviewable branch instead of a dossier for it. Promoting here
    // (rather than re-ranking) means prioritize() runs exactly once — calling it
    // twice would apply the vendor/path est_value penalty twice.
    if (opts.baseBranch) {
      const todos = kept.filter((c) => c.evidence.kind === 'todo');
      const top = todos.sort((a, b) => b.est_value - a.est_value)[0];
      if (top) {
        top.type = 'draft-impl';
        appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'draft-impl.promoted', task_id: top.id });
      }
    }
    const finalRanked = prioritize(kept, opts.budgetMs, Date.now() - start);
    candidatesTotal = finalRanked.length;
    appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'rank.done', count: finalRanked.length });

    writeCandidatesJson(opts.gleanRoot, runId, { ranked: finalRanked, skipped_dedup: skipped });

    if (memory) {
      for (let i = 0; i < finalRanked.length; i++) {
        const c = finalRanked[i];
        try {
          const rowId = memory.recordCandidate(runId, {
            candidate_slug: c.id,
            candidate_type: c.type,
            title: titleFor(c),
            source_signal: sourceSignalFor(c),
            file_path: filePathFor(c),
            est_value: c.est_value,
            est_tokens: c.est_tokens,
            priority_rank: i,
          });
          c.candidate_row_id = rowId;
        } catch (e) {
          process.stderr.write(`[memory] warning: recordCandidate failed: ${(e as Error).message}\n`);
        }
      }
    }

    if (opts.dryRun) {
      reason = finalRanked.length === 0 ? 'no-candidates' : 'completed';
      return finalize();
    }

    if (finalRanked.length === 0) {
      reason = 'no-candidates';
      return finalize();
    }

    for (const c of finalRanked) {
      if (isStopRequested(opts.gleanRoot)) { reason = 'stop-sentinel'; exitCode = 30; break; }
      if (Date.now() - start >= opts.budgetMs) { reason = 'budget-exhausted'; exitCode = 10; break; }
      // Skip research-dossier tasks when fewer than 5 min remain (fetch-docs are fast enough).
      const remaining = opts.budgetMs - (Date.now() - start);
      if (remaining < 5 * 60_000 && c.type !== 'fetch-docs') continue;

      appendOrchestratorLog(opts.gleanRoot, runId, { evt: 'task.start', task_id: c.id, type: c.type });
      const result = await executeOne(c, {
        runId,
        gleanRoot: opts.gleanRoot,
        claudeBin: opts.claudeBin,
        templatesDir: opts.templatesDir,
        taskTimeoutMs: opts.taskTimeoutMs,
        env: opts.claudeEnv,
        baseBranch: opts.baseBranch,
        baseBranchFor: opts.baseBranchFor,
        testCommandAllow: opts.testCommandAllow,
        testCommandFor: opts.testCommandFor,
        // C1: thread the run's REMAINING wall-clock budget + a live STOP probe so
        // the post-draft test run is bounded by `--budget` and short-circuited by
        // `glean stop`, rather than running uninterruptibly for up to the 5-min cap.
        remainingBudgetMs: opts.budgetMs - (Date.now() - start),
        stopRequested: () => isStopRequested(opts.gleanRoot),
        recordOutcome: memory && c.candidate_row_id !== undefined
          ? ((status, fields) => {
              try { memory!.recordOutcome(c.candidate_row_id!, status, fields); }
              catch (e) { process.stderr.write(`[memory] warning: recordOutcome failed: ${(e as Error).message}\n`); }
            })
          : undefined,
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

      if (result.output) appendIndex(opts.gleanRoot, projSlug, runId, c, result);
    }

    return finalize();
  } finally {
    if (memory) {
      try {
        memory.endRun(runId, reason);
      } catch (e) {
        process.stderr.write(`[memory] warning: endRun failed: ${(e as Error).message}\n`);
      }
      try { memory.close(); } catch { /* ignore */ }
    }
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

function appendIndex(root: string, projSlug: string, runId: string, c: Candidate, result: TaskResult): void {
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
  (frontmatter.entries as unknown[]).push(indexEntryFor(c, result));
  const yaml = yamlStringify(frontmatter);
  writeFileSync(indexPath, `---\n${yaml}---\n\n# Glean dossier — ${today()}\n\n${renderHumanList(frontmatter.entries as IndexEntryRecord[])}`);
}

export type IndexEntryRecord = {
  task_id: string;
  evidence_hash: string;
  type: Candidate['type'];
  title: string;
  status: string;
  // file result
  output?: string;
  // branch result (draft-impl)
  branch?: string;
  base?: string;
  worktree?: string;
  files?: number;
  insertions?: number;
  deletions?: number;
};

// Build the persisted INDEX entry. File results carry an `output` path;
// branch results (draft-impl) carry the prep branch + worktree + diff stat so
// the renderer can emit the correct review/discard commands (T11).
function indexEntryFor(c: Candidate, result: TaskResult): IndexEntryRecord {
  const baseRec = {
    task_id: c.id, evidence_hash: c.evidence_hash, type: c.type,
    title: titleFor(c), status: result.status,
  };
  if (result.output?.kind === 'branch') {
    const b = result.output;
    return {
      ...baseRec,
      branch: b.branch, base: b.base, worktree: b.worktree,
      files: b.files, insertions: b.insertions, deletions: b.deletions,
    };
  }
  return { ...baseRec, output: result.output?.kind === 'file' ? result.output.path : '' };
}

function renderHumanList(entries: IndexEntryRecord[]): string {
  return entries.map((e, i) => `${i + 1}. ${renderEntry(e)}`).join('\n\n');
}

export function renderEntry(e: IndexEntryRecord): string {
  if (e.type === 'draft-impl' && e.branch) {
    const stat = `+${e.insertions ?? 0} / -${e.deletions ?? 0} across ${e.files ?? 0} file(s)`;
    // Review: the prep branch is already checked out in the linked worktree, so
    // `git checkout <branch>` in the main repo FAILS — cd into the worktree instead.
    const review = `cd ${e.worktree ?? ''}`;
    // Discard: a plain rm -rf leaves a dangling worktree registration.
    const discard = `git -C <main> worktree remove --force ${e.worktree ?? ''} && git -C <main> branch -D ${e.branch}`;
    return `**${e.title}** — ${e.status} — branch \`${e.branch}\` (${stat})\n   - Review: \`${review}\`\n   - Discard: \`${discard}\``;
  }
  return `**${e.title}** — ${e.status}\n   - Read: \`${e.output ?? ''}\``;
}

