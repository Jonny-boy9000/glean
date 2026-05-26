import type { TodayReport } from './today.js';

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
