import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairRecent } from './repair.js';

function setup(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), 'glean-repair-')) };
}

function writeIndex(root: string, proj: string, date: string, entries: { task_id: string; output: string; status: string; evidence_hash: string }[]): void {
  const dir = join(root, 'dossiers', proj, date);
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    'run_id: test-run',
    `project_path: C:\\\\${proj}`,
    `generated_at: ${new Date().toISOString()}`,
    'entries:',
    ...entries.map(e =>
      `  - { task_id: ${e.task_id}, evidence_hash: ${e.evidence_hash}, type: research-dossier, title: t, output: ${e.output}, status: ${e.status} }`),
    '---',
    '# index',
  ].join('\n');
  writeFileSync(join(dir, 'INDEX.md'), fm);
}

function writeJsonlLog(root: string, runId: string, taskId: string, text: string): void {
  const dir = join(root, 'logs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { content: [{ text }] } }) + '\n');
}

describe('repairRecent', () => {
  it('repairs a <100 byte OUT.md by extracting text from the matching jsonl log', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const taskId = 'task-x';
    const outDir = join(root, 'dossiers', 'proj', today, 'research-x');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), '_(no output produced)_');
    writeIndex(root, 'proj', today, [{ task_id: taskId, output: 'research-x/OUT.md', status: 'ok-fallback', evidence_hash: 'h1' }]);
    writeJsonlLog(root, 'test-run', taskId, 'A'.repeat(200));

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(1);
    expect(statSync(join(outDir, 'OUT.md')).size).toBeGreaterThan(99);
  });

  it('skips OUT.md >=100 bytes (already substantive)', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-y');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'B'.repeat(200));
    writeIndex(root, 'proj', today, [{ task_id: 'task-y', output: 'research-y/OUT.md', status: 'ok', evidence_hash: 'h2' }]);
    writeJsonlLog(root, 'test-run', 'task-y', 'C'.repeat(200));

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
  });

  it('skips when no matching jsonl log exists', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-z');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', today, [{ task_id: 'task-z', output: 'research-z/OUT.md', status: 'ok-fallback', evidence_hash: 'h3' }]);

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('skips when jsonl extraction yields <100 bytes', () => {
    const { root } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', today, 'research-w');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', today, [{ task_id: 'task-w', output: 'research-w/OUT.md', status: 'ok-fallback', evidence_hash: 'h4' }]);
    writeJsonlLog(root, 'test-run', 'task-w', 'short text');

    const result = repairRecent(root);
    expect(result.repaired.length).toBe(0);
  });

  it('respects the days window - ignores outputs older than days', () => {
    const { root } = setup();
    const oldDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const outDir = join(root, 'dossiers', 'proj', oldDate, 'research-old');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'OUT.md'), 'short');
    writeIndex(root, 'proj', oldDate, [{ task_id: 'task-old', output: 'research-old/OUT.md', status: 'ok-fallback', evidence_hash: 'h5' }]);
    writeJsonlLog(root, 'test-run', 'task-old', 'A'.repeat(200));

    const result = repairRecent(root, 7);
    expect(result.repaired.length).toBe(0);
    expect(result.scanned).toBe(0);
  });
});
