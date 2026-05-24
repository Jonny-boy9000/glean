import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Candidate, EvidenceDep } from './types.js';
import { evidenceHash } from './dedup.js';

type Manifest = EvidenceDep['manifest'];

const MANIFESTS: Manifest[] = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml'];

export async function discoverDeps(projectPath: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const m of MANIFESTS) {
    if (!existsSync(join(projectPath, m))) continue;
    let diff: string;
    try {
      diff = execFileSync(
        'git',
        ['-C', projectPath, 'log', '-p', '--since=14.days', '--diff-filter=M', '--', m],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );
    } catch {
      continue;
    }
    if (!diff) continue;
    const packages = parseAddedPackages(m, diff);
    for (const pkg of packages) {
      const ev: EvidenceDep = { kind: 'dep', manifest: m, package: pkg, added_at: new Date().toISOString() };
      const cand: Candidate = {
        id: uuid(),
        evidence_hash: '',
        type: 'fetch-docs',
        project_path: projectPath,
        evidence: ev,
        est_value: 0,
        est_tokens: 2000,
        status: 'pending',
      };
      cand.evidence_hash = evidenceHash(cand);
      out.push(cand);
    }
  }
  return out;
}

function parseAddedPackages(manifest: Manifest, diff: string): string[] {
  const added = new Set<string>();
  const removed = new Set<string>();
  const lines = diff.split(/\r?\n/);
  for (const ln of lines) {
    if (ln.startsWith('+++') || ln.startsWith('---')) continue;
    if (ln.startsWith('+')) {
      const body = ln.slice(1).trim();
      const pkg = extractPackageName(manifest, body);
      if (pkg) added.add(pkg);
    } else if (ln.startsWith('-')) {
      const body = ln.slice(1).trim();
      const pkg = extractPackageName(manifest, body);
      if (pkg) removed.add(pkg);
    }
  }
  // Only return packages that appear in added lines but not in removed lines
  // (packages that appear in both were modified, not newly introduced)
  return [...added].filter((p) => !removed.has(p));
}

function extractPackageName(manifest: Manifest, line: string): string | null {
  switch (manifest) {
    case 'package.json': {
      // Looks like: "zod": "^3.22.0", — quotes around the name
      const m = line.match(/^"([^"]+)"\s*:/);
      return m ? m[1] : null;
    }
    case 'requirements.txt': {
      const m = line.match(/^([A-Za-z0-9._-]+)/);
      return m ? m[1] : null;
    }
    case 'go.mod': {
      // Lines look like: github.com/foo/bar v1.2.3
      const m = line.match(/^(\S+)\s+v[\d.]/);
      return m ? m[1] : null;
    }
    case 'Cargo.toml': {
      // crate = "1.2.3"  OR  crate = { version = "1.2.3" }
      const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
      return m ? m[1] : null;
    }
    case 'pyproject.toml': {
      const m = line.match(/^([A-Za-z0-9._-]+)\s*=/);
      return m ? m[1] : null;
    }
  }
}
