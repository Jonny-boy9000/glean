import { defineCommand, runMain } from 'citty';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runPipeline } from './lib/pipeline.js';
import { writeStop, gleanRoot, ensureDefaultConfig } from './lib/state.js';
import { loadConfig, defaultConfigPath } from './lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES = join(__dirname, '..', 'templates');

const runCmd = defineCommand({
  meta: { name: 'run', description: 'Discover and execute one glean run' },
  args: {
    project: { type: 'string', required: true, description: 'Absolute path to a git project' },
    budget: { type: 'string', default: '60m', description: 'Wall-clock budget, e.g. 60m, 1h, 30m' },
    'dry-run': { type: 'boolean', default: false, description: 'Stop after candidates.json is written' },
  },
  async run({ args }) {
    const projectPath = resolve(args.project as string);
    if (!existsSync(projectPath)) {
      console.error(`error: project path does not exist: ${projectPath}`);
      process.exit(1);
    }
    const bootstrap = ensureDefaultConfig(gleanRoot());
    if (bootstrap.created) {
      console.log(`created default config at ${bootstrap.path}`);
    }
    const cfg = loadConfig(defaultConfigPath());
    const claudeBin = cfg.claude_bin ?? 'claude';
    const budgetMs = parseBudget(args.budget as string);
    const summary = await runPipeline({
      projectPath,
      gleanRoot: gleanRoot(),
      claudeBin,
      claudeEnv: process.env,
      budgetMs,
      taskTimeoutMs: 8 * 60_000,
      dryRun: Boolean(args['dry-run']),
      templatesDir: BUNDLED_TEMPLATES,
    });
    console.log(`run ${summary.run_id} ended: ${summary.reason} — ran=${summary.ran} skipped=${summary.skipped_dedup} failed=${summary.failed} timed_out=${summary.timed_out}`);
    process.exit(summary.exit_code);
  },
});

const stopCmd = defineCommand({
  meta: { name: 'stop', description: 'Write STOP sentinel; active run exits between tasks' },
  async run() {
    writeStop(gleanRoot());
    console.log(`STOP sentinel written: ${gleanRoot()}\\STOP`);
  },
});

const versionCmd = defineCommand({
  meta: { name: 'version', description: 'Print version' },
  async run() {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(pkg.version);
  },
});

const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd },
});

export function main(argv: string[]): void {
  runMain(root, { rawArgs: argv.slice(2) });
}

function parseBudget(s: string): number {
  const m = s.match(/^(\d+)\s*(m|h)$/);
  if (!m) throw new Error(`invalid budget: ${s} (use e.g. 60m or 1h)`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 60 * 60_000 : n * 60_000;
}
