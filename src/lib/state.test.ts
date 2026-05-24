import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  releaseLock,
  isStopRequested,
  writeStop,
  clearStop,
  ensureTemplatesDir,
  writeSummary,
} from './state.js';

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
