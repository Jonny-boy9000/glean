import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './render.js';
import { titleFor } from './candidate-meta.js';
import type { Candidate } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('render', () => {
  it('substitutes simple variables', () => {
    expect(render('Hello {{name}}', { name: 'world' })).toBe('Hello world');
  });

  it('handles nested paths', () => {
    expect(render('{{user.first}} {{user.last}}', { user: { first: 'A', last: 'B' } }))
      .toBe('A B');
  });

  it('renders #if branch on equality match', () => {
    const tpl = '{{#if x == "a"}}A{{else if x == "b"}}B{{/if}}';
    expect(render(tpl, { x: 'a' })).toBe('A');
    expect(render(tpl, { x: 'b' })).toBe('B');
    expect(render(tpl, { x: 'c' })).toBe('');
  });

  it('applies join_lines filter to array', () => {
    expect(render('{{xs | join_lines}}', { xs: ['a', 'b', 'c'] }))
      .toBe('a\nb\nc');
  });

  it('applies bullet_list filter to array of objects', () => {
    expect(render('{{xs | bullet_list}}', { xs: [{ body: 'one' }, { body: 'two' }] }))
      .toBe('- one\n- two');
  });

  it('applies slug filter', () => {
    expect(render('{{x | slug}}', { x: '@types/node' })).toBe('types-node');
  });

  it('leaves unknown variables as literals and does not throw', () => {
    const warnings: string[] = [];
    expect(render('Hi {{missing}}', {}, (w) => warnings.push(w))).toBe('Hi {{missing}}');
    expect(warnings).toContain('unknown variable: missing');
  });
});

// v0.9 discover-docs: the bundled research-dossier template must render a sane
// prompt for doc evidence — same hydration shape the executor builds (candidate
// + title), mirroring how jsonl evidence renders. No leftover {{tags}}, no
// unknown-variable warnings, and the item/file/heading surface in the prompt.
describe('research-dossier template renders doc evidence', () => {
  it('produces a complete prompt with no warnings', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'research-dossier.md');
    const tpl = readFileSync(tplPath, 'utf8');
    const cand: Candidate & { title?: string } = {
      id: 'x', evidence_hash: 'h', type: 'research-dossier', project_path: 'C:\proj',
      evidence: { kind: 'doc', file: 'docs/ROADMAP.md', heading: 'Up next', item_text: 'Ship the capacity governor', line: 12 },
      est_value: 28, est_tokens: 5000, status: 'pending',
    };
    cand.title = titleFor(cand);
    const warnings: string[] = [];
    const out = render(tpl, cand, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
    expect(out).not.toMatch(/\{\{/);
    expect(out).toContain('Ship the capacity governor');
    expect(out).toContain('docs/ROADMAP.md');
    expect(out).toContain('Up next');
    expect(out).toContain('line 12');
  });
});
