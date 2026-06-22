import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runPipeline, isNonTrivialOutput } from './pipeline.js';
import type { TaskResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function tmpRepo(): string {
  const r = mkdtempSync(join(tmpdir(), 'glean-pl-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t', { cwd: r });
  execSync('git config user.name t', { cwd: r });
  writeFileSync(join(r, 'src.ts'), '// TODO: handle null\nexport const x = 1;');
  execSync('git add . && git commit -q -m init', { cwd: r });
  return r;
}

const FAKE_CLAUDE = join(__dirname, '..', '..', 'test', 'fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh');

describe('runPipeline', () => {
  it('end-to-end with fake-claude produces an INDEX.md', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      budgetMs: 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist', // skip jsonl discovery
    });
    expect(summary.reason === 'completed' || summary.reason === 'no-candidates').toBe(true);
    if (summary.reason === 'completed') {
      expect(summary.ran).toBeGreaterThan(0);
      // item 1: a real dossier run wrote output → the burst is productive.
      expect(summary.productive).toBe(true);
    }
  });

  it('dry-run writes candidates.json and exits before execution', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: process.env,
      budgetMs: 60_000,
      taskTimeoutMs: 10_000,
      dryRun: true,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.ran).toBe(0);
    const candPath = join(root, 'state', summary.run_id, 'candidates.json');
    expect(existsSync(candPath)).toBe(true);
  });

  it('writes a runs row and candidates rows to memory.db', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-pipe-mem-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-pipe-mem-home-'));
    mkdirSync(join(home, 'glean'), { recursive: true });
    const gleanRoot = join(home, 'glean');
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');

    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot,
      claudeBin: fakeClaude,
      claudeEnv: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml'),
      } as NodeJS.ProcessEnv,
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 60_000,
      dryRun: false,
      templatesDir: join(process.cwd(), 'templates'),
    });

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(gleanRoot, 'memory.db'), { readonly: true });
    const runs = db.prepare('SELECT * FROM runs').all() as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe(summary.run_id);
    expect(runs[0].project_path).toBe(repo);
    expect(runs[0].exit_reason).toBe(summary.reason);
    expect(runs[0].ended_at).not.toBeNull();

    const candidates = db.prepare('SELECT * FROM candidates ORDER BY priority_rank').all() as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.outcome !== null)).toBe(true);
    db.close();
  });

  // v0.8: completedTaskIds skips already-done candidates from a prior drain burst.
  // The skip-set is keyed on the STABLE evidence_hash (candidate ids are random
  // UUIDs regenerated per discovery and cannot match across bursts). So we capture
  // the real evidence_hashes from a baseline run's candidates.json, then re-run a
  // FRESH root with those hashes in the skip-set — every candidate must be skipped.
  it('skips candidates whose evidence_hash is in completedTaskIds (drain re-entry dedup)', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const scenario = join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');
    const common = {
      projectPath: repo,
      claudeBin: FAKE_CLAUDE,
      // A full 60-min budget so research-dossier candidates survive prioritize()
      // (a sub-30-min remaining budget restricts the queue to fetch-docs only).
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario },
    };

    // Sanity: without a skip-set, candidates exist and run.
    const baseline = await runPipeline({ ...common, gleanRoot: root, dryRun: false });
    expect(baseline.candidates_total).toBeGreaterThan(0);
    expect(baseline.ran).toBeGreaterThan(0);

    // Capture the STABLE evidence_hashes this run produced (same repo → same hashes).
    const candPath = join(root, 'state', baseline.run_id, 'candidates.json');
    const ranked = (JSON.parse(readFileSync(candPath, 'utf8')).ranked ?? []) as Array<{ evidence_hash: string }>;
    const hashes = ranked.map((c) => c.evidence_hash);
    expect(hashes.length).toBeGreaterThan(0);

    // Re-run on a FRESH root (no dossier dedup interference) with those hashes in
    // the skip-set → every candidate is skipped, nothing runs.
    const root2 = mkdtempSync(join(tmpdir(), 'glean-root2-'));
    const summary = await runPipeline({ ...common, gleanRoot: root2, dryRun: false, completedTaskIds: hashes });
    expect(summary.candidates_total).toBeGreaterThan(0); // candidates existed...
    expect(summary.ran).toBe(0);                          // ...but all were skipped
    expect(summary.reason).toBe('completed');
    vi.resetModules();
  });

  // ── Bug fix (2026-06-11 run d705f9): failed tasks must NOT enter the ledger ──
  // 7 tasks died on a session-limit 429 with zero output, yet their evidence
  // hashes landed in completed_evidence_hashes → the drain skipped them forever.
  // Only 'ok' / 'ok-fallback' outcomes may be recorded as completed; failed /
  // timeout / rate-limit tasks must stay out so the next tick re-attempts them.
  it('does NOT record a failed task in completed_evidence_hashes (retried next tick)', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'failed-exit.yaml') },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.completed_evidence_hashes ?? []).toEqual([]);
  });

  it('still records ok tasks in completed_evidence_hashes', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.ran).toBeGreaterThan(0);
    expect(summary.completed_evidence_hashes?.length).toBeGreaterThan(0);
  });

  // ── v0.9 model routing (ADR-0006): the orchestrator log records the RESOLVED
  // model per task (aliases drift across model generations), and PipelineOpts
  // threads routing config + paceTier down into the spawn argv. ──────────────
  it('task.start events carry the resolved model, and routing/paceTier reach the spawn argv', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const argvOut = join(root, 'argv.jsonl');
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml'),
        FAKE_CLAUDE_ARGV_OUT: argvOut,
      },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
      routing: { models: { 'research-dossier': 'opus' } },
      // paceTier deliberately omitted → 'normal' (wave-2 pacing engine wires the real tier)
    });
    expect(summary.ran).toBeGreaterThan(0);
    // 1. orchestrator log: every task.start carries the resolved model string.
    const log = readFileSync(join(root, 'logs', summary.run_id, 'orchestrator.log'), 'utf8');
    const starts = log.split('\n').filter((l) => l.includes('"evt":"task.start"')).map((l) => JSON.parse(l));
    expect(starts.length).toBeGreaterThan(0);
    for (const e of starts) {
      expect(e.model).toBe('opus'); // tmpRepo candidates are research-dossier; config routed them to opus
    }
    // 2. the same resolved model reached the actual spawn argv.
    const argvLines = readFileSync(argvOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    for (const argv of argvLines) {
      expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
      expect(argv[argv.indexOf('--max-turns') + 1]).toBe('24');
    }
  });

  // ── Bug fix (same run): a structured 429 must STOP the run, not bleed tasks ──
  // The real block arrives on stdout (rate_limit_event "rejected" + result
  // is_error/429) with empty stderr. The run must break with reason 'rate-limit'
  // after the FIRST blocked task instead of spawning every remaining candidate.
  it('a structured 429 stops the run: reason rate-limit, no further tasks spawned', async () => {
    const repo = tmpRepo();
    // a second TODO file → at least 2 candidates, so a non-breaking loop would
    // visibly start a second task.
    writeFileSync(join(repo, 'other.ts'), '// TODO: second candidate\nexport const y = 2;');
    execSync('git add . && git commit -q -m more', { cwd: repo });
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'structured-429.yaml') },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.candidates_total).toBeGreaterThanOrEqual(2);
    expect(summary.reason).toBe('rate-limit');
    expect(summary.exit_code).toBe(20);
    expect(summary.failed).toBe(0);
    expect(summary.classification?.kind).toBe('session');
    // only ONE task ever started — the loop broke instead of draining the queue
    const log = readFileSync(join(root, 'logs', summary.run_id, 'orchestrator.log'), 'utf8');
    const starts = log.split('\n').filter((l) => l.includes('"evt":"task.start"')).length;
    expect(starts).toBe(1);
    // and the blocked task did NOT enter the completed ledger
    expect(summary.completed_evidence_hashes ?? []).toEqual([]);
  });

  // ── 2026-06-12 data-loss bug (run 2026-06-12-2109-f8628b) ────────────────────
  // Two same-titled candidates in one burst used to resolve to the SAME dossier
  // dir; each task overwrote the previous task's OUT.md, and the INDEX pointed
  // both entries at the single surviving file. BOTH outputs must survive in
  // distinct dirs, and each INDEX entry's `output` must point at its own task's
  // actual dir.
  it('two same-titled candidates in one burst BOTH survive, with distinct INDEX output paths', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    // Two real-project sessions (resolved via the cwd field) carrying the SAME title.
    const projectsRoot = mkdtempSync(join(tmpdir(), 'glean-proj-'));
    const histDir = join(projectsRoot, 'some-history-dir');
    mkdirSync(histDir, { recursive: true });
    const session = (id: string): string =>
      [
        { type: 'user', timestamp: '2026-05-20T10:00:00Z', cwd: repo, content: 'start' },
        { type: 'ai-title', sessionId: id, aiTitle: 'TODO: continue the migration' },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(join(histDir, 'sess-one.jsonl'), session('sess-one'));
    writeFileSync(join(histDir, 'sess-two.jsonl'), session('sess-two'));

    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot,
    });
    expect(summary.ran).toBeGreaterThanOrEqual(2);

    const { projectSlug } = await import('./state.js');
    const dateDir = new Date().toISOString().slice(0, 10);
    const indexPath = join(root, 'dossiers', projectSlug(repo), dateDir, 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);
    const fm = readFileSync(indexPath, 'utf8').match(/^---\n([\s\S]+?)\n---/);
    const { parse: parseYaml } = await import('yaml');
    const entries = (parseYaml(fm![1]) as { entries: Array<{ title: string; output?: string; status: string }> }).entries;
    const sameTitled = entries.filter((e) => e.title === 'TODO: continue the migration');
    expect(sameTitled.length).toBe(2);
    const [a, b] = sameTitled;
    // Distinct per-task dirs — and both OUT.md files actually exist on disk.
    expect(a.output).toBeTruthy();
    expect(b.output).toBeTruthy();
    expect(a.output).not.toEqual(b.output);
    expect(existsSync(a.output!)).toBe(true);
    expect(existsSync(b.output!)).toBe(true);
  });

  // v0.8.2 item 2: mid-window re-discovery. A candidate whose evidence_hash is NOT
  // in the completed set is still picked up and run on a later burst — the window
  // never works off a stale day-1 snapshot. We seed the skip-set with a bogus hash
  // that matches nothing, so every real candidate must still run.
  it('runs a candidate NOT in completedTaskIds (mid-window re-discovery)', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const scenario = join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario },
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
      // a skip-set that matches NO real candidate → nothing is filtered out.
      completedTaskIds: ['hash-that-matches-nothing'],
    });
    expect(summary.candidates_total).toBeGreaterThan(0);
    expect(summary.ran).toBeGreaterThan(0);
    expect(summary.reason).toBe('completed');
  });

  // ── wave-2 bounded execution loop: REGRESSION PIN ────────────────────────────
  // The new in-run re-rank loop must, under no pressure (ample budget, no
  // failures, static scores), pick tasks in EXACTLY the prioritized order
  // candidates.json records. This is the core safety property: bare `glean run`
  // is unchanged. We assert the task.start order in the orchestrator log equals
  // the ranked order in candidates.json.
  it('no-pressure: task.start order matches the prioritized candidates.json order', async () => {
    const repo = tmpRepo();
    // Add several more TODO files so there is a real multi-candidate ordering.
    writeFileSync(join(repo, 'b.ts'), '// TODO: bbb\n// TODO: bbb2\nexport const b = 1;');
    writeFileSync(join(repo, 'c.ts'), '// TODO: ccc\nexport const cc = 1;');
    execSync('git add . && git commit -q -m more', { cwd: repo });
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      budgetMs: 60 * 60_000, // ample → no budget pressure
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.ran).toBeGreaterThan(1);
    const rankedIds = (JSON.parse(readFileSync(join(root, 'state', summary.run_id, 'candidates.json'), 'utf8')).ranked as Array<{ id: string }>).map((c) => c.id);
    const log = readFileSync(join(root, 'logs', summary.run_id, 'orchestrator.log'), 'utf8');
    const startedIds = log.split('\n').filter((l) => l.includes('"evt":"task.start"')).map((l) => JSON.parse(l).task_id as string);
    // The executed order is exactly the prioritized order (no deferral, no
    // reordering) — the loop is byte-identical to the old fixed-iteration loop.
    expect(startedIds).toEqual(rankedIds);
    // And nothing was deferred for budget-fit under an ample budget.
    expect(log).not.toContain('"evt":"task.defer_budget"');
  });

  // ── wave-2 budget-fit deferral ───────────────────────────────────────────────
  // A candidate whose estimated cost cannot finish in the remaining wall-clock
  // budget is DEFERRED (not started). We force this by setting an enormous
  // per-task timeout (so the est_tokens→cost estimate clamps high) against a
  // budget that is above the 5-min fetch-docs floor (so research-dossier
  // candidates survive ranking) but below the estimated cost. Every candidate is
  // deferred → nothing runs, a task.defer_budget event is logged, run completes.
  it('budget-fit: defers candidates too big to finish, emitting task.defer_budget', async () => {
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await runPipeline({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      // 6-min budget: above the 5-min floor so research-dossier candidates rank,
      // below the estimated cost (timeout * tokens/200k ≈ 450s > 360s).
      budgetMs: 6 * 60_000,
      taskTimeoutMs: 15_000_000, // huge timeout → est cost clamps far above the budget
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.candidates_total).toBeGreaterThan(0); // candidates existed...
    expect(summary.ran).toBe(0);                          // ...but none could finish in budget
    expect(summary.reason).toBe('completed');
    const log = readFileSync(join(root, 'logs', summary.run_id, 'orchestrator.log'), 'utf8');
    expect(log).toContain('"evt":"task.defer_budget"');
    // no task ever started — they were all deferred for budget-fit
    expect(log.split('\n').filter((l) => l.includes('"evt":"task.start"')).length).toBe(0);
  });
});

// v0.8.2 item 1: the triviality classifier the `productive` summary field is
// derived from. A dossier file always counts; a draft branch counts only if its
// diff is real; a result with no output never counts.
describe('isNonTrivialOutput (item 1)', () => {
  const base = { status: 'ok' as const, elapsed_ms: 1 };
  it('a dossier file result is non-trivial', () => {
    const r: TaskResult = { ...base, output: { kind: 'file', path: '/x/OUT.md' } };
    expect(isNonTrivialOutput(r)).toBe(true);
  });
  it('a draft branch with a real diff is non-trivial', () => {
    const r: TaskResult = { ...base, output: { kind: 'branch', branch: 'p', base: 'main', worktree: 'w', files: 2, insertions: 10, deletions: 1, tests: 'pass' } };
    expect(isNonTrivialOutput(r)).toBe(true);
  });
  it('a draft branch with an empty diff (0 files) is trivial', () => {
    const r: TaskResult = { ...base, output: { kind: 'branch', branch: 'p', base: 'main', worktree: 'w', files: 0, insertions: 0, deletions: 0, tests: 'none' } };
    expect(isNonTrivialOutput(r)).toBe(false);
  });
  it('a draft branch with files but 0 changed lines is trivial', () => {
    const r: TaskResult = { ...base, output: { kind: 'branch', branch: 'p', base: 'main', worktree: 'w', files: 1, insertions: 0, deletions: 0, tests: 'none' } };
    expect(isNonTrivialOutput(r)).toBe(false);
  });
  it('a result with no output is trivial', () => {
    const r: TaskResult = { status: 'failed', elapsed_ms: 1 };
    expect(isNonTrivialOutput(r)).toBe(false);
  });
});

// Discovery failure must NOT crash an unattended burst — it finalizes cleanly
// with reason 'discovery-failed' and exit_code 0. We force a throw by mocking
// one discover module.
describe('runPipeline — discovery-failed', () => {
  it('a throwing discoverer finalizes with reason discovery-failed (no crash)', async () => {
    vi.resetModules();
    vi.doMock('./discover-git.js', () => ({
      discoverGit: async () => { throw new Error('simulated gh/network failure'); },
    }));
    const { runPipeline: rp } = await import('./pipeline.js');
    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const summary = await rp({
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      claudeEnv: process.env,
      budgetMs: 60_000,
      taskTimeoutMs: 10_000,
      dryRun: false,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    });
    expect(summary.reason).toBe('discovery-failed');
    expect(summary.exit_code).toBe(0);
    vi.doUnmock('./discover-git.js');
    vi.resetModules();
  });
});
