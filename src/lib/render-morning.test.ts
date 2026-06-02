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

describe('renderMorning — branchless draft-impl attempt (I6)', () => {
  it('renders an "attempted — nothing landed" line for a draft-impl with no prep branch', () => {
    const report = baseReport({
      branches: [
        {
          title: 'Implement the thing',
          prep_branch: '', // provisioning/commit failed → no branch
          worktree: '',
          files: 0,
          insertions: 0,
          deletions: 0,
          status: 'failed',
          test_status: 'none',
        },
      ],
    });
    const out = renderMorning(report, false);
    expect(out).toContain('Implement the thing');
    expect(out.toLowerCase()).toContain('attempted');
    expect(out.toLowerCase()).toContain('nothing landed');
    expect(out.toLowerCase()).toContain('review logs');
    // No fabricated review/discard commands for a non-existent worktree/branch.
    expect(out).not.toMatch(/worktree remove/);
    expect(out).not.toMatch(/branch -D/);
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

describe('renderMorning — v0.8 drain exit reasons (T6)', () => {
  const drainCases: Array<[string, RegExp]> = [
    ['session-paused',   /paused at the session limit/i],
    ['no-progress',      /no new work produced/i],
    ['ambiguous-signal', /unrecognized rate-limit signal/i],
    ['discovery-failed', /discovery failed/i],
    ['weekly-drained',   /drained weekly capacity/i],
  ];

  for (const [reason, re] of drainCases) {
    it(`maps exit_reason '${reason}' to the correct phrase`, () => {
      const out = renderMorning(baseReport({ exit_reason: reason }), false);
      expect(out).toMatch(re);
    });
  }

  it("ONLY 'weekly-drained' claims the week was drained", () => {
    const weeklyDrainedOut = renderMorning(baseReport({ exit_reason: 'weekly-drained' }), false).toLowerCase();
    expect(weeklyDrainedOut).toContain('drained');

    // Every other v0.8 reason must NOT claim the week was drained.
    const nonDrainReasons = ['session-paused', 'no-progress', 'ambiguous-signal', 'discovery-failed'];
    for (const reason of nonDrainReasons) {
      const out = renderMorning(baseReport({ exit_reason: reason }), false).toLowerCase();
      expect(out, `exit_reason '${reason}' must not claim week was drained`).not.toContain('drained');
      expect(out, `exit_reason '${reason}' must not claim weekly`).not.toContain('weekly');
    }
  });

  it("'session-paused' does NOT say 'drained', 'weekly', or 'whole week'", () => {
    const out = renderMorning(baseReport({ exit_reason: 'session-paused' }), false).toLowerCase();
    expect(out).not.toContain('drained');
    expect(out).not.toContain('weekly');
    expect(out).not.toContain('whole week');
    expect(out).toContain('paused');
  });
});

describe('renderMorning — bursts coverage line (T6)', () => {
  it('emits no coverage line when bursts is absent (single-run fallback — byte-identical)', () => {
    const out = renderMorning(baseReport(), false);
    expect(out).not.toContain('Coverage:');
    expect(out).not.toContain('burst');
  });

  it('emits "woke for N burst(s) this window" when bursts >= 1', () => {
    const out1 = renderMorning(baseReport({ bursts: 1 }), false);
    expect(out1).toContain('Coverage: woke for 1 burst this window.');

    const out3 = renderMorning(baseReport({ bursts: 3 }), false);
    expect(out3).toContain('Coverage: woke for 3 bursts this window.');
  });

  it('emits "0 bursts — nothing ran this window" when bursts=0', () => {
    const out = renderMorning(baseReport({ bursts: 0 }), false);
    expect(out).toContain('Coverage: 0 bursts — nothing ran this window.');
    // Must not imply success
    expect(out).not.toContain('woke for');
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
