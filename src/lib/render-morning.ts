import type { CandidateType } from './types.js';

// The "while you slept" receipt — narrates the most recent glean run as a
// screenshot-able terminal report. Pure renderer: all data sourcing lives in
// morning.ts, all formatting lives here (mirrors today.ts / render-today.ts).

export type MorningBranchEntry = {
  title: string;
  prep_branch: string;
  worktree: string;
  files: number;
  insertions: number;
  deletions: number;
  status: string;
  // 'pass' | 'fail' | 'none' | 'unknown' — best-effort test status from the run.
  test_status: 'pass' | 'fail' | 'none' | 'unknown';
};

export type MorningFileEntry = {
  title: string;
  status: string;
  output: string;
  type: CandidateType;
};

export type MorningReport = {
  run_id: string;
  project_path: string;
  // The main checkout the worktrees are linked to (used in discard commands).
  main_repo: string;
  started_at: number;
  ended_at: number | null;
  exit_reason: string | null;
  rate_limit_hits: number;
  branches: MorningBranchEntry[];
  files: MorningFileEntry[];
  // T6: number of drain-window bursts aggregated into this report. Absent (or 1)
  // means single-run mode (bare `glean run` receipt — byte-identical to pre-T6).
  bursts?: number;
  // v0.8.1: summed active minutes across the window's bursts (each burst's
  // ended_at - started_at). Absent in single-run mode. Used by the receipt totals.
  drained_minutes?: number;
};

export type Painter = {
  bold:  (s: string) => string;
  dim:   (s: string) => string;
  green: (s: string) => string;
  red:   (s: string) => string;
  cyan:  (s: string) => string;
};

const ANSI: Painter = {
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
};

export const PLAIN: Painter = {
  bold:  (s) => s,
  dim:   (s) => s,
  green: (s) => s,
  red:   (s) => s,
  cyan:  (s) => s,
};

export function renderMorning(report: MorningReport, useColor: boolean): string {
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];

  // T6: a 0-burst window (laptop asleep all window) has no real run_id — don't
  // render a fake "(run (none))". Otherwise show the run id as before.
  lines.push(c.bold(
    report.bursts === 0
      ? 'GLEAN — while you slept'
      : `GLEAN — while you slept (run ${report.run_id})`,
  ));
  lines.push(c.dim(`  ${describeWhen(report.started_at, report.ended_at)}`));
  lines.push('');

  for (const b of report.branches) {
    renderBranch(b, report.main_repo, c, lines);
    lines.push('');
  }

  for (const f of report.files) {
    renderFile(f, c, lines);
  }
  if (report.files.length > 0) lines.push('');

  // Run-level summary — minutes, rate-limit hits, honest outcome.
  const mins = elapsedMinutes(report.started_at, report.ended_at);
  const hitsNoun = report.rate_limit_hits === 1 ? 'rate-limit hit' : 'rate-limit hits';
  lines.push(c.dim(`${mins} min spent · ${report.rate_limit_hits} ${hitsNoun}`));

  // T6: drain-window coverage line — only emitted when bursts field is present.
  if (report.bursts !== undefined) {
    if (report.bursts === 0) {
      lines.push(c.dim('Coverage: 0 bursts — nothing ran this window.'));
    } else {
      const noun = report.bursts === 1 ? 'burst' : 'bursts';
      lines.push(c.dim(`Coverage: woke for ${report.bursts} ${noun} this window.`));
    }
  }

  lines.push(outcomeLine(report.exit_reason, c));

  return lines.join('\n');
}

function renderBranch(b: MorningBranchEntry, mainRepo: string, c: Painter, lines: string[]): void {
  // I6: a draft-impl whose provisioning/commit failed produced NO branch. Render
  // it as an explicit "attempted — nothing landed" line instead of dropping it
  // (or fabricating review/discard commands for a worktree that doesn't exist).
  if (!b.prep_branch) {
    lines.push(c.bold('▸ draft attempted'));
    lines.push(`    ${b.title}`);
    lines.push(`    ${c.dim('attempted — nothing landed (review logs)')}`);
    return;
  }

  const trivial = b.files === 0 || (b.insertions + b.deletions) === 0;
  lines.push(c.bold(`▸ branch ${c.cyan(b.prep_branch)}`));
  lines.push(`    ${b.title}`);

  if (trivial) {
    // T14: an empty/trivial diff is NOT a "while you slept" win. Be honest.
    lines.push(`    ${c.dim('draft produced no changes (review)')}`);
  } else {
    const stat = `${c.green('+' + b.insertions)} / ${c.red('-' + b.deletions)} across ${b.files} ${b.files === 1 ? 'file' : 'files'}`;
    lines.push(`    ${stat}`);
  }

  lines.push(`    ${c.dim('tests: ' + describeTest(b.test_status))}`);

  // Review: the prep branch is already checked out in the linked worktree, so
  // `git checkout prep/...` in the main repo FAILS. cd into the worktree.
  lines.push(`    ${c.dim('Review:')}  cd ${b.worktree}`);
  // Discard: rm -rf would orphan the worktree registration; go through git.
  lines.push(`    ${c.dim('Discard:')} git -C ${mainRepo} worktree remove --force ${b.worktree} && git -C ${mainRepo} branch -D ${b.prep_branch}`);
  // Trust line (premise 3): isolation is the selling point, stated plainly.
  lines.push(`    ${c.dim('Your main was never touched — nothing pushed, nothing merged.')}`);
}

function renderFile(f: MorningFileEntry, c: Painter, lines: string[]): void {
  const isOk = f.status === 'ok' || f.status === 'ok-fallback';
  const icon = isOk ? c.green('✓') : c.red('✗');
  lines.push(`  ${icon} ${f.title}`);
  const outputDisplay = f.output ? normalizePath(f.output) : '(no output)';
  lines.push(`      ${c.dim(outputDisplay)}`);
}

// exit_reason → an honest, plain phrase.
// CRITICAL honesty rule: ONLY 'weekly-drained' may claim the week was drained.
// Every other reason must NOT use the words "drained", "weekly", or "whole week".
export function outcomeLine(reason: string | null, c: Painter): string {
  switch (reason) {
    case 'completed':
      return c.green('Outcome: completed — worked through the queue and finished.');
    case 'budget-exhausted':
      return c.dim('Outcome: stopped: budget exhausted (wall-clock budget reached).');
    case 'rate-limit':
      return c.dim('Outcome: stopped: rate limit (hit a Claude rate limit).');
    case 'stop-sentinel':
      return c.dim('Outcome: stopped: STOP sentinel.');
    case 'no-candidates':
      return c.dim('Outcome: no candidates — nothing to work on this run.');
    case 'lock-busy':
      return c.dim('Outcome: another glean run held the lock.');
    // v0.8 drain exit reasons (T6 shared contract):
    case 'weekly-drained':
      // THE ONLY phrase allowed to claim the week was drained.
      return c.green('Outcome: drained weekly capacity (hit the weekly limit).');
    case 'session-paused':
      return c.dim('Outcome: paused at the session limit — will resume next window.');
    case 'no-progress':
      return c.dim('Outcome: stopped early: no new work produced.');
    case 'ambiguous-signal':
      return c.dim('Outcome: stopped early: unrecognized rate-limit signal.');
    case 'discovery-failed':
      return c.dim('Outcome: stopped early: discovery failed (transient).');
    default:
      return c.dim(`Outcome: ${reason ?? 'unknown'}.`);
  }
}

// Surface the captured deterministic test status verbatim (pass | fail | none).
// 'unknown' is ONLY for runs recorded before the v5 migration, where the field
// is genuinely absent — never for a configured-but-skipped test.
function describeTest(s: MorningBranchEntry['test_status']): string {
  switch (s) {
    case 'pass': return 'pass';
    case 'fail': return 'fail';
    case 'none': return 'none';
    default:     return 'unknown';
  }
}

function describeWhen(start: number, end: number | null): string {
  const at = formatLocalDateTime(end ?? start);
  return `ran ${at}`;
}

function elapsedMinutes(start: number, end: number | null): number {
  if (end === null) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function normalizePath(p: string): string {
  const m = p.match(/^(.*?[/\\])glean[/\\]dossiers[/\\](.*)$/);
  if (m) {
    return `~/glean/dossiers/${m[2].replace(/\\/g, '/')}`;
  }
  return p.replace(/\\/g, '/');
}
