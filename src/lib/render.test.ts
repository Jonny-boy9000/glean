import { describe, it, expect } from 'vitest';
import { render } from './render.js';

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
