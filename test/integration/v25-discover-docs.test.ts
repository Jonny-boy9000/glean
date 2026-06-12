import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v0.9 discover-docs: a docs-only project (no git, no code TODOs, no PRs) whose
// planning docs describe unfinished work must yield candidates. This is the
// Terra Firma case from 2026-06-12: 46 markdown files of unfinished work →
// `no-candidates`, because discovery only read code TODOs / JSONL / PRs.
function tmpDocsProject(): string {
  const p = mkdtempSync(join(tmpdir(), 'glean-v25-'));
  writeFileSync(join(p, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '## Up next',
    '- Draft the irrigation layout for the north field',
    '- Price out the perimeter fencing options',
  ].join('\n'));
  mkdirSync(join(p, 'docs', 'handoff'), { recursive: true });
  writeFileSync(join(p, 'docs', 'handoff', 'session-3.md'), '# Handoff\n- [ ] Follow up with the surveyor about the boundary\n');
  return p;
}

describe('verification 25: discover-docs mines planning docs as candidates', () => {
  it('dry-run on a docs-only project finds doc candidates and logs the docs pass', () => {
    const project = tmpDocsProject();
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', project, '--budget', '60m', '--dry-run'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    const stateDir = join(home, 'glean', 'state');
    const runs = readdirSync(stateDir).filter((f) => f !== 'RUN.lock');
    expect(runs.length).toBe(1);
    const cands = JSON.parse(readFileSync(join(stateDir, runs[0], 'candidates.json'), 'utf8'));
    const docCands = cands.ranked.filter((c: { evidence: { kind: string } }) => c.evidence.kind === 'doc');
    expect(docCands.length).toBe(3);
    const texts = docCands.map((c: { evidence: { item_text: string } }) => c.evidence.item_text);
    expect(texts).toContain('Draft the irrigation layout for the north field');
    expect(texts).toContain('Follow up with the surveyor about the boundary');

    // discover.done gains a docs count alongside jsonl/git/deps.
    const log = readFileSync(join(home, 'glean', 'logs', runs[0], 'orchestrator.log'), 'utf8');
    const discoverDone = log.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      .find((e: { evt: string }) => e.evt === 'discover.done');
    expect(discoverDone).toBeDefined();
    expect(discoverDone.docs).toBe(3);
  });
});
