import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { GleanConfig } from './types.js';

const Schema = z.object({
  claude_bin: z.string().optional(),
  projects: z.record(z.string(), z.object({
    base_branch: z.string().optional(),
    test_command: z.string().optional(),
  })).optional(),
  drain_trigger: z.object({
    day: z.string().optional(),
    time: z.string().optional(),
    repeat_minutes: z.number().optional(),
    duration_hours: z.number().optional(),
  }).optional(),
});

export function loadConfig(path: string): GleanConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`config: cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config: invalid JSON in ${path}: ${(e as Error).message}`);
  }
  const result = Schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`config: schema violation at ${issue.path.join('.')}: ${issue.message}`);
  }
  return result.data;
}

export function defaultConfigPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return `${home}\\glean\\config.json`;
}
