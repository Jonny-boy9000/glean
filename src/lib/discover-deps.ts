import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import type { Candidate, EvidenceDep } from './types.js';
import { evidenceHash } from './dedup.js';

type Manifest = EvidenceDep['manifest'];

const MANIFESTS: Manifest[] = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml'];

export async function discoverDeps(projectPath: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const m of MANIFESTS) {
    if (!existsSync(join(projectPath, m))) continue;

    const commits = recentCommits(projectPath, m, 14);
    if (commits.length === 0) continue;

    const oldestInWindow = commits[commits.length - 1];
    // If there are multiple commits in the window, use the oldest commit's state as the
    // baseline (packages added AFTER that point are "new"). If there's only one commit,
    // use its parent so packages introduced by that single commit are also captured.
    const preContent = commits.length > 1
      ? gitShowAt(projectPath, oldestInWindow, m)
      : gitShowAtParent(projectPath, oldestInWindow, m);
    const currentContent = readFileSync(join(projectPath, m), 'utf8');

    const preDeps = parseManifestDeps(m, preContent);
    const currentDeps = parseManifestDeps(m, currentContent);

    for (const pkg of currentDeps) {
      if (preDeps.has(pkg)) continue;
      const ev: EvidenceDep = { kind: 'dep', manifest: m, package: pkg, added_at: new Date().toISOString() };
      const cand: Candidate = {
        id: randomUUID(),
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

function recentCommits(projectPath: string, manifest: string, days: number): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['-C', projectPath, 'log', `--since=${days}.days`, '--format=%H', '--', manifest],
      { encoding: 'utf8' },
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function gitShowAt(projectPath: string, commit: string, manifest: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', projectPath, 'show', `${commit}:${manifest}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

function gitShowAtParent(projectPath: string, commit: string, manifest: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', projectPath, 'show', `${commit}^:${manifest}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

export function parseManifestDeps(manifest: Manifest, content: string): Set<string> {
  if (!content) return new Set();
  try {
    switch (manifest) {
      case 'package.json':
        return parsePackageJson(content);
      case 'requirements.txt':
        return parseRequirementsTxt(content);
      case 'go.mod':
        return parseGoMod(content);
      case 'Cargo.toml':
        return parseCargoToml(content);
      case 'pyproject.toml':
        return parsePyproject(content);
    }
  } catch {
    return new Set();
  }
}

function parsePackageJson(content: string): Set<string> {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = pkg[key];
    if (section && typeof section === 'object') {
      for (const name of Object.keys(section as Record<string, unknown>)) out.add(name);
    }
  }
  return out;
}

function parseRequirementsTxt(content: string): Set<string> {
  const out = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)/);
    if (m) out.add(m[1]);
  }
  return out;
}

function parseGoMod(content: string): Set<string> {
  const out = new Set<string>();
  let inRequireBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('require (')) { inRequireBlock = true; continue; }
    if (inRequireBlock && line === ')') { inRequireBlock = false; continue; }
    if (inRequireBlock) {
      const m = line.match(/^(\S+)\s+v[\d.]/);
      if (m) out.add(m[1]);
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+v[\d.]/);
    if (single) out.add(single[1]);
  }
  return out;
}

function parseCargoToml(content: string): Set<string> {
  const t = parseToml(content) as Record<string, unknown>;
  const out = new Set<string>();
  const sections = ['dependencies', 'dev-dependencies', 'build-dependencies'];
  for (const s of sections) {
    const tbl = t[s];
    if (tbl && typeof tbl === 'object') {
      for (const name of Object.keys(tbl as Record<string, unknown>)) out.add(name);
    }
  }
  const target = t.target;
  if (target && typeof target === 'object') {
    for (const triple of Object.values(target as Record<string, unknown>)) {
      if (triple && typeof triple === 'object') {
        for (const s of sections) {
          const tbl = (triple as Record<string, unknown>)[s];
          if (tbl && typeof tbl === 'object') {
            for (const name of Object.keys(tbl as Record<string, unknown>)) out.add(name);
          }
        }
      }
    }
  }
  return out;
}

function parsePyproject(content: string): Set<string> {
  const t = parseToml(content) as Record<string, unknown>;
  const out = new Set<string>();

  const project = t.project as Record<string, unknown> | undefined;
  if (project) {
    const deps = project.dependencies;
    if (Array.isArray(deps)) {
      for (const req of deps) {
        if (typeof req === 'string') {
          const name = extractRequirementName(req);
          if (name) out.add(name);
        }
      }
    }
    const optDeps = project['optional-dependencies'];
    if (optDeps && typeof optDeps === 'object') {
      for (const group of Object.values(optDeps as Record<string, unknown>)) {
        if (Array.isArray(group)) {
          for (const req of group) {
            if (typeof req === 'string') {
              const name = extractRequirementName(req);
              if (name) out.add(name);
            }
          }
        }
      }
    }
  }

  const tool = t.tool as Record<string, unknown> | undefined;
  const poetry = tool?.poetry as Record<string, unknown> | undefined;
  if (poetry) {
    for (const s of ['dependencies', 'dev-dependencies']) {
      const tbl = poetry[s];
      if (tbl && typeof tbl === 'object') {
        for (const name of Object.keys(tbl as Record<string, unknown>)) {
          if (name !== 'python') out.add(name);
        }
      }
    }
  }

  return out;
}

function extractRequirementName(req: string): string | null {
  const m = req.match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}
