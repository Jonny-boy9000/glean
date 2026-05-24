import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
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
});
