import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { runPipeline } from './pipeline.js';

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
  // Candidate ids are random UUIDs regenerated per discovery, so to test the
  // skip deterministically we mock uuid to a stable value (every candidate then
  // shares the same id). Passing that id in completedTaskIds must skip them all.
  it('skips candidates whose id is in completedTaskIds (drain re-entry dedup)', async () => {
    vi.resetModules();
    vi.doMock('uuid', () => ({ v4: () => 'fixed-task-id' }));
    const { runPipeline: rp } = await import('./pipeline.js');

    const repo = tmpRepo();
    const root = mkdtempSync(join(tmpdir(), 'glean-root-'));
    const common = {
      projectPath: repo,
      gleanRoot: root,
      claudeBin: FAKE_CLAUDE,
      // A full 60-min budget so research-dossier candidates survive prioritize()
      // (a sub-30-min remaining budget restricts the queue to fetch-docs only).
      budgetMs: 60 * 60_000,
      taskTimeoutMs: 10_000,
      templatesDir: join(__dirname, '..', '..', 'templates'),
      projectsRoot: '/does-not-exist',
    };

    // Sanity: without a skip-set, a candidate exists and runs.
    const baseline = await rp({
      ...common,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      dryRun: false,
    });
    expect(baseline.candidates_total).toBeGreaterThan(0);
    expect(baseline.ran).toBeGreaterThan(0);

    // Now mark that id completed → every candidate is skipped, nothing runs.
    const root2 = mkdtempSync(join(tmpdir(), 'glean-root2-'));
    const summary = await rp({
      ...common,
      gleanRoot: root2,
      claudeEnv: { ...process.env, FAKE_CLAUDE_SCENARIO: join(__dirname, '..', '..', 'test', 'fixtures', 'scenarios', 'clean-exit.yaml') },
      dryRun: false,
      completedTaskIds: ['fixed-task-id'],
    });
    expect(summary.candidates_total).toBeGreaterThan(0); // candidates existed...
    expect(summary.ran).toBe(0);                          // ...but all were skipped
    expect(summary.reason).toBe('completed');

    vi.doUnmock('uuid');
    vi.resetModules();
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
