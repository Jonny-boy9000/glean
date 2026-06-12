import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLastAssistantText } from './jsonl-extract.js';

// Build a JSONL file from an array of stream-json line objects.
function writeJsonl(dir: string, lines: unknown[]): string {
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const SENTINEL = '_(no output produced)_';

describe('extractLastAssistantText', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glean-jsonl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('concatenates ALL text blocks of the final assistant message in order', () => {
    const p = writeJsonl(dir, [
      { type: 'message_start', message: { id: 'm1', role: 'assistant' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: '# Dossier\n' },
        { type: 'text', text: '## Findings\nreal content here' },
      ] } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    expect(extractLastAssistantText(p)).toBe('# Dossier\n## Findings\nreal content here');
  });

  it('skips thinking blocks and returns only the text', () => {
    const p = writeJsonl(dir, [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'let me reason about this privately' },
        { type: 'text', text: 'visible dossier body' },
      ] } },
    ]);
    expect(extractLastAssistantText(p)).toBe('visible dossier body');
  });

  it('returns the sentinel when the final assistant message has only tool_use (no text)', () => {
    const p = writeJsonl(dir, [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ] } },
    ]);
    expect(extractLastAssistantText(p)).toBe(SENTINEL);
  });

  it('returns the sentinel when the file is missing', () => {
    expect(extractLastAssistantText(join(dir, 'does-not-exist.jsonl'))).toBe(SENTINEL);
  });

  it('returns the sentinel when the file is empty', () => {
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    expect(extractLastAssistantText(p)).toBe(SENTINEL);
  });

  it('uses the LAST assistant message, not an earlier one', () => {
    const p = writeJsonl(dir, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier turn' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'FINAL dossier' }] } },
    ]);
    expect(extractLastAssistantText(p)).toBe('FINAL dossier');
  });

  it('is defensive against malformed lines interleaved with the final message', () => {
    const p = join(dir, 'noisy.jsonl');
    writeFileSync(p, [
      'not json at all',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'survived' }] } }),
      '{ broken',
    ].join('\n') + '\n');
    expect(extractLastAssistantText(p)).toBe('survived');
  });
});
