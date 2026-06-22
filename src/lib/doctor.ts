import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig, defaultConfigPath } from './config.js';
import type { GleanConfig } from './types.js';

/**
 * D5: `glean doctor` — a fast, side-effect-free preflight that tells a user
 * whether their environment can run glean for real, and (crucially) surfaces the
 * #1 first-run failures: a missing `claude` CLI and a broken `better-sqlite3`
 * native binding (the latter ties to F6 — a global install with a mismatched
 * ABI silently loses telemetry).
 *
 * The core (`runDoctor`) is pure: every environment touch is an injected probe,
 * so tests drive all pass/warn/fail permutations without depending on the real
 * machine. The thin command in cli.ts wires the real probes and renders.
 */

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  /** Human label, e.g. "Node version". */
  label: string;
  status: DoctorStatus;
  /** One-line detail explaining the result. */
  detail: string;
}

export interface DoctorProbes {
  /** Raw `process.versions.node`, e.g. "20.11.0". */
  nodeVersion: string;
  /**
   * Resolve an executable name (or absolute path) on PATH. Returns the resolved
   * path, or null when not found. Must NOT spawn the program — resolution only.
   */
  resolveBin: (name: string) => string | null;
  /** Parsed config (may be empty). */
  config: GleanConfig;
  /** Where the config would live (for the info line). */
  configPath: string;
  /** Whether the config file exists on disk. */
  configExists: boolean;
  /**
   * Probe whether better-sqlite3 can actually load. Must catch its own errors
   * and return a structured result — never throw.
   */
  sqliteOk: () => { ok: boolean; message?: string };
}

const MIN_NODE_MAJOR = 20;

/** Parse the major version out of a semver-ish string; NaN when unparseable. */
function majorOf(version: string): number {
  const m = version.match(/^(\d+)\./);
  return m ? Number(m[1]) : NaN;
}

export function runDoctor(p: DoctorProbes): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  // 1. Node version — hard requirement.
  const major = majorOf(p.nodeVersion);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    checks.push({ id: 'node', label: 'Node version', status: 'pass', detail: `${p.nodeVersion} (>= ${MIN_NODE_MAJOR})` });
  } else {
    checks.push({
      id: 'node',
      label: 'Node version',
      status: 'fail',
      detail: `${p.nodeVersion} — glean needs Node >= ${MIN_NODE_MAJOR}`,
    });
  }

  // 2. claude CLI — hard. A missing claude is the #1 first-run failure, so fail
  //    (not warn). Resolve the CONFIGURED claude_bin when present, else "claude".
  const claudeName = p.config.claude_bin ?? 'claude';
  const claudePath = p.resolveBin(claudeName);
  if (claudePath) {
    checks.push({ id: 'claude', label: 'claude CLI', status: 'pass', detail: claudePath });
  } else {
    checks.push({
      id: 'claude',
      label: 'claude CLI',
      status: 'fail',
      detail: `'${claudeName}' not found on PATH — glean spawns 'claude -p' for every run`,
    });
  }

  // 3. git — hard (discovery + draft-impl shell out to git).
  const gitPath = p.resolveBin('git');
  if (gitPath) {
    checks.push({ id: 'git', label: 'git', status: 'pass', detail: gitPath });
  } else {
    checks.push({ id: 'git', label: 'git', status: 'fail', detail: "'git' not found on PATH — required for discovery and draft-impl" });
  }

  // 4. gh — OPTIONAL. PR discovery uses it, but glean works without it → warn.
  const ghPath = p.resolveBin('gh');
  if (ghPath) {
    checks.push({ id: 'gh', label: 'gh (GitHub CLI)', status: 'pass', detail: ghPath });
  } else {
    checks.push({
      id: 'gh',
      label: 'gh (GitHub CLI)',
      status: 'warn',
      detail: "not found on PATH — optional; PR discovery is skipped without it",
    });
  }

  // 5. config presence — info, never a failure.
  if (p.configExists) {
    const projects = p.config.projects ?? {};
    const n = Object.keys(projects).length;
    const draftImpl = Object.values(projects).filter((e) => e?.base_branch).length;
    const draftNote = draftImpl > 0 ? ` (${draftImpl} with draft-impl enabled)` : '';
    checks.push({
      id: 'config',
      label: 'config',
      status: 'info',
      detail: `${p.configPath} — ${n} project${n === 1 ? '' : 's'} configured${draftNote}`,
    });
  } else {
    checks.push({
      id: 'config',
      label: 'config',
      status: 'info',
      detail: `none yet at ${p.configPath} — created on first 'glean run'`,
    });
  }

  // 6. better-sqlite3 — WARN if unavailable (telemetry/memory off, but glean's
  //    core run path still works; this is the surface that explains a broken
  //    global install's lost telemetry — see F6).
  const sqlite = p.sqliteOk();
  if (sqlite.ok) {
    checks.push({ id: 'sqlite', label: 'better-sqlite3 (telemetry)', status: 'pass', detail: 'native binding loads' });
  } else {
    checks.push({
      id: 'sqlite',
      label: 'better-sqlite3 (telemetry)',
      status: 'warn',
      detail: `unavailable: ${sqlite.message ?? 'unknown error'} — telemetry/memory (today/rate/morning) disabled`,
    });
  }

  return checks;
}

export interface DoctorSummary {
  ok: boolean;
  exitCode: number;
  failures: number;
  warnings: number;
}

/** A run is healthy iff no HARD requirement failed. Warnings never fail it. */
export function summarizeDoctor(checks: DoctorCheck[]): DoctorSummary {
  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const ok = failures === 0;
  return { ok, exitCode: ok ? 0 : 1, failures, warnings };
}

type Painter = { green: (s: string) => string; yellow: (s: string) => string; red: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string };
const ANSI: Painter = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const PLAIN: Painter = { green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s };

function marker(status: DoctorStatus, c: Painter): string {
  switch (status) {
    case 'pass': return c.green('PASS');
    case 'warn': return c.yellow('WARN');
    case 'fail': return c.red('FAIL');
    case 'info': return c.dim('INFO');
  }
}

export function renderDoctor(checks: DoctorCheck[], useColor: boolean): string {
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];
  lines.push(c.bold('glean doctor — environment preflight'));
  lines.push('');
  const labelWidth = Math.max(...checks.map((x) => x.label.length));
  for (const check of checks) {
    const pad = check.label.padEnd(labelWidth);
    lines.push(`  ${marker(check.status, c)}  ${pad}  ${c.dim(check.detail)}`);
  }
  lines.push('');
  const summary = summarizeDoctor(checks);
  if (summary.ok) {
    const warnNote = summary.warnings > 0 ? ` (${summary.warnings} warning${summary.warnings === 1 ? '' : 's'})` : '';
    lines.push(c.green(`all hard requirements pass${warnNote}`));
  } else {
    lines.push(c.red(`${summary.failures} hard requirement${summary.failures === 1 ? '' : 's'} failed — glean cannot run real sessions until fixed`));
  }
  return lines.join('\n');
}

/**
 * Resolve an executable on PATH WITHOUT spawning it. Uses `where` (Windows) /
 * `which` (POSIX). On Windows, also probes the `.cmd` variant — npm-global bins
 * like `claude`/`gh` install as `.cmd` shims (mirrors executor.resolveSpawn).
 * Returns the first resolved path, or null when nothing is found.
 */
export function resolveBinOnPath(name: string): string | null {
  // An absolute/relative path that already exists resolves to itself.
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) ? name : null;
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const candidates = process.platform === 'win32' ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const cand of candidates) {
    try {
      const out = execFileSync(finder, [cand], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim()
        .split(/\r?\n/)[0];
      if (out) return out;
    } catch {
      /* not found via this candidate — try the next */
    }
  }
  return null;
}

/**
 * Probe whether better-sqlite3 actually loads, catching every failure mode
 * (missing module, ABI/NODE_MODULE_VERSION mismatch) so doctor itself never
 * crashes on a broken native binding — the whole point of this check.
 */
export async function probeSqlite(): Promise<{ ok: boolean; message?: string }> {
  try {
    await import('better-sqlite3');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message.split(/\r?\n/)[0] };
  }
}

/**
 * Build the real, machine-touching probes for `glean doctor`. Kept out of the
 * pure core so tests can inject fakes; cli.ts just calls this then runDoctor.
 */
export async function defaultDoctorProbes(): Promise<DoctorProbes> {
  const configPath = defaultConfigPath();
  const configExists = existsSync(configPath);
  let config: GleanConfig = {};
  if (configExists) {
    try {
      config = loadConfig(configPath);
    } catch {
      // A malformed config shouldn't break doctor — treat as empty; the config
      // check still reports the file's presence.
      config = {};
    }
  }
  const sqlite = await probeSqlite();
  return {
    nodeVersion: process.versions.node,
    resolveBin: resolveBinOnPath,
    config,
    configPath,
    configExists,
    sqliteOk: () => sqlite,
  };
}
