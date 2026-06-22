import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import type { DraftTestStatus } from './types.js';

// Run the project's per-project `test_command` INSIDE the draft worktree to
// capture a deterministic pass/fail. This is glean's OWN check — the spawned
// `claude -p` session also runs tests, but its result is invisible to glean, so
// glean re-runs and owns the surfaced status.
//
// Status mapping (HEURISTIC — the only fully trustworthy signal is exit 0 → pass):
//   exit 0                                   → 'pass'
//   non-zero + env/setup-failure signature   → 'none'  (couldn't run cleanly)
//   non-zero otherwise                       → 'fail'  (a suite that ran + failed)
//   no command                               → 'none'
//   unrunnable first token / throw / timeout → 'none'  (NEVER crash the executor)
//
// I3 rationale: a fresh `git worktree` has no node_modules, so a real project's
// `npm test` exits nonzero with "Cannot find module" / "missing script" — that is
// an ENVIRONMENT failure (the suite never ran), NOT a genuine test failure. We
// inspect combined stdout/stderr for known setup-failure signatures and map those
// to 'none' so a bare worktree is never misreported as 'fail'. This is a best-
// effort heuristic; exit 0 → pass remains the clean, unambiguous signal.
//
// C1: `remainingBudgetMs` (when provided) clamps the run timeout so the test run
// can never exceed the run's remaining wall-clock `--budget`. The actual timeout
// is min(TEST_RUN_CAP_MS, taskTimeoutMs, remainingBudgetMs). The caller already
// SKIPS this function when remaining budget <= 0 or STOP is set.
const TEST_RUN_CAP_MS = 5 * 60_000;

// Case-insensitive substrings that indicate the test runner could not start
// (environment/setup failure), as opposed to a suite that ran and reported
// failures. Covers the common Node / shell / runner cases on both platforms.
const ENV_FAILURE_SIGNATURES = [
  'cannot find module',
  'module not found',
  'command not found',
  'is not recognized as an internal or external command', // Windows cmd.exe
  'enoent',
  'no test files found',
  'no tests found',
  'missing script',
  'cannot find package',
];

function looksLikeEnvFailure(output: string): boolean {
  const hay = output.toLowerCase();
  return ENV_FAILURE_SIGNATURES.some((sig) => hay.includes(sig));
}

export function runTestCommand(
  testCommand: string | undefined,
  worktree: string,
  taskTimeoutMs: number,
  remainingBudgetMs?: number,
): DraftTestStatus {
  const cmd = testCommand?.trim();
  if (!cmd) return 'none';
  // Distinguish "test_command is not runnable on this machine" from "tests
  // failed": under `shell: true` a missing program returns exit 1 (cmd.exe /
  // sh), indistinguishable from a real failure by exit code alone. So resolve
  // the FIRST token (the program) on PATH first — if it isn't resolvable, this
  // is 'none' (not run), never 'fail'.
  if (!isProgramRunnable(firstToken(cmd))) return 'none';
  try {
    // C1: the test-run timeout is bounded by ALL of: the 5-min cap, the per-task
    // timeout, and the run's remaining wall-clock budget — so it can never push
    // the run past `--budget`.
    const bounds = [TEST_RUN_CAP_MS];
    if (taskTimeoutMs > 0) bounds.push(taskTimeoutMs);
    if (remainingBudgetMs !== undefined && remainingBudgetMs > 0) bounds.push(remainingBudgetMs);
    const timeout = Math.min(...bounds);
    const res = spawnSync(cmd, {
      cwd: worktree,
      shell: true,           // resolve PATH + allow "npm test"-style commands
      timeout,
      encoding: 'utf8',      // capture stdout/stderr to classify env-vs-real failures (I3)
      windowsHide: true,
    });
    // spawnSync sets .error on spawn failure (ENOENT) or timeout (ETIMEDOUT).
    if (res.error) return 'none';
    // A killed/timed-out child has signal set and status null → treat as 'none'.
    if (res.status === null) return 'none';
    if (res.status === 0) return 'pass';
    // I3: non-zero — distinguish "couldn't run" (env/setup) from "ran + failed".
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    return looksLikeEnvFailure(combined) ? 'none' : 'fail';
  } catch {
    return 'none';
  }
}

// First token of a command line (the program name), RESPECTING a leading
// double-quoted span so a quoted path containing spaces — e.g.
// `"C:\Program Files\nodejs\node.exe" test` — resolves as ONE token, not the
// truncated `"C:\Program` (I1). A bare (unquoted) first token splits on the
// first whitespace as before.
function firstToken(cmd: string): string {
  const s = cmd.trimStart();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end > 0) return s.slice(1, end);
    return s.slice(1); // unterminated quote — best effort
  }
  return s.split(/\s+/)[0] ?? '';
}

// True if `program` resolves to an executable on PATH (where/which) OR is an
// explicit path to an existing file. Used to map an unrunnable test_command to
// 'none' rather than a misleading 'fail'.
//
// I1: a quoted-path test_command resolves to an ABSOLUTE/RELATIVE program path
// (e.g. "C:\Program Files\nodejs\node.exe"). `where`/`which` only resolve bare
// names on PATH — handed a full path they fail — so we first short-circuit on an
// existing file at that path before falling back to the PATH finder.
function isProgramRunnable(program: string): boolean {
  if (!program) return false;
  // Explicit path to an existing file (covers quoted absolute/relative paths).
  if (/[\\/]/.test(program)) {
    try { if (existsSync(program)) return true; } catch { /* fall through */ }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [program], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
