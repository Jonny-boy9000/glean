import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import type { DraftTestStatus } from './types.js';

// Run the project's per-project `test_command` INSIDE the draft worktree to
// capture a deterministic pass/fail. This is glean's OWN check — the spawned
// `claude -p` session also runs tests, but its result is invisible to glean, so
// glean re-runs and owns the surfaced status.
//
// Status mapping (ADR-0014 — HEURISTIC; the only assumption-free signal is exit 0 → pass):
//   exit 0                                          → 'pass'
//   non-zero, no env signature in the PREAMBLE      → 'fail'  (a suite that ran + failed)
//   no test_command                                 → 'no-command'
//   unrunnable first token / spawn ENOENT / killed  → 'env-blocked' (suite never started)
//   env signature in the runner PREAMBLE            → 'env-blocked'
//   throw                                           → 'env-blocked' (NEVER crash the executor)
//
// ANCHOR (ADR-0014): an env/setup failure means the suite NEVER STARTED, so its
// signature can only appear in the runner's STARTUP preamble — not interleaved with
// passing/failing test lines. We scan only the preamble (text before the first
// test-result fence line, capped), so a REAL failure that prints "enoent" / "cannot
// find module" in its OUTPUT stays 'fail'. The executor links the base `node_modules`
// into the worktree before this runs (ADR-0014), so a Node/TS draft that would pass
// after `npm install` reaches 'pass' instead of a false 'env-blocked'.
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

// ASSUMPTION[ADR-0014]: a heuristic allow-list of runner-progress markers that mean
// "the suite has started printing results" (vitest/jest/mocha/TAP/pytest). Matched at
// LINE START (after trim, case-insensitive) so an assertion message containing "PASS"
// mid-sentence isn't mistaken for a run marker. Resist growing it; exit 0 → pass stays
// the assumption-free signal, and the node_modules link shrinks the env-blocked population.
const SUITE_STARTED_FENCE = [
  'ok ', 'not ok ', 'tap version',         // TAP
  'pass ', 'fail ',                         // jest/vitest per-file result lines
  '✓', '✗', '√', '×',                       // vitest/mocha check glyphs
  'test files', 'tests ',                   // vitest summary
  'run ',                                   // jest runner
  'collected ', '=== test session starts',  // pytest
];
const PREAMBLE_LINE_CAP = 50;

// The runner's STARTUP preamble: lines before the first suite-started fence, capped
// so a giant single-line failure dump can't be mis-walked. If no fence appears, the
// whole (capped) output is the preamble — i.e. the suite never started.
export function preambleOf(output: string): string {
  const lines = output.split(/\r?\n/);
  const cap = Math.min(lines.length, PREAMBLE_LINE_CAP);
  const preamble: string[] = [];
  for (let i = 0; i < cap; i++) {
    const t = lines[i].trim().toLowerCase();
    if (t && SUITE_STARTED_FENCE.some((f) => t.startsWith(f))) break; // suite started — stop
    preamble.push(lines[i]);
  }
  return preamble.join('\n');
}

// True iff an env/setup-failure signature appears in the runner PREAMBLE (the suite
// never started). A signature AFTER a fence line (real test output) does NOT match.
export function preambleLooksLikeEnvFailure(output: string): boolean {
  const hay = preambleOf(output).toLowerCase();
  return ENV_FAILURE_SIGNATURES.some((sig) => hay.includes(sig));
}

export function runTestCommand(
  testCommand: string | undefined,
  worktree: string,
  taskTimeoutMs: number,
  remainingBudgetMs?: number,
): DraftTestStatus {
  const cmd = testCommand?.trim();
  if (!cmd) return 'no-command';
  // Distinguish "test_command is not runnable on this machine" from "tests
  // failed": under `shell: true` a missing program returns exit 1 (cmd.exe /
  // sh), indistinguishable from a real failure by exit code alone. So resolve
  // the FIRST token (the program) on PATH first — if it isn't resolvable, the
  // suite never started → 'env-blocked', never 'fail'.
  if (!isProgramRunnable(firstToken(cmd))) return 'env-blocked';
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
    // spawnSync sets .error on spawn failure (ENOENT) or timeout (ETIMEDOUT) — the
    // suite never produced a verdict → 'env-blocked' (not a test failure).
    if (res.error) return 'env-blocked';
    // A killed/timed-out child has signal set and status null → no usable verdict.
    if (res.status === null) return 'env-blocked';
    if (res.status === 0) return 'pass';
    // ADR-0014: non-zero — env failure (suite never started) ONLY if the signature
    // is in the runner PREAMBLE; a real fail printing "enoent" in its output stays 'fail'.
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    return preambleLooksLikeEnvFailure(combined) ? 'env-blocked' : 'fail';
  } catch {
    return 'env-blocked';
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
