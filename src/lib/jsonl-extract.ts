import { readFileSync } from 'node:fs';

export function extractLastAssistantText(jsonlPath: string): string {
  try {
    const content = readFileSync(jsonlPath, 'utf8').split(/\r?\n/).reverse();
    for (const ln of content) {
      try {
        const o = JSON.parse(ln);
        const text = o?.message?.content?.[0]?.text ?? o?.delta?.text;
        if (typeof text === 'string' && text.length > 0) return text;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* file missing */
  }
  return '_(no output produced)_';
}
