import { createHash } from 'node:crypto';
import type { CandidateType } from './types.js';

export interface FingerprintInput {
  project_path: string;
  candidate_type: CandidateType;
  file_path: string | null;
  title: string;
}

export function fingerprintCandidate(input: FingerprintInput): string {
  const norm = input.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = [
    input.project_path,
    input.candidate_type,
    input.file_path ?? '',
    norm,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
