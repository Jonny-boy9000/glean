import { defineCommand, runMain } from 'citty';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runPipeline } from './lib/pipeline.js';
import { runDrain } from './lib/runDrain.js';
import { findTodayDossiers } from './lib/today.js';
import { renderToday } from './lib/render-today.js';
import { writeStop, gleanRoot, ensureDefaultConfig } from './lib/state.js';
import { loadConfig, defaultConfigPath } from './lib/config.js';
import { Memory } from './lib/memory.js';
import { renderRateList } from './lib/rate.js';
import { findPeekDossier } from './lib/peek.js';
import { findMorningRun, writeReceipt } from './lib/morning.js';
import { renderMorning } from './lib/render-morning.js';
import { renderReceiptMarkdown } from './lib/render-receipt.js';
import {
  enableSchedule,
  disableSchedule,
  scheduleStatus,
  defaultTriggerDay,
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
    drain: { type: 'boolean', default: false, description: 'Run as a drain tick (exit-and-re-enter window) instead of a single burst' },
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
    const pipelineOpts = {
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
    };
    // --drain wraps the burst in the drain window state machine (eligibility
    // guards + classified rate-limit handling). Default is a single burst.
    const summary = args.drain
      ? await runDrain(pipelineOpts, undefined, undefined, {
          maxUnproductive: cfg.drain_trigger?.max_unproductive,
          antiSpillMarginMinutes: cfg.drain_trigger?.anti_spill_margin_minutes,
        })
      : await runPipeline(pipelineOpts);
    console.log(`run ${summary.run_id} ended: ${summary.reason} — ran=${summary.ran} skipped=${summary.skipped_dedup} failed=${summary.failed} timed_out=${summary.timed_out}`);
    // v0.8.1: refresh the durable, shareable RECEIPT.md for this run/drain window.
    // Best-effort (writeReceipt swallows its own errors); skip on dry-run.
    if (!args['dry-run']) {
      const receiptPath = writeReceipt(gleanRoot());
      if (receiptPath) console.log(`receipt: ${receiptPath}`);
    }
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
  args: {
    md: { type: 'boolean', default: false, description: 'Print the receipt as shareable Markdown (no ANSI) for pasting into a PR/issue/Slack' },
  },
  async run({ args }) {
    try {
      const report = findMorningRun(gleanRoot());
      if (report === null) {
        process.stdout.write('No recent glean run to report.\n');
        return;
      }
      if (args.md) {
        process.stdout.write(renderReceiptMarkdown(report) + '\n');
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

const projectsCmd = defineCommand({
  meta: {
    name: 'projects',
    description: 'List the project registry (session history ∪ config), or set a per-project priority dial',
  },
  args: {
    action:   { type: 'positional', required: false, description: "Optional action: 'set'" },
    path:     { type: 'positional', required: false, description: 'Project path (for set)' },
    priority: { type: 'positional', required: false, description: 'off | low | normal | high (for set)' },
  },
  async run({ args }) {
    const { scanProjectRegistry, defaultClaudeProjectsDir } = await import('./lib/dashboard-data.js');
    const { setProjectPriority, isProjectPriority } = await import('./lib/config.js');
    const action = args.action as string | undefined;

    if (action === 'set') {
      const rawPath = args.path as string | undefined;
      const priority = args.priority as string | undefined;
      if (!rawPath || !priority) {
        process.stderr.write('usage: glean projects set <path> <off|low|normal|high>\n');
        process.exit(1);
      }
      if (!isProjectPriority(priority)) {
        process.stderr.write(`error: invalid priority '${priority}' — use one of: off, low, normal, high\n`);
        process.exit(1);
      }
      const projectPath = resolve(rawPath);
      // Setting a dial on an unknown path is the opt-in gesture — but only for
      // a path that actually exists (a configured-but-deleted project may
      // still be dialed, e.g. to 'off').
      const cfg = loadConfig(defaultConfigPath());
      if (!cfg.projects?.[projectPath] && !existsSync(projectPath)) {
        process.stderr.write(`error: project path does not exist and is not configured: ${projectPath}\n`);
        process.exit(1);
      }
      const r = setProjectPriority(defaultConfigPath(), projectPath, priority);
      if (!r.ok) {
        process.stderr.write(`error: ${r.reason}\n`);
        process.exit(1);
      }
      console.log(`priority for ${projectPath} set to '${priority}'${r.created ? ' (added to config — opted in)' : ''}`);
      return;
    }

    if (action !== undefined) {
      process.stderr.write(`error: unknown action '${action}' — usage: glean projects [set <path> <off|low|normal|high>]\n`);
      process.exit(1);
    }

    const entries = scanProjectRegistry(gleanRoot(), defaultClaudeProjectsDir(), defaultConfigPath());
    if (entries.length === 0) {
      console.log('no projects discovered or configured yet (open Claude Code in a repo, or: glean projects set <path> normal)');
      return;
    }
    const ago = (iso: string | null): string => {
      if (!iso) return '—';
      const ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms)) return '—';
      const days = Math.floor(ms / 86_400_000);
      return days < 1 ? 'today' : `${days}d ago`;
    };
    const rows = entries.map((e) => ({
      priority: e.priority,
      sessions: String(e.sessions),
      active: ago(e.last_activity),
      flags: [e.is_git ? 'git' : '', e.exists ? '' : 'missing', e.configured ? '' : 'not configured'].filter(Boolean).join(','),
      path: e.path,
    }));
    const w = (k: 'priority' | 'sessions' | 'active' | 'flags') => Math.max(...rows.map((r) => r[k].length), k.length);
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`${pad('PRIORITY', w('priority'))}  ${pad('SESSIONS', w('sessions'))}  ${pad('ACTIVE', w('active'))}  ${pad('FLAGS', w('flags'))}  PATH`);
    for (const r of rows) {
      console.log(`${pad(r.priority, w('priority'))}  ${pad(r.sessions, w('sessions'))}  ${pad(r.active, w('active'))}  ${pad(r.flags, w('flags'))}  ${r.path}`);
    }
  },
});

const scheduleCmd = defineCommand({
  meta: { name: 'schedule', description: 'Manage the weekly drain schedule — Windows Task Scheduler or Linux systemd user timer (enable | disable | status)' },
  args: {
    action: { type: 'positional', required: true, description: 'enable | disable | status' },
    project: { type: 'string', required: false, description: 'Project path to target (required for enable)' },
    // No citty `default:` here — defaults are applied AFTER the config fallback
    // below, so a config-file drain_trigger is reachable (citty defaults would
    // otherwise always populate args.* and shadow the config).
    day: { type: 'string', description: 'Day of week for the weekly trigger (default: detected from your system timezone — Thursday for Israel, else Friday)' },
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
      // Platform-appropriate label; on Windows this stays the exact 'Glean\Drain'.
      const label = process.platform === 'win32' ? 'Glean\\Drain' : 'glean-drain.timer';
      if (!result.found) {
        console.log(`${label}: not registered`);
      } else {
        console.log(`${result.taskName}: ${result.state}`);
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

      const explicitDay   = (args.day  as string | undefined) ?? cfgTrigger.day;
      const day           = explicitDay ?? defaultTriggerDay();
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
      // Announce the resolved day Node-side (enableSchedule's own output is emitted
      // by the PowerShell script and can't carry this). Make the work-week guess
      // transparent so a wrong detection is obvious and one flag fixes it.
      if (explicitDay) {
        const src = (args.day as string | undefined) !== undefined ? '--day flag' : 'config drain_trigger';
        console.log(`drain scheduled: ${day} ${time} (from ${src})`);
      } else {
        const otherDay = day === 'Thursday' ? 'Friday' : 'Thursday';
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        console.log(`drain scheduled: ${day} ${time} (detected from your system timezone ${tz}) — override: glean schedule enable --day ${otherDay}`);
      }
      return;
    }

    console.error(`error: unknown action '${action}' — use: enable | disable | status`);
    process.exit(1);
  },
});

const serveCmd = defineCommand({
  meta: { name: 'serve', description: 'Launch the local management dashboard (view runs/dossiers, stop/resume, retry failed, discard, schedule)' },
  args: {
    port: { type: 'string', default: '4317', description: 'Port to bind on 127.0.0.1' },
    open: { type: 'boolean', default: false, description: 'Open the dashboard in the default browser' },
  },
  async run({ args }) {
    const { startServer } = await import('./lib/serve.js');
    const nodePath = process.execPath;
    const cliEntry = resolve(join(__dirname, '..', 'bin', 'glean.js'));
    const port = Number(args.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`error: invalid port '${args.port}'`);
      process.exit(1);
    }
    try {
      const { url } = await startServer({ root: gleanRoot(), templatesDir: BUNDLED_TEMPLATES, cliEntry, nodePath, port });
      console.log(`glean dashboard: ${url}`);
      console.log('  (127.0.0.1 only — full management surface. Ctrl+C to stop.)');
      if (args.open) {
        const { spawn } = await import('node:child_process');
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        console.error(`error: port ${port} is already in use — pass --port <n>`);
      } else {
        console.error(`error: ${err.message}`);
      }
      process.exit(1);
    }
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
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd, peek: peekCmd, morning: morningCmd, gc: gcCmd, schedule: scheduleCmd, serve: serveCmd, projects: projectsCmd },
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
