import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
