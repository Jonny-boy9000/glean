import type { TierRecommendation } from './pacing.js';
import type { CapacityInfo } from './dashboard-data.js';

/**
 * v0.9 capacity governor — `glean usage` terminal rendering. The same report
 * object is emitted verbatim by `glean usage --json` for the nightly gate.
 */
export type UsageReport = {
  generated_at: string;
  recommendation: TierRecommendation;
  capacity: CapacityInfo;
  blind_spot: string;
};

type Painter = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
};

const ANSI: Painter = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const PLAIN: Painter = {
  bold: (s) => s,
  dim: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  red: (s) => s,
};

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function tierPaint(tier: string, c: Painter): (s: string) => string {
  if (tier === 'skip') return c.red;
  if (tier === 'small') return c.yellow;
  return c.green;
}

export function renderUsage(report: UsageReport, useColor: boolean): string {
  const c = useColor ? ANSI : PLAIN;
  const rec = report.recommendation;
  const lines: string[] = [];

  const weekOf = rec.week.length > 0 ? rec.week[0].date : report.generated_at.slice(0, 10);
  lines.push(c.bold(`GLEAN usage — week of ${weekOf} (vs your 4-week baseline)`));
  lines.push('');

  // Per-day mini table: this week vs the per-weekday baseline median.
  const ACT = 'THIS WEEK';
  const BASE = 'BASELINE';
  const actSum = rec.week.reduce((s, r) => s + r.actual, 0);
  const baseSum = rec.week.reduce((s, r) => s + r.baseline, 0);
  const actW = Math.max(ACT.length, fmt(actSum).length, ...rec.week.map((r) => fmt(r.actual).length), 5);
  const baseW = Math.max(BASE.length, fmt(baseSum).length, ...rec.week.map((r) => fmt(r.baseline).length), 5);
  const LABEL_W = 18; // 'total (weighted)' is 16 chars — keep a 2-space gutter
  lines.push(`  ${'DAY'.padEnd(LABEL_W)}${ACT.padStart(actW)}  ${BASE.padStart(baseW)}`);
  for (const r of rec.week) {
    lines.push(`  ${`${r.weekday} ${r.date}`.padEnd(LABEL_W)}${fmt(r.actual).padStart(actW)}  ${fmt(r.baseline).padStart(baseW)}`);
  }
  lines.push(c.dim(`  ${'total (weighted)'.padEnd(LABEL_W)}${fmt(actSum).padStart(actW)}  ${fmt(baseSum).padStart(baseW)}`));
  lines.push('');

  const ratioStr = rec.ratio === null ? '—' : rec.ratio.toFixed(2);
  const paint = tierPaint(rec.tier, c);
  lines.push(`  pace ratio: ${c.bold(ratioStr)}   recommendation: ${paint(c.bold(`${rec.tier} (${rec.budget_minutes}m)`))}`);
  lines.push(`  ${rec.reason}`);
  lines.push('');

  // Last captured session-window signal (same source as the dashboard panel).
  const cap = report.capacity;
  if (cap.found && cap.utilization !== null) {
    const pct = `${Math.round(cap.utilization * 100)}%`;
    const when = cap.captured_at ? ` at ${cap.captured_at}` : '';
    lines.push(`  last captured ${cap.rate_limit_type ?? 'session'} window: ${c.bold(pct)} used${when}${cap.resets_at ? `, resets ${cap.resets_at}` : ''}`);
  } else if (cap.found) {
    lines.push(`  last captured rate-limit signal: ${cap.status ?? 'unknown'} (${cap.rate_limit_type ?? 'unknown window'})`);
  } else {
    lines.push(c.dim('  no rate-limit telemetry captured yet (runs a drain? the stream writes it).'));
  }
  lines.push('');
  lines.push(c.dim(`  ${report.blind_spot}`));

  return lines.join('\n');
}
