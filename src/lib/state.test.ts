import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  releaseLock,
  isStopRequested,
  writeStop,
  clearStop,
  ensureTemplatesDir,
  ensureDefaultConfig,
  writeSummary,
  drainStatePath,
  readDrainState,
  writeDrainState,
  atomicWriteFileSync,
  STALE_LOCK_MS,
} from './state.js';
import type { DrainState } from './state.js';

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-state-'));
}

describe('lock', () => {
  it('acquires when free', () => {
    const root = newRoot();
    const lock = acquireLock(root, 'run-1');
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(root, 'state', 'RUN.lock'))).toBe(true);
  });

  it('refuses when a live process holds it', () => {
    const root = newRoot();
    acquireLock(root, 'run-1');
    const second = acquireLock(root, 'run-2');
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('busy');
  });

  it('recovers a stale lock whose PID is dead', () => {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(
      join(root, 'state', 'RUN.lock'),
      JSON.stringify({ pid: 999999, run_id: 'old', started_at: new Date().toISOString() }),
    );
    const lock = acquireLock(root, 'run-new');
    expect(lock.acquired).toBe(true);
    expect(lock.recovered).toBe(true);
  });

  it('releases', () => {
    const root = newRoot();
    acquireLock(root, 'run-1');
    releaseLock(root);
    expect(existsSync(join(root, 'state', 'RUN.lock'))).toBe(false);
  });
});

describe('stop sentinel', () => {
  it('is absent by default', () => {
    expect(isStopRequested(newRoot())).toBe(false);
  });

  it('detects when present', () => {
    const root = newRoot();
    writeStop(root);
    expect(isStopRequested(root)).toBe(true);
    clearStop(root);
    expect(isStopRequested(root)).toBe(false);
  });
});

describe('templates dir', () => {
  it('copies bundled templates on first run', () => {
    const root = newRoot();
    const bundled = mkdtempSync(join(tmpdir(), 'glean-bundle-'));
    writeFileSync(join(bundled, 'a.md'), 'A');
    writeFileSync(join(bundled, 'b.md'), 'B');
    ensureTemplatesDir(root, bundled);
    expect(readFileSync(join(root, 'templates', 'a.md'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'templates', 'b.md'), 'utf8')).toBe('B');
  });

  it('does not overwrite existing user templates', () => {
    const root = newRoot();
    mkdirSync(join(root, 'templates'), { recursive: true });
    writeFileSync(join(root, 'templates', 'a.md'), 'USER');
    const bundled = mkdtempSync(join(tmpdir(), 'glean-bundle-'));
    writeFileSync(join(bundled, 'a.md'), 'BUNDLED');
    ensureTemplatesDir(root, bundled);
    expect(readFileSync(join(root, 'templates', 'a.md'), 'utf8')).toBe('USER');
  });
});

describe('ensureDefaultConfig', () => {
  it('writes a default config when missing', () => {
    const root = newRoot();
    const result = ensureDefaultConfig(root);
    expect(result.created).toBe(true);
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    const parsed = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(parsed.claude_bin).toBe('claude');
  });

  it('does not overwrite an existing config', () => {
    const root = newRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ claude_bin: 'mine' }));
    const result = ensureDefaultConfig(root);
    expect(result.created).toBe(false);
    const parsed = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    expect(parsed.claude_bin).toBe('mine');
  });
});

describe('writeSummary', () => {
  it('writes summary.json', () => {
    const root = newRoot();
    const summary = {
      run_id: 'r1', started_at: 'now', ended_at: 'later', reason: 'completed' as const,
      budget_ms: 1000, elapsed_ms: 500, candidates_total: 0, ran: 0,
      skipped_dedup: 0, failed: 0, timed_out: 0, exit_code: 0,
    };
    writeSummary(root, 'r1', summary);
    const got = JSON.parse(readFileSync(join(root, 'state', 'r1', 'summary.json'), 'utf8'));
    expect(got.run_id).toBe('r1');
  });
});

describe('drainStatePath', () => {
  it('resolves to state/budget.json under root', () => {
    const root = newRoot();
    expect(drainStatePath(root)).toBe(join(root, 'state', 'budget.json'));
  });
});

function makeDrainState(): DrainState {
  return {
    drain_window_id: 'dw-test-1',
    drain_window_started_at: new Date().toISOString(),
    next_eligible_at: null,
    week_exhausted: false,
    last_observed_weekly_reset: null,
    completed_task_ids: [],
    unproductive_reentries: 0,
    schema: 1,
  };
}

describe('readDrainState', () => {
  it('returns missing when file does not exist', () => {
    const root = newRoot();
    const result = readDrainState(root);
    expect(result.kind).toBe('missing');
  });

  it('returns ok with state on valid roundtrip', () => {
    const root = newRoot();
    const state = makeDrainState();
    writeDrainState(root, state);
    const result = readDrainState(root);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state.drain_window_id).toBe('dw-test-1');
      expect(result.state.schema).toBe(1);
      expect(result.state.week_exhausted).toBe(false);
      expect(result.state.completed_task_ids).toEqual([]);
    }
  });

  it('returns corrupt (not missing) when file exists but is unparseable', () => {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    // write garbage bytes — valid UTF-8 but not valid JSON
    writeFileSync(join(root, 'state', 'budget.json'), 'not-valid-json!!!');
    const result = readDrainState(root);
    expect(result.kind).toBe('corrupt');
    // MUST NOT be treated as missing
    expect(result.kind).not.toBe('missing');
  });
});

describe('atomicWriteFileSync', () => {
  it('writes content to destination', () => {
    const root = newRoot();
    const dest = join(root, 'atomic-test.json');
    atomicWriteFileSync(dest, '{"ok":true}');
    expect(existsSync(dest)).toBe(true);
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toEqual({ ok: true });
  });

  it('leaves no .tmp-* files after write', () => {
    const root = newRoot();
    const dest = join(root, 'atomic-test2.json');
    atomicWriteFileSync(dest, '"hello"');
    const files = readdirSync(root);
    const leftovers = files.filter(f => f.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);
  });
});

describe('writeDrainState atomicity', () => {
  it('round-trips full DrainState with no leftover tmp files', () => {
    const root = newRoot();
    const state: DrainState = {
      drain_window_id: 'dw-roundtrip',
      drain_window_started_at: '2026-06-01T00:00:00.000Z',
      next_eligible_at: '2026-06-02T00:00:00.000Z',
      week_exhausted: true,
      last_observed_weekly_reset: '2026-05-30T00:00:00.000Z',
      completed_task_ids: ['task-1', 'task-2'],
      unproductive_reentries: 3,
      schema: 1,
    };
    writeDrainState(root, state);

    // no leftover tmp files in state dir
    const stateDir = join(root, 'state');
    const files = readdirSync(stateDir);
    const leftovers = files.filter(f => f.includes('.tmp-'));
    expect(leftovers).toHaveLength(0);

    // round-trips correctly
    const result = readDrainState(root);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.state).toEqual(state);
    }
  });
});

describe('STALE_LOCK_MS constant', () => {
  it('is 20 minutes in ms', () => {
    expect(STALE_LOCK_MS).toBe(20 * 60_000);
  });
});

describe('stale-lock-by-age reclaim', () => {
  it('reclaims a lock held >20min even if the PID is alive', () => {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    // started_at is 21 minutes ago; use process.pid so the process IS alive
    const staleStartedAt = new Date(Date.now() - 21 * 60_000).toISOString();
    writeFileSync(
      join(root, 'state', 'RUN.lock'),
      JSON.stringify({ pid: process.pid, run_id: 'old-run', started_at: staleStartedAt }),
    );
    const lock = acquireLock(root, 'new-run');
    expect(lock.acquired).toBe(true);
    expect(lock.recovered).toBe(true);
  });

  it('does NOT reclaim a lock held <20min with a live PID', () => {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    // started_at is 5 minutes ago; process.pid is alive
    const recentStartedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(root, 'state', 'RUN.lock'),
      JSON.stringify({ pid: process.pid, run_id: 'live-run', started_at: recentStartedAt }),
    );
    const lock = acquireLock(root, 'new-run');
    expect(lock.acquired).toBe(false);
    if (!lock.acquired) {
      expect(lock.reason).toBe('busy');
      expect(lock.holder.run_id).toBe('live-run');
    }
  });
});
