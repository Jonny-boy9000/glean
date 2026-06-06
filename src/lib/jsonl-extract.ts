import { readFileSync } from 'node:fs';

const SENTINEL = '_(no output produced)_';

// Capture the dossier from a research-dossier spawn's stream-json log.
//
// This is the PRIMARY capture path for research-dossier (ADR-0002): the spawned
// session is read-only and no longer writes OUT.md itself, so glean reconstructs
// the dossier from the final assistant message. It must therefore NOT truncate.
//
// Behavior: scan from the end for the last full `type:"assistant"` message and
// concatenate ALL of its `content[].text` blocks, in order (thinking/tool_use
// blocks skipped). If that message has no text, or no assistant message exists,
// or the file is missing/empty, fall back to the legacy reverse-scan (single
// `content[0].text` / `delta.text`), then to the sentinel.
export function extractLastAssistantText(jsonlPath: string): string {
  let lines: string[];
  try {
    lines = readFileSync(jsonlPath, 'utf8').split(/\r?\n/);
  } catch {
    return SENTINEL; // file missing
  }

  // Primary: last full assistant message, all text blocks concatenated in order.
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: unknown;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue; // skip malformed / blank line
    }
    const rec = o as { type?: unknown; message?: { content?: unknown } };
    if (rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text.length > 0) return text;
    // Assistant message with no text (e.g. tool_use-only) — stop; nothing to emit.
    return SENTINEL;
  }

  // Fallback: legacy reverse-scan for a stray text/delta fragment.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]) as { message?: { content?: Array<{ text?: string }> }; delta?: { text?: string } };
      const text = o?.message?.content?.[0]?.text ?? o?.delta?.text;
      if (typeof text === 'string' && text.length > 0) return text;
    } catch {
      /* skip */
    }
  }

  return SENTINEL;
}
