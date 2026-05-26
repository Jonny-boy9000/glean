import type { TodayReport, IndexEntry } from './today.js';

type Painter = {
  bold:  (s: string) => string;
  dim:   (s: string) => string;
  green: (s: string) => string;
  red:   (s: string) => string;
};

const ANSI: Painter = {
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
};

const PLAIN: Painter = {
  bold:  (s) => s,
  dim:   (s) => s,
  green: (s) => s,
  red:   (s) => s,
};

const PROJECT_LINE_WIDTH = 60;
const STATUS_COLUMN_WIDTH = 12;

export function renderToday(report: TodayReport, useColor: boolean): string {
  if (report.projects.length === 0) {
    return `No glean dossiers for ${report.date}.`;
  }
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];
  lines.push(c.bold(`GLEAN today — ${report.date}`));
  lines.push('');

  for (let pi = 0; pi < report.projects.length; pi++) {
    const p = report.projects[pi];
    const taskCount = `${p.entries.length} tasks`;
    const left = `▸ ${p.project_slug}`;
    const padding = Math.max(2, PROJECT_LINE_WIDTH - left.length - taskCount.length);
    lines.push(c.bold(`${left}${' '.repeat(padding)}${taskCount}`));

    for (const e of p.entries) {
      const isOk = e.status === 'ok' || e.status === 'ok-fallback';
      const icon = isOk ? c.green('✓') : c.red('✗');
      const status = isOk ? c.green(e.status.padEnd(STATUS_COLUMN_WIDTH)) : c.red(e.status.padEnd(STATUS_COLUMN_WIDTH));
      lines.push(`  ${icon} ${status} ${e.title}`);
      const outputDisplay = e.output ? normalizePath(e.output) : '(no output)';
      lines.push(`                 ${c.dim(outputDisplay)}`);
      const enrLine = formatEnrichmentLine(e, c);                         // NEW
      if (enrLine !== null) lines.push(enrLine);                          // NEW
    }

    if (pi < report.projects.length - 1) lines.push('');
  }

  return lines.join('\n');
}

function normalizePath(p: string): string {
  const m = p.match(/^(.*?[/\\])glean[/\\]dossiers[/\\](.*)$/);
  if (m) {
    return `~/glean/dossiers/${m[2].replace(/\\/g, '/')}`;
  }
  return p.replace(/\\/g, '/');
}

function formatEnrichmentLine(entry: IndexEntry, c: Painter): string | null {
  // Failed/no-output entries get no enrichment line.
  if (!entry.output) return null;

  // Each part is wrapped in its own painter call so the parts can be joined
  // plainly without ANSI nesting (\x1b[0m resets ALL attributes, not just
  // the inner color).
  const parts: string[] = [];

  if (typeof entry.duration_ms === 'number') {
    parts.push(c.dim(formatDuration(entry.duration_ms)));
  }
  if (typeof entry.bytes_written === 'number' && entry.bytes_written > 0) {
    parts.push(c.dim(formatBytes(entry.bytes_written)));
  }
  if (typeof entry.rate_limit_hits === 'number' && entry.rate_limit_hits > 0) {
    const noun = entry.rate_limit_hits === 1 ? 'rate-limit hit' : 'rate-limit hits';
    parts.push(c.dim(`${entry.rate_limit_hits} ${noun}`));
  }
  if (entry.user_rating != null) {
    parts.push((entry.user_rating === 'kept' || entry.user_rating === 'actioned')
      ? c.green(`rated: ${entry.user_rating}`)
      : c.red(`rated: ${entry.user_rating}`));
  }

  if (parts.length === 0) return null;
  const sep = c.dim(' · ');
  // Indent matches the output-path line: 17 spaces.
  return `                 ${parts.join(sep)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}
