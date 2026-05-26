import { existsSync } from 'node:fs';
import type { Memory } from './memory.js';

export const SWEEP_AGE_MS = 7 * 86_400_000;

export interface SweepResult {
  checked: number;
  kept: number;
  discarded: number;
}

export function runDossierExistenceSweep(memory: Memory, now: number, ageMs: number): SweepResult {
  const beforeMs = now - ageMs;
  const candidates = memory.findCandidatesNeedingSweep(beforeMs);
  let kept = 0;
  let discarded = 0;

  for (const c of candidates) {
    let exists = false;
    try {
      exists = existsSync(c.dossier_path);
    } catch {
      exists = false;
    }
    try {
      memory.markDossierExists(c.id, exists);
    } catch (e) {
      process.stderr.write(`[memory] warning: markDossierExists failed for id=${c.id}: ${(e as Error).message}\n`);
      continue;
    }
    if (exists) kept++;
    else discarded++;
  }

  return { checked: candidates.length, kept, discarded };
}
