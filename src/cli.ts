import { defineCommand, runMain } from 'citty';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeStop, stopPath, gleanRoot, ensureDefaultConfig } from './lib/state.js';
import { loadConfig, defaultConfigPath } from './lib/config.js';
import {
  enableSchedule,
  disableSchedule,
  scheduleStatus,
  enableNightlySchedule,
  disableNightlySchedule,
  nightlyScheduleStatus,
  defaultTriggerDay,
  DEFAULT_TIME,
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_DURATION_HOURS,
} from './lib/schedule.js';

// F6: pipeline.js, runDrain.js, today.js, morning.js, peek.js, rate.js, repair.js
// and memory.js are NOT imported at the top of this file. Each transitively pulls
// in `better-sqlite3` — a native module that fails to load when a global install
// lacks a matching prebuilt binding. Because citty's runMain walks this module's
// import graph at process start, a static import here would make EVERY command
// (even `version` / `--help` / `doctor` / `schedule status`) crash on a broken
// binding. They are instead lazily `await import(...)`-ed inside the specific
// command handlers that need sqlite, so non-sqlite commands never touch it.

/**
 * Dynamically import the memory module, tolerating a broken better-sqlite3
 * native binding. Returns `null` (with a one-line stderr warning) instead of
 * throwing, so a memory-backed command degrades to a no-op rather than crashing.
 */
async function loadMemoryCtor(): Promise<(typeof import('./lib/memory.js'))['Memory'] | null> {
  try {
    const mod = await import('./lib/memory.js');
    return mod.Memory;
  } catch (e) {
    process.stderr.write(`warning: telemetry disabled (better-sqlite3 unavailable: ${(e as Error).message})\n`);
    return null;
  }
}

/**
 * PIECE 2: the user's typical first-prompt time of day (minutes past local
 * midnight) for the morning anti-spill guard. Returns undefined when the buffer
 * is OFF (no buffer configured) — skipping the JSONL walk entirely — or null
 * when there's too little data (the guard then no-ops). Lazy import keeps the
 * non-drain paths sqlite/JSONL-free.
 */
async function resolveTypicalFirstPrompt(bufferHours: number | undefined): Promise<number | null | undefined> {
  if (!bufferHours || bufferHours <= 0) return undefined;
  const { loadFirstPromptEvents, typicalFirstPromptMinutes } = await import('./lib/activity.js');
  const { defaultClaudeProjectsDir } = await import('./lib/dashboard-data.js');
  const now = new Date();
  const events = loadFirstPromptEvents(defaultClaudeProjectsDir(), {
    gleanRoot: gleanRoot(),
    // 21-day mtime window comfortably covers the 14-day lookback.
    sinceMs: now.getTime() - 21 * 86_400_000,
  });
  return typicalFirstPromptMinutes(events, { now });
}

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
      // v0.9 model routing (ADR-0006): the loaded config carries the optional
      // models / max_turns / pacing_promote maps; resolution + defaults live in
      // model-routing.ts. paceTier is wired by the pacing engine (wave 2).
      routing: cfg,
    };
    // --drain wraps the burst in the drain window state machine (eligibility
    // guards + classified rate-limit handling). Default is a single burst.
    // F6: pipeline/runDrain are lazy-imported here (inside the handler, before any
    // work) so bare `glean run` behavior is unchanged but startup stays sqlite-free.
    const summary = args.drain
      ? await (await import('./lib/runDrain.js')).runDrain(pipelineOpts, undefined, undefined, {
          maxUnproductive: cfg.drain_trigger?.max_unproductive,
          antiSpillMarginMinutes: cfg.drain_trigger?.anti_spill_margin_minutes,
          // PIECE 1 (#3): weekly-block reset fallback uses the configured anchor.
          weekAnchor: cfg.pacing?.week_anchor,
          // PIECE 2: morning anti-spill. Compute the typical first-prompt time
          // ONLY when the buffer is enabled (avoid the JSONL walk otherwise).
          morningBufferHours: cfg.pacing?.morning_buffer_hours,
          typicalFirstPromptMinutes: await resolveTypicalFirstPrompt(cfg.pacing?.morning_buffer_hours),
          // PIECE 3: nightly pace gate — let the drain self-gate on the pacing
          // tier (only when pacing.enabled; recommendTier respects the flag).
          pacing: cfg.pacing,
        })
      : await (await import('./lib/pipeline.js')).runPipeline(pipelineOpts);
    console.log(`run ${summary.run_id} ended: ${summary.reason} — ran=${summary.ran} skipped=${summary.skipped_dedup} failed=${summary.failed} timed_out=${summary.timed_out}`);
    // v0.8.1: refresh the durable, shareable RECEIPT.md for this run/drain window.
    // Best-effort (writeReceipt swallows its own errors); skip on dry-run.
    if (!args['dry-run']) {
      const { writeReceipt } = await import('./lib/morning.js');
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
    console.log(`STOP sentinel written: ${stopPath(gleanRoot())}`);
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
    let mod: typeof import('./lib/today.js');
    try {
      mod = await import('./lib/today.js');
    } catch (e) {
      // F6: a broken better-sqlite3 binding throws at import. Degrade with a clear
      // one-line warning instead of dumping a native-module stack trace.
      process.stderr.write(`warning: telemetry disabled (better-sqlite3 unavailable: ${(e as Error).message})\n`);
      return;
    }
    const { renderToday } = await import('./lib/render-today.js');
    const report = mod.findTodayDossiers(gleanRoot());
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
    const Memory = await loadMemoryCtor();
    if (!Memory) {
      // F6: a broken native binding leaves rating unavailable; degrade with a
      // clear non-zero exit rather than crashing at import time.
      process.stderr.write('error: cannot rate — telemetry/memory is unavailable\n');
      process.exit(1);
    }
    const { renderRateList } = await import('./lib/rate.js');
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
      const { findPeekDossier } = await import('./lib/peek.js');
      const { renderToday } = await import('./lib/render-today.js');
      const report = findPeekDossier(gleanRoot(), process.cwd());
      if (report === null) return;  // exit 0, no output
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderToday(report, useColor) + '\n');
    } catch {
      // Silent: exit 0 no matter what. Hook commands must never break a session.
      // A broken better-sqlite3 binding lands here too (import throws) → no-op.
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
      const { findMorningRun } = await import('./lib/morning.js');
      const report = findMorningRun(gleanRoot());
      if (report === null) {
        process.stdout.write('No recent glean run to report.\n');
        return;
      }
      if (args.md) {
        const { renderReceiptMarkdown } = await import('./lib/render-receipt.js');
        process.stdout.write(renderReceiptMarkdown(report) + '\n');
        return;
      }
      const { renderMorning } = await import('./lib/render-morning.js');
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderMorning(report, useColor) + '\n');
    } catch {
      // Silent-degrade like peek: a missing/corrupt memory.db (or a broken
      // better-sqlite3 binding — the dynamic import throws here) must never throw.
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

const usageCmd = defineCommand({
  meta: {
    name: 'usage',
    description: 'Self-relative weekly pacing: this week vs your 4-week baseline, pace ratio, drain tier recommendation',
  },
  args: {
    json: { type: 'boolean', default: false, description: 'Emit the machine-readable report (the nightly gate consumes this)' },
  },
  async run({ args }) {
    const { loadDailyUsage } = await import('./lib/usage.js');
    const { recommendTier, BLIND_SPOT_NOTE } = await import('./lib/pacing.js');
    const { readCapacity, defaultClaudeProjectsDir } = await import('./lib/dashboard-data.js');
    const { renderUsage } = await import('./lib/render-usage.js');
    const cfg = loadConfig(defaultConfigPath());
    const now = new Date();
    // 42-day lookback comfortably covers the 4-week baseline window + the
    // current week (mtime-based file filter — a perf gate, not accounting).
    const days = loadDailyUsage(defaultClaudeProjectsDir(), {
      gleanRoot: gleanRoot(),
      sinceMs: now.getTime() - 42 * 86_400_000,
    });
    const recommendation = recommendTier({
      days,
      now,
      enabled: cfg.pacing?.enabled,
      haircut: cfg.pacing?.haircut,
      thresholds: cfg.pacing?.thresholds,
    });
    const report = {
      generated_at: now.toISOString(),
      recommendation,
      capacity: readCapacity(gleanRoot()),
      blind_spot: BLIND_SPOT_NOTE,
    };
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(renderUsage(report, useColor) + '\n');
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
    time: { type: 'string', description: `Local 24-h HH:MM start time (default: ${DEFAULT_TIME}; nightly default 02:00)` },
    'repeat-minutes': { type: 'string', description: `Repetition interval in minutes (default: ${DEFAULT_REPEAT_MINUTES})` },
    'duration-hours': { type: 'string', description: `Repetition window duration in hours (default: ${DEFAULT_DURATION_HOURS})` },
    // PIECE 3: operate on the separate daily pace-gated Glean\Nightly task.
    nightly: { type: 'boolean', default: false, description: 'Target the daily pace-gated drain (Glean\\Nightly) instead of the weekly Glean\\Drain task' },
  },
  async run({ args }) {
    const action = (args.action as string).toLowerCase();
    const nightly = Boolean(args.nightly);

    if (action === 'disable') {
      if (nightly) disableNightlySchedule();
      else disableSchedule();
      return;
    }

    if (action === 'status') {
      const result = nightly ? nightlyScheduleStatus() : scheduleStatus();
      // Platform-appropriate label; on Windows this stays the exact 'Glean\Drain'.
      const label = nightly
        ? 'Glean\\Nightly'
        : process.platform === 'win32' ? 'Glean\\Drain' : 'glean-drain.timer';
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

      // PIECE 3: --nightly registers the separate daily pace-gated Glean\Nightly
      // task (the weekly Glean\Drain path is untouched). Nightly uses a 02:00
      // default time; day/repeat/duration do not apply to a daily trigger.
      if (nightly) {
        const nightlyTime = (args.time as string | undefined) ?? cfgTrigger.time ?? '02:00';
        try {
          enableNightlySchedule({ nodePath, cliEntry, projectPath, time: nightlyTime });
        } catch (e) {
          console.error(`error: ${(e as Error).message}`);
          process.exit(1);
        }
        console.log(`nightly drain scheduled: daily at ${nightlyTime} (pace-gated — spends only when under weekly pace)`);
        return;
      }

      try {
        enableSchedule({ nodePath, cliEntry, projectPath, day, time, repeatMinutes, durationHours });
      } catch (e) {
        // F3: invalid --day / --time (or config drain_trigger) is rejected before
        // any PowerShell is generated — surface it as a clean CLI error.
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
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
  meta: {
    name: 'serve',
    description:
      'Launch the local management dashboard (foreground), or keep it always on: serve install | uninstall | status',
  },
  args: {
    action: {
      type: 'positional',
      required: false,
      description: 'install (auto-start at logon + start now) | uninstall | status — omit to run in the foreground',
    },
    port: { type: 'string', default: '4317', description: 'Port to bind on 127.0.0.1' },
    open: { type: 'boolean', default: false, description: 'Open the dashboard in the default browser' },
  },
  async run({ args }) {
    const nodePath = process.execPath;
    const cliEntry = resolve(join(__dirname, '..', 'bin', 'glean.js'));
    const port = Number(args.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`error: invalid port '${args.port}'`);
      process.exit(1);
    }

    const action = args.action ? String(args.action).toLowerCase() : '';
    if (action) {
      const si = await import('./lib/serve-install.js');

      if (action === 'install') {
        // A live dashboard already owns the port → register the auto-start but
        // skip "start now", so Task Scheduler / systemd doesn't burn its
        // restart-on-failure budget on EADDRINUSE exits.
        const alreadyUp = await si.serveAlive(port);
        si.installServe({ nodePath, cliEntry, port }, !alreadyUp);
        if (alreadyUp) {
          console.log(
            `dashboard already running at http://127.0.0.1:${port}/ — auto-start registered; it takes over after the current instance exits (or at next logon).`,
          );
          return;
        }
        // Start is async under the platform scheduler — wait briefly for
        // liveness. Until the dashboard binds, each probe fails fast
        // (ECONNREFUSED), so retry with sleeps; once bound, serveAlive's own
        // timeout absorbs the (Windows-measured) slow cross-process connect.
        let up = false;
        for (let i = 0; i < 8 && !up; i++) {
          up = await si.serveAlive(port);
          if (!up) await new Promise((r) => setTimeout(r, 1000));
        }
        if (up) {
          console.log(`glean dashboard: http://127.0.0.1:${port}/ (always on — starts at logon, restarts on failure)`);
        } else {
          console.log(
            `auto-start registered, but the dashboard is not responding on port ${port} yet — check 'glean serve status' in a moment.`,
          );
        }
        return;
      }

      if (action === 'uninstall') {
        si.uninstallServe();
        return;
      }

      if (action === 'status') {
        // Only override the probe port when --port was given explicitly;
        // otherwise the report probes the *installed* port.
        const portExplicit = process.argv.includes('--port');
        const report = await si.serveStatusReport(portExplicit ? port : undefined);
        console.log(si.renderServeStatus(report));
        return;
      }

      console.error(`error: unknown action '${action}' — use: install | uninstall | status (or no action for foreground)`);
      process.exit(1);
    }

    const { startServer } = await import('./lib/serve.js');
    try {
      const { url } = await startServer({ root: gleanRoot(), templatesDir: BUNDLED_TEMPLATES, cliEntry, nodePath, port });
      console.log(`glean dashboard: ${url}`);
      console.log('  (127.0.0.1 only — full management surface. Ctrl+C to stop. `glean serve install` keeps it always on.)');
      if (args.open) {
        const { spawn } = await import('node:child_process');
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        // Singleton behavior: if the port-owner IS a glean dashboard, that is
        // success ("the dashboard is available"), not an error.
        const si = await import('./lib/serve-install.js');
        if (await si.serveAlive(port)) {
          let installed: boolean | null = null;
          try {
            installed = si.serveTaskStatus().found;
          } catch {
            installed = null;
          }
          console.log(si.formatAlreadyRunning(port, installed));
          return;
        }
        console.error(`error: port ${port} is already in use (not by a glean dashboard) — pass --port <n>`);
      } else {
        console.error(`error: ${err.message}`);
      }
      process.exit(1);
    }
  },
});

const doctorCmd = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Preflight: check Node, the claude CLI, git/gh, config, and the better-sqlite3 binding. Exits non-zero if a hard requirement fails.',
  },
  async run() {
    // D5: doctor must work even when better-sqlite3 is broken (that's the point),
    // so doctor.js is lazy-imported and probes sqlite via try/catch.
    const { runDoctor, summarizeDoctor, renderDoctor, defaultDoctorProbes } = await import('./lib/doctor.js');
    const probes = await defaultDoctorProbes();
    const checks = runDoctor(probes);
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(renderDoctor(checks, useColor) + '\n');
    process.exit(summarizeDoctor(checks).exitCode);
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
  subCommands: { run: runCmd, stop: stopCmd, version: versionCmd, repair: repairCmd, today: todayCmd, rate: rateCmd, peek: peekCmd, morning: morningCmd, gc: gcCmd, doctor: doctorCmd, schedule: scheduleCmd, serve: serveCmd, projects: projectsCmd, usage: usageCmd },
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
