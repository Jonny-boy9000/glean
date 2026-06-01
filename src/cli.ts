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
import { findMorningRun } from './lib/morning.js';
import { renderMorning } from './lib/render-morning.js';
import {
  enableSchedule,
  disableSchedule,
  scheduleStatus,
  DEFAULT_DAY,
  DEFAULT_TIME,
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_DURATION_HOURS,
} from './lib/schedule.js';

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
    // F5: resolve base_branch per-candidate by the candidate's OWN project_path,
    // so a candidate can never be provisioned off the wrong repo's base.
    const baseBranchFor = (p: string): string | undefined => cfg.projects?.[p]?.base_branch;
    // Per-project test_command scopes the draft-impl Bash allow-list (CRITICAL 1).
    const { testCommandAllowFor } = await import('./lib/deny.js');
    const testCommandAllow = testCommandAllowFor(cfg.projects?.[projectPath]?.test_command);
    // Raw per-project test_command — glean runs it itself in the draft worktree
    // after the session commits, to capture a deterministic pass/fail/none.
    const testCommandFor = (p: string): string | undefined => cfg.projects?.[p]?.test_command;
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
      baseBranchFor,
      testCommandAllow,
      testCommandFor,
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

const morningCmd = defineCommand({
  meta: {
    name: 'morning',
    description: 'Narrate the most recent glean run as a "while you slept" receipt (branches, dossiers, honest outcome).',
  },
  async run() {
    try {
      const report = findMorningRun(gleanRoot());
      if (report === null) {
        process.stdout.write('No recent glean run to report.\n');
        return;
      }
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderMorning(report, useColor) + '\n');
    } catch {
      // Silent-degrade like peek: a missing/corrupt memory.db must never throw.
      process.stdout.write('No recent glean run to report.\n');
    }
  },
});

const scheduleCmd = defineCommand({
  meta: { name: 'schedule', description: 'Manage the Glean\\Drain Windows Scheduled Task (enable | disable | status)' },
  args: {
    action: { type: 'positional', required: true, description: 'enable | disable | status' },
    project: { type: 'string', required: false, description: 'Project path to target (required for enable)' },
    // No citty `default:` here — defaults are applied AFTER the config fallback
    // below, so a config-file drain_trigger is reachable (citty defaults would
    // otherwise always populate args.* and shadow the config).
    day: { type: 'string', description: `Day of week for the weekly trigger (default: ${DEFAULT_DAY})` },
    time: { type: 'string', description: `Local 24-h HH:MM start time (default: ${DEFAULT_TIME})` },
    'repeat-minutes': { type: 'string', description: `Repetition interval in minutes (default: ${DEFAULT_REPEAT_MINUTES})` },
    'duration-hours': { type: 'string', description: `Repetition window duration in hours (default: ${DEFAULT_DURATION_HOURS})` },
  },
  async run({ args }) {
    const action = (args.action as string).toLowerCase();

    if (action === 'disable') {
      disableSchedule();
      return;
    }

    if (action === 'status') {
      const result = scheduleStatus();
      if (!result.found) {
        console.log('Glean\\Drain: not registered');
      } else {
        console.log(`Glean\\Drain: ${result.state}`);
        console.log(`  last run: ${result.lastRun}`);
        console.log(`  next run: ${result.nextRun}`);
      }
      return;
    }

    if (action === 'enable') {
      // Resolve project path from --project flag, then config defaults.
      const cfg = loadConfig(defaultConfigPath());

      // Read drain_trigger overrides from config; CLI flags take precedence.
      const cfgTrigger = cfg.drain_trigger ?? {};

      const day           = (args.day  as string | undefined) ?? cfgTrigger.day  ?? DEFAULT_DAY;
      const time          = (args.time as string | undefined) ?? cfgTrigger.time ?? DEFAULT_TIME;
      const repeatMinutes = Number((args['repeat-minutes'] as string | undefined) ?? cfgTrigger.repeat_minutes ?? DEFAULT_REPEAT_MINUTES);
      const durationHours = Number((args['duration-hours'] as string | undefined) ?? cfgTrigger.duration_hours ?? DEFAULT_DURATION_HOURS);

      // Resolve the project path: --project flag beats config keys (use first configured if only one).
      let projectPath = args.project ? resolve(args.project as string) : '';
      if (!projectPath) {
        const projects = Object.keys(cfg.projects ?? {});
        if (projects.length === 1) {
          projectPath = projects[0];
        } else if (projects.length > 1) {
          console.error('error: multiple projects configured — pass --project <path> to specify which one to drain');
          process.exit(1);
        } else {
          console.error('error: no project configured and --project not passed');
          process.exit(1);
        }
      }
      if (!existsSync(projectPath)) {
        console.error(`error: project path does not exist: ${projectPath}`);
        process.exit(1);
      }

      // Resolve node executable and absolute path to this package's bin/glean.js.
      const nodePath = process.execPath;
      // __dirname here is dist/; bin/glean.js is one level up.
      const cliEntry = resolve(join(__dirname, '..', 'bin', 'glean.js'));

      enableSchedule({ nodePath, cliEntry, projectPath, day, time, repeatMinutes, durationHours });
      return;
    }

    console.error(`error: unknown action '${action}' — use: enable | disable | status`);
    process.exit(1);
  },
});

const gcCmd = defineCommand({
  meta: { name: 'gc', description: 'Expire draft-impl worktrees + prep/glean-* branches older than 21 days' },
  args: {
    project: { type: 'string', required: false, description: 'Limit gc to one project repo (default: all configured projects)' },
  },
  async run({ args }) {
    const { gcWorktrees } = await import('./lib/gc.js');
    const cfg = loadConfig(defaultConfigPath());
    const repos = args.project
      ? [resolve(args.project as string)]
      : Object.keys(cfg.projects ?? {});
    if (repos.length === 0) {
      console.log('no configured projects to gc (add one under projects in config.json, or pass --project)');
      return;
    }
    let total = 0;
    for (const repo of repos) {
      const removed = gcWorktrees(repo, gleanRoot(), Date.now());
      total += removed.length;
      for (const dir of removed) console.log(`  - removed ${dir}`);
    }
    console.log(`gc done: ${total} stale worktree(s) removed`);
  },
});

const root = defineCommand({
  meta: { name: 'glean', description: 'Consume idle Claude Pro/Max capacity for speculative prep work' },
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd, peek: peekCmd, morning: morningCmd, gc: gcCmd, schedule: scheduleCmd },
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
