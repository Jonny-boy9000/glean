import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDocs, collectDocFiles } from './discover-docs.js';
import type { EvidenceDoc } from './types.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'glean-docs-'));
}

function ev(c: { evidence: unknown }): EvidenceDoc {
  return c.evidence as EvidenceDoc;
}

describe('discoverDocs: extraction', () => {
  it('extracts list items under an actionable heading in ROADMAP.md', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Up next',
      '- Implement the capacity governor pacing math',
      '- Wire the nightly schedule preset behind the pace gate',
      '',
      '## Done',
      '- Shipped the dashboard already',
    ].join('\n'));
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(2);
    expect(cands[0].type).toBe('research-dossier');
    expect(ev(cands[0]).kind).toBe('doc');
    expect(ev(cands[0]).file).toBe('ROADMAP.md');
    expect(ev(cands[0]).heading).toBe('Up next');
    expect(ev(cands[0]).item_text).toBe('Implement the capacity governor pacing math');
    expect(ev(cands[0]).line).toBe(4);
    expect(ev(cands[1]).item_text).toBe('Wire the nightly schedule preset behind the pace gate');
  });

  it('includes unchecked task-list items anywhere; excludes checked ones', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'TODO.md'), [
      '# Notes',
      '',
      '## Shipping log',
      '- [x] Already done and released item',
      '- [ ] Still pending: write the migration script',
      '- [X] Also done, uppercase checkmark item',
    ].join('\n'));
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(1);
    expect(ev(cands[0]).item_text).toBe('Still pending: write the migration script');
  });

  it('skips items shorter than 8 or longer than 200 chars after cleanup', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'ROADMAP.md'), [
      '## Up next',
      '- ok', // too short
      `- ${'x'.repeat(201)}`, // too long
      '- A reasonable actionable item',
    ].join('\n'));
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(1);
    expect(ev(cands[0]).item_text).toBe('A reasonable actionable item');
  });

  it('cleans markdown links and emphasis from item text', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'ROADMAP.md'), [
      '## Up next',
      '- **Ship** the [governor design](./docs/design/governor.md) to `main` soon',
    ].join('\n'));
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(1);
    expect(ev(cands[0]).item_text).toBe('Ship the governor design to main soon');
  });

  it('ignores plain list items under non-actionable headings', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'ROADMAP.md'), [
      '## Released history',
      '- This already shipped a while ago',
    ].join('\n'));
    expect(await discoverDocs(p)).toEqual([]);
  });

  it('returns [] for an empty project', async () => {
    expect(await discoverDocs(tmpProject())).toEqual([]);
  });
});

describe('discoverDocs: file selection', () => {
  it('scans docs/ROADMAP.md and docs/handoff/*.md', async () => {
    const p = tmpProject();
    mkdirSync(join(p, 'docs', 'handoff'), { recursive: true });
    writeFileSync(join(p, 'docs', 'ROADMAP.md'), '## Up next\n- Item from the docs roadmap file\n');
    writeFileSync(join(p, 'docs', 'handoff', 'post-v1-handoff.md'), '# Handoff\n- [ ] Item from the handoff document\n');
    const cands = await discoverDocs(p);
    const files = cands.map((c) => ev(c).file);
    expect(files).toContain('docs/ROADMAP.md');
    expect(files).toContain('docs/handoff/post-v1-handoff.md');
  });

  it('includes a root *.md whose first heading mentions plan/roadmap/backlog/next', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'NOTES.md'), '# Q3 plan\n\n## Up next\n- Item from the planning notes file\n');
    writeFileSync(join(p, 'README.md'), '# My project\n\n- [ ] A checkbox inside a non-planning file\n');
    const cands = await discoverDocs(p);
    const files = cands.map((c) => ev(c).file);
    expect(files).toContain('NOTES.md');
    expect(files).not.toContain('README.md');
  });

  it('skips files larger than 200KB', async () => {
    const p = tmpProject();
    const filler = `## Filler\n${'lorem ipsum filler text\n'.repeat(9000)}`; // > 200KB
    writeFileSync(join(p, 'ROADMAP.md'), `${filler}\n## Up next\n- Item inside the oversized roadmap\n`);
    writeFileSync(join(p, 'TODO.md'), '- [ ] Item inside the small todo file\n');
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(1);
    expect(ev(cands[0]).file).toBe('TODO.md');
  });

  it('caps the scan at 20 files', async () => {
    const p = tmpProject();
    mkdirSync(join(p, 'docs', 'handoff'), { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(p, 'docs', 'handoff', `h${String(i).padStart(2, '0')}.md`), '- [ ] An item that pads out the corpus\n');
    }
    expect(collectDocFiles(p).length).toBeLessThanOrEqual(20);
  });
});

describe('discoverDocs: ranking and caps', () => {
  it('caps at 10 candidates, ranked ROADMAP > TODO > handoff > others, document order within a file', async () => {
    const p = tmpProject();
    mkdirSync(join(p, 'docs', 'handoff'), { recursive: true });
    const items = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `- [ ] ${prefix} actionable item number ${i + 1}`).join('\n');
    writeFileSync(join(p, 'BACKLOG.md'), items('Backlog', 3));
    writeFileSync(join(p, 'docs', 'handoff', 'h.md'), items('Handoff', 3));
    writeFileSync(join(p, 'TODO.md'), items('Todo', 3));
    writeFileSync(join(p, 'ROADMAP.md'), items('Roadmap', 3));
    const cands = await discoverDocs(p);
    expect(cands.length).toBe(10);
    const texts = cands.map((c) => ev(c).item_text);
    expect(texts.slice(0, 3)).toEqual([1, 2, 3].map((i) => `Roadmap actionable item number ${i}`));
    expect(texts.slice(3, 6)).toEqual([1, 2, 3].map((i) => `Todo actionable item number ${i}`));
    expect(texts.slice(6, 9)).toEqual([1, 2, 3].map((i) => `Handoff actionable item number ${i}`));
    expect(texts[9]).toBe('Backlog actionable item number 1');
  });

  it('produces stable evidence hashes across reruns', async () => {
    const p = tmpProject();
    writeFileSync(join(p, 'ROADMAP.md'), '## Up next\n- A perfectly stable actionable item\n');
    const a = await discoverDocs(p);
    const b = await discoverDocs(p);
    expect(a.length).toBe(1);
    expect(a[0].evidence_hash).toBe(b[0].evidence_hash);
    expect(a[0].id).not.toBe(b[0].id); // ids are per-run; only the hash is stable
  });
});
