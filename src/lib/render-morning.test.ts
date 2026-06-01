import { describe, it, expect } from 'vitest';
import { renderMorning, type MorningReport } from './render-morning.js';

function baseReport(overrides: Partial<MorningReport> = {}): MorningReport {
  return {
    run_id: '2026-06-01-0312-abc123',
    project_path: 'C:\\demoproj',
    main_repo: 'C:\\demoproj',
    started_at: Date.parse('2026-06-01T03:12:00.000Z'),
    ended_at: Date.parse('2026-06-01T03:18:00.000Z'),
    exit_reason: 'completed',
    rate_limit_hits: 0,
    branches: [],
    files: [],
    ...overrides,
  };
}

describe('renderMorning — branch (draft-impl) entry', () => {
  it('renders the prep branch, diff stat, review (cd worktree) and discard commands', () => {
    const report = baseReport({
      branches: [
        {
          title: 'Implement retry in fetch.ts',
          prep_branch: 'prep/glean-task-1',
          worktree: 'C:\\Users\\u\\glean\\work\\demoproj-task-1',
          files: 2,
          insertions: 47,
          deletions: 3,
          status: 'ok',
          test_status: 'pass',
        },
      ],
    });
    const out = renderMorning(report, false);
    expect(out).toContain('prep/glean-task-1');
    expect(out).toContain('+47');
    expect(out).toContain('-3');
    expect(out).toContain('2 file');
    expect(out).toContain('Implement retry in fetch.ts');
    // Review must be `cd <worktree>`, NOT a `git checkout prep/...`
    expect(out).toContain('cd C:\\Users\\u\\glean\\work\\demoproj-task-1');
    expect(out).not.toMatch(/git checkout prep/);
    // Discard command goes through git worktree remove + branch -D
    expect(out).toContain('git -C C:\\demoproj worktree remove --force C:\\Users\\u\\glean\\work\\demoproj-task-1');
    expect(out).toContain('git -C C:\\demoproj branch -D prep/glean-task-1');
    // Test status surfaced
    expect(out).toContain('pass');
  });

  it('shows the trust line: main was never touched / nothing pushed', () => {
    const report = baseReport({
      branches: [
        {
          title: 'x', prep_branch: 'prep/glean-1', worktree: 'C:\\w\\demoproj-1',
          files: 1, insertions: 5, deletions: 0, status: 'ok', test_status: 'none',
        },
      ],
    });
    const out = renderMorning(report, false).toLowerCase();
    expect(out).toContain('main');
    expect(out).toMatch(/never touched|untouched|never pushed/);
  });
});

describe('renderMorning — test status line', () => {
  function branchWith(test_status: MorningReport['branches'][number]['test_status']): MorningReport {
    return baseReport({
      branches: [
        {
          title: 'x', prep_branch: 'prep/glean-1', worktree: 'C:\\w\\demoproj-1',
          files: 1, insertions: 5, deletions: 0, status: 'ok', test_status,
        },
      ],
    });
  }

  it("renders 'tests: pass' when the captured status is pass", () => {
    const out = renderMorning(branchWith('pass'), false);
    expect(out).toContain('tests: pass');
    expect(out).not.toContain('tests: unknown');
  });

  it("renders 'tests: fail' when the captured status is fail", () => {
    const out = renderMorning(branchWith('fail'), false);
    expect(out).toContain('tests: fail');
    expect(out).not.toContain('tests: unknown');
  });

  it("renders 'tests: none' for 'none' (configured-but-not-run / not pass-or-fail), NOT unknown", () => {
    const out = renderMorning(branchWith('none'), false);
    expect(out).toContain('tests: none');
    expect(out).not.toContain('tests: unknown');
  });

  it("renders 'tests: unknown' ONLY when the status is genuinely absent (old runs)", () => {
    const out = renderMorning(branchWith('unknown'), false);
    expect(out).toContain('tests: unknown');
  });
});

describe('renderMorning — trivial-diff guard (T14)', () => {
  it('renders "no changes (review)" instead of a celebratory stat when 0 files', () => {
    const report = baseReport({
      branches: [
        {
          title: 'Tried a TODO', prep_branch: 'prep/glean-2', worktree: 'C:\\w\\demoproj-2',
          files: 0, insertions: 0, deletions: 0, status: 'failed', test_status: 'none',
        },
      ],
    });
    const out = renderMorning(report, false);
    expect(out).toContain('no changes');
    // No celebratory +/- stat line for an empty diff
    expect(out).not.toContain('+0 / -0');
  });

  it('renders "no changes (review)" when files>0 but 0 insertions+deletions', () => {
    const report = baseReport({
      branches: [
        {
          title: 'Edited but trivial', prep_branch: 'prep/glean-3', worktree: 'C:\\w\\demoproj-3',
          files: 1, insertions: 0, deletions: 0, status: 'ok', test_status: 'none',
        },
      ],
    });
    const out = renderMorning(report, false);
    expect(out).toContain('no changes');
  });
});

describe('renderMorning — file / dossier entry', () => {
  it('renders a today-style line for dossier candidates', () => {
    const report = baseReport({
      files: [
        { title: 'Research caching strategies', status: 'ok', output: 'C:\\Users\\u\\glean\\dossiers\\demoproj\\2026-06-01\\x\\OUT.md', type: 'research-dossier' },
      ],
    });
    const out = renderMorning(report, false);
    expect(out).toContain('Research caching strategies');
    expect(out).toContain('OUT.md');
  });
});

describe('renderMorning — honest outcome line per exit_reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['completed', /completed/i],
    ['budget-exhausted', /budget/i],
    ['rate-limit', /rate limit/i],
    ['stop-sentinel', /STOP sentinel/i],
    ['no-candidates', /no candidates/i],
  ];
  for (const [reason, re] of cases) {
    it(`maps exit_reason '${reason}' to an honest phrase`, () => {
      const report = baseReport({ exit_reason: reason });
      const out = renderMorning(report, false);
      expect(out).toMatch(re);
    });
  }

  it('NEVER claims it drained the weekly capacity', () => {
    for (const [reason] of cases) {
      const out = renderMorning(baseReport({ exit_reason: reason }), false).toLowerCase();
      expect(out).not.toContain('drained');
      expect(out).not.toContain('weekly');
      expect(out).not.toContain('whole week');
    }
  });

  it('renders minutes spent and rate-limit hits in the summary', () => {
    const report = baseReport({ rate_limit_hits: 2 });
    const out = renderMorning(report, false);
    expect(out).toContain('6 min'); // 03:12 → 03:18
    expect(out).toContain('2 rate-limit hits');
  });
});

describe('renderMorning — color vs plain', () => {
  it('emits ANSI codes when useColor=true and none when false', () => {
    const report = baseReport({
      branches: [
        { title: 'x', prep_branch: 'prep/glean-1', worktree: 'C:\\w\\demoproj-1', files: 1, insertions: 5, deletions: 0, status: 'ok', test_status: 'pass' },
      ],
    });
    const colored = renderMorning(report, true);
    const plain = renderMorning(report, false);
    expect(colored).toContain('\x1b[');
    expect(plain).not.toContain('\x1b[');
  });

  it('renders a header naming the run and when it ran', () => {
    const out = renderMorning(baseReport(), false);
    expect(out).toContain('2026-06-01-0312-abc123');
  });
});
