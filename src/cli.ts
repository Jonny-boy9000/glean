import { defineCommand, runMain } from 'citty';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runPipeline } from './lib/pipeline.js';
import { findTodayDossiers } from './lib/today.js';
import { renderToday } from './lib/render-today.js';
import { writeStop, gleanRoot, ensureDefaultConfig } from './lib/state.js';
import { loadConfig, defaultConfigPath } from './lib/config.js';
import { Memory } from './lib/memory.js';
import { renderRateList } from './lib/rate.js';
import { findPeekDossier } from './lib/peek.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES = join(__dirname, '..', 'templates');

const runCmd = defineCommand({
  meta: { name: 'run', description: 'Discover and execute one glean run' },
  args: {
    project: { type: 'string', required: true, description: 'Absolute path to a git project' },
    budget: { type: 'string', default: '60m', description: 'Wall-clock budget, e.g. 60m, 1h, 30m' },
    'task-timeout': { type: 'string', default: '8m', description: 'Per-task timeout (e.g. 8m, 30s, 2m)' },
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
    // Per-project base_branch enables draft-impl for this project; absence skips it.
    const baseBranch = cfg.projects?.[projectPath]?.base_branch;
    // Per-project test_command scopes the draft-impl Bash allow-list (CRITICAL 1).
    const { testCommandAllowFor } = await import('./lib/deny.js');
    const testCommandAllow = testCommandAllowFor(cfg.projects?.[projectPath]?.test_command);
    const budgetMs = parseBudget(args.budget as string);
    const taskTimeoutMs = parseBudget(args['task-timeout'] as string);
    const summary = await runPipeline({
      projectPath,
      gleanRoot: gleanRoot(),
      claudeBin,
      claudeEnv: process.env,
      budgetMs,
      taskTimeoutMs,
      dryRun: Boolean(args['dry-run']),
      templatesDir: BUNDLED_TEMPLATES,
      baseBranch,
      testCommandAllow,
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

const repairCmd = defineCommand({
  meta: { name: 'repair', description: 'Re-extract missing OUT.md from recent JSONL logs (no Claude spawn)' },
  args: {
    'run-id': { type: 'string', description: 'Specific run to repair (default: all within --days)' },
    days: { type: 'string', default: '7', description: 'How many days back to scan' },
  },
  async run({ args }) {
    const { repairRecent } = await import('./lib/repair.js');
    const days = Number(args.days);
    const result = repairRecent(gleanRoot(), days);
    const filtered = args['run-id']
      ? { ...result, repaired: result.repaired.filter((r) => r.run_id === args['run-id']) }
      : result;
    console.log(`scanned ${result.scanned}, repaired ${filtered.repaired.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
    for (const r of filtered.repaired) console.log(`  + ${r.path} (${r.bytes} bytes)`);
    for (const f of result.failed) console.error(`  x ${f.path}: ${f.reason}`);
  },
});

const todayCmd = defineCommand({
  meta: { name: 'today', description: 'Show today\'s glean dossiers across all projects' },
  async run() {
    const report = findTodayDossiers(gleanRoot());
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(renderToday(report, useColor) + '\n');
  },
});

const rateCmd = defineCommand({
  meta: { name: 'rate', description: 'Rate a dossier (kept/discarded/actioned), or --list recent dossiers' },
  args: {
    list:    { type: 'boolean',    default: false, description: 'Print recent ratable dossiers' },
    id:      { type: 'positional', required: false, description: 'Candidate id to rate' },
    verdict: { type: 'positional', required: false, description: 'kept | discarded | actioned' },
  },
  async run({ args }) {
    const memory = new Memory(join(gleanRoot(), 'memory.db'));
    try {
      if (args.list) {
        const rows = memory.listRecentRatableCandidates(20);
        const useColor = Boolean(process.stdout.isTTY);
        process.stdout.write(renderRateList(rows, useColor) + '\n');
        return;
      }
      const idStr = args.id as string | undefined;
      const verdict = args.verdict as string | undefined;
      if (!idStr || !verdict) {
        process.stderr.write('usage: glean rate <id> <kept|discarded|actioned>\n       glean rate --list\n');
        process.exit(1);
      }
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(`error: invalid id '${idStr}'\n`);
        process.exit(1);
      }
      if (verdict !== 'kept' && verdict !== 'discarded' && verdict !== 'actioned') {
        process.stderr.write(`error: unknown verdict '${verdict}' — use one of: kept, discarded, actioned\n`);
        process.exit(1);
      }
      const result = memory.setUserRating(id, verdict);
      if (!result.updated) {
        process.stderr.write(`error: no candidate with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`rated ${id} (${result.title}) as ${verdict}\n`);
    } finally {
      memory.close();
    }
  },
});

const peekCmd = defineCommand({
  meta: {
    name: 'peek',
    description: 'Print the current repo\'s today-dossier (CWD-scoped variant of `glean today`). Silent when nothing applies. Designed for SessionStart hook use.',
  },
  async run() {
    try {
      const report = findPeekDossier(gleanRoot(), process.cwd());
      if (report === null) return;  // exit 0, no output
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderToday(report, useColor) + '\n');
    } catch {
      // Silent: exit 0 no matter what. Hook commands must never break a session.
    }
  },
});

const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd, peek: peekCmd },
});

export function main(argv: string[]): void {
  runMain(root, { rawArgs: argv.slice(2) });
}

function parseBudget(s: string): number {
  const m = s.match(/^(\d+)\s*(s|m|h)$/);
  if (!m) throw new Error(`invalid duration: ${s} (use e.g. 8m, 30s, 1h)`);
  const n = Number(m[1]);
  if (m[2] === 'h') return n * 60 * 60_000;
  if (m[2] === 'm') return n * 60_000;
  return n * 1000;
}
