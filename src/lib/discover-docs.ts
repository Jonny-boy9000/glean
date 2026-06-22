import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Candidate, EvidenceDoc } from './types.js';
import { evidenceHash } from './dedup.js';

// v0.9 discover-docs: mine a project's OWN planning docs (roadmaps, TODO lists,
// handoff notes) as first-class candidates. Candidate supply is glean's #1
// verified bottleneck (2026-06-12 capacity-governor strategy, root cause #1);
// roadmaps are denser candidate sources than code TODO comments, and a
// docs-only project has no code TODOs at all. Read-only, like every pass.

// Caps: never scan more than 20 files, skip any file over 200KB, and emit at
// most 10 candidates per project per run.
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_CANDIDATES = 10;

// Item text bounds AFTER markdown cleanup. Shorter is noise ("- soon"),
// longer is prose pasted into a bullet, not an actionable item.
const MIN_ITEM_CHARS = 8;
const MAX_ITEM_CHARS = 200;

// Headings whose list items are actionable ("Up next", "TODO", "Backlog",
// "Planned", "Open questions", "In progress"...). Unchecked `- [ ]` task items
// count anywhere, regardless of heading.
const ACTION_HEADING_RE = /next|todo|backlog|planned|open|in progress/i;

// Root *.md files (beyond the well-known names) are scanned only when their
// FIRST heading reads like a planning doc.
const PLANNING_TITLE_RE = /roadmap|plan|backlog|next/i;

const HEADING_RE = /^#{1,6}\s+(.*)$/;
// A markdown list item: bullet or ordered, with optional task checkbox.
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;

// File priority tiers: ROADMAP > TODO > handoff > others. Document order
// within a file; definition order within a tier (root before docs/).
type DocFile = { rel: string; abs: string; tier: number };

export function collectDocFiles(projectPath: string): DocFile[] {
  const out: DocFile[] = [];
  const seen = new Set<string>();
  const push = (rel: string, tier: number): void => {
    const key = rel.toLowerCase();
    if (seen.has(key)) return;
    const abs = join(projectPath, rel);
    let size: number;
    try { size = statSync(abs).size; } catch { return; }
    if (size > MAX_FILE_BYTES) return;
    seen.add(key);
    out.push({ rel, abs, tier });
  };

  let rootEntries: string[] = [];
  try { rootEntries = readdirSync(projectPath); } catch { return []; }
  const rootMd = rootEntries.filter((n) => n.toLowerCase().endsWith('.md'));
  const findRoot = (name: string): string | undefined =>
    rootMd.find((n) => n.toLowerCase() === name);

  // Tier 0: roadmaps (root, then docs/).
  const roadmap = findRoot('roadmap.md');
  if (roadmap) push(roadmap, 0);
  if (existsSync(join(projectPath, 'docs', 'ROADMAP.md'))) push('docs/ROADMAP.md', 0);

  // Tier 1: TODO.md.
  const todo = findRoot('todo.md');
  if (todo) push(todo, 1);

  // Tier 2: docs/handoff/*.md (alphabetical).
  try {
    const handoffDir = join(projectPath, 'docs', 'handoff');
    for (const n of readdirSync(handoffDir).filter((f) => f.toLowerCase().endsWith('.md')).sort()) {
      push(`docs/handoff/${n}`, 2);
    }
  } catch { /* no handoff dir */ }

  // Tier 3: BACKLOG.md, PLAN.md, plus any other root *.md whose FIRST heading
  // reads like a planning doc (roadmap/plan/backlog/next).
  for (const name of ['backlog.md', 'plan.md']) {
    const f = findRoot(name);
    if (f) push(f, 3);
  }
  for (const n of [...rootMd].sort()) {
    if (seen.has(n.toLowerCase())) continue;
    const abs = join(projectPath, n);
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      const heading = firstHeading(readFileSync(abs, 'utf8'));
      if (heading !== null && PLANNING_TITLE_RE.test(heading)) push(n, 3);
    } catch { /* unreadable — skip */ }
  }

  out.sort((a, b) => a.tier - b.tier); // stable: definition order within a tier
  return out.slice(0, MAX_FILES);
}

function firstHeading(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(HEADING_RE);
    if (m) return m[1].trim();
  }
  return null;
}

export type DocItem = { heading: string; item_text: string; line: number };

// Extract actionable items from one planning doc:
//  - plain list items under an actionable heading (ACTION_HEADING_RE), and
//  - unchecked `- [ ]` task items anywhere (checked `- [x]` always excluded).
export function extractDocItems(content: string): DocItem[] {
  const items: DocItem[] = [];
  let heading = '';
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADING_RE);
    if (h) { heading = h[1].trim(); continue; }
    const m = lines[i].match(LIST_ITEM_RE);
    if (!m) continue;
    const [, checkbox, rest] = m;
    if (checkbox !== undefined && checkbox !== ' ') continue; // checked → done
    const isUncheckedTask = checkbox === ' ';
    if (!isUncheckedTask && !ACTION_HEADING_RE.test(heading)) continue;
    const text = cleanItemText(rest);
    if (text.length < MIN_ITEM_CHARS || text.length > MAX_ITEM_CHARS) continue;
    items.push({ heading, item_text: text, line: i + 1 });
  }
  return items;
}

// Strip markdown noise so item text is stable, readable prose:
// links → their label, then emphasis/code markers, then whitespace collapse.
function cleanItemText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function discoverDocs(projectPath: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seenHashes = new Set<string>();
  for (const file of collectDocFiles(projectPath)) {
    let content: string;
    try { content = readFileSync(file.abs, 'utf8'); } catch { continue; }
    for (const item of extractDocItems(content)) {
      const ev: EvidenceDoc = { kind: 'doc', file: file.rel, heading: item.heading, item_text: item.item_text, line: item.line };
      const cand: Candidate = {
        id: randomUUID(),
        evidence_hash: '',
        type: 'research-dossier',
        project_path: projectPath,
        evidence: ev,
        est_value: 0,
        est_tokens: 5000,
        status: 'pending',
      };
      cand.evidence_hash = evidenceHash(cand);
      if (seenHashes.has(cand.evidence_hash)) continue; // same item repeated
      seenHashes.add(cand.evidence_hash);
      out.push(cand);
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}
