import { describe, it, expect } from 'vitest';
import { renderReceiptMarkdown } from './render-receipt.js';
import type { MorningReport } from './render-morning.js';

function report(over: Partial<MorningReport> = {}): MorningReport {
  return {
    run_id: 'r1',
    project_path: 'C:\\code\\my-app',
    main_repo: 'C:\\code\\my-app',
    started_at: Date.parse('2026-06-02T08:00:00Z'),
    ended_at: Date.parse('2026-06-02T09:00:00Z'),
    exit_reason: 'completed',
    rate_limit_hits: 0,
    branches: [],
    files: [],
    ...over,
  };
}

describe('renderReceiptMarkdown', () => {
  it('headers with the project basename and a date', () => {
    expect(renderReceiptMarkdown(report())).toContain('# glean — my-app — 2026-06-02');
  });

  it('only weekly-drained claims the week was drained (honesty rule, single source)', () => {
    expect(renderReceiptMarkdown(report({ exit_reason: 'weekly-drained' }))).toContain('drained weekly capacity');
    for (const r of ['session-paused', 'no-progress', 'ambiguous-signal', 'completed', 'budget-exhausted', 'discovery-failed', 'rate-limit', 'stop-sentinel', 'no-candidates', 'lock-busy']) {
      expect(renderReceiptMarkdown(report({ exit_reason: r }))).not.toContain('drained weekly capacity');
    }
  });

  it('renders a totals line with counts + diffstat + minutes + coverage', () => {
    const md = renderReceiptMarkdown(report({
      bursts: 2,
      drained_minutes: 42,
      branches: [{ title: 'T', prep_branch: 'prep/glean-x', worktree: 'C:\\w', files: 2, insertions: 10, deletions: 3, status: 'ok', test_status: 'pass' }],
      files: [{ title: 'D', status: 'ok', output: 'C:\\u\\glean\\dossiers\\my-app\\2026-06-02\\docs\\zod.md', type: 'fetch-docs' }],
    }));
    expect(md).toContain('1 draft branch');
    expect(md).toContain('1 dossier');
    expect(md).toContain('+10 / -3');
    expect(md).toContain('~42 min');
    expect(md).toContain('woke for 2 bursts');
  });

  it('renders a branch with diff stat, test status, review/discard, trust line', () => {
    const md = renderReceiptMarkdown(report({
      branches: [{ title: 'Fix X', prep_branch: 'prep/glean-abc', worktree: 'C:\\wt', files: 1, insertions: 5, deletions: 1, status: 'ok', test_status: 'pass' }],
    }));
    expect(md).toContain('`prep/glean-abc`');
    expect(md).toContain('+5 / -1');
    expect(md).toContain('tests: pass');
    expect(md).toContain('cd C:\\wt');
    expect(md).toContain('worktree remove --force');
    expect(md).toContain('main` was never touched');
  });

  it('0-burst window reads honestly, no false success', () => {
    const md = renderReceiptMarkdown(report({ bursts: 0, branches: [], files: [] }));
    expect(md).toContain('0 bursts — nothing ran this window');
    expect(md).not.toContain('drained weekly capacity');
  });

  it('single-run mode (no bursts field) omits the coverage line', () => {
    expect(renderReceiptMarkdown(report())).not.toContain('Coverage:');
  });
});
