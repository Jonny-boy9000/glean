import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { extractLastAssistantText } from './jsonl-extract.js';

export type RepairResult = {
  scanned: number;
  repaired: { run_id: string; task_id: string; path: string; bytes: number }[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
};

export function repairRecent(gleanRoot: string, days = 7): RepairResult {
  const out: RepairResult = { scanned: 0, repaired: [], skipped: [], failed: [] };
  const dossierRoot = join(gleanRoot, 'dossiers');
  if (!existsSync(dossierRoot)) return out;

  const cutoff = Date.now() - days * 86400_000;

  for (const projDir of readdirSync(dossierRoot)) {
    const projPath = join(dossierRoot, projDir);
    if (!statSync(projPath).isDirectory()) continue;
    for (const dateDir of readdirSync(projPath)) {
      const m = dateDir.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) continue;
      const dateMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (dateMs < cutoff) continue;

      const datePath = join(projPath, dateDir);
      const indexPath = join(datePath, 'INDEX.md');
      if (!existsSync(indexPath)) continue;

      const indexContent = readFileSync(indexPath, 'utf8');
      const fmMatch = indexContent.match(/^---\n([\s\S]+?)\n---/);
      if (!fmMatch) continue;

      let fm: { run_id?: string; project_path?: string; generated_at?: string; entries?: { task_id: string; output: string; status: string; evidence_hash?: string; title?: string; type?: string }[] };
      try {
        fm = parseYaml(fmMatch[1]) as typeof fm;
      } catch {
        continue;
      }
      if (!fm.entries || !fm.run_id) continue;

      let indexDirty = false;
      for (const entry of fm.entries) {
        if (!entry.output) continue;
        const outPath = isAbsolute(entry.output) ? entry.output : join(datePath, entry.output);
        if (!existsSync(outPath)) {
          out.skipped.push({ path: outPath, reason: 'output-missing' });
          continue;
        }
        out.scanned++;
        if (statSync(outPath).size >= 100) continue;

        const jsonlPath = join(gleanRoot, 'logs', fm.run_id, `${entry.task_id}.jsonl`);
        if (!existsSync(jsonlPath)) {
          out.skipped.push({ path: outPath, reason: 'log-missing' });
          continue;
        }
        const text = extractLastAssistantText(jsonlPath);
        if (text.length < 100) {
          out.skipped.push({ path: outPath, reason: 'extraction-too-short' });
          continue;
        }
        try {
          writeFileSync(outPath, text);
          entry.status = 'ok-repaired';
          indexDirty = true;
          out.repaired.push({ run_id: fm.run_id, task_id: entry.task_id, path: outPath, bytes: text.length });
        } catch (e) {
          out.failed.push({ path: outPath, reason: (e as Error).message });
        }
      }

      if (indexDirty) {
        const body = indexContent.slice(fmMatch[0].length);
        const newFm = yamlStringify(fm);
        writeFileSync(indexPath, `---\n${newFm}---${body}`);
      }
    }
  }
  return out;
}
