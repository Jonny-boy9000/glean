type Row = {
  id: number;
  title: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  ended_at: number;
  dossier_path: string;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
};

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

export function renderRateList(rows: Row[], useColor: boolean): string {
  if (rows.length === 0) {
    return 'No ratable dossiers found.';
  }
  const c = useColor ? ANSI : PLAIN;
  const lines: string[] = [];

  lines.push(c.bold('Recent rateable dossiers (most recent first):'));
  lines.push('');
  lines.push(c.dim('  id    when              type              rating       title'));

  for (const r of rows) {
    const idCol = String(r.id).padEnd(5);
    const whenCol = formatLocalDateTime(r.ended_at).padEnd(17);
    const typeCol = r.candidate_type.padEnd(17);
    const ratingCol = formatRating(r.user_rating, c).padEnd(12 + ansiOverhead(r.user_rating, c));
    lines.push(`  ${idCol} ${whenCol} ${typeCol} ${ratingCol} ${r.title}`);
  }

  lines.push('');
  lines.push(c.dim('Rate one with: glean rate <id> <kept|discarded|actioned>'));

  return lines.join('\n');
}

function formatRating(rating: Row['user_rating'], c: Painter): string {
  if (rating === null) return c.dim('(unrated)');
  if (rating === 'kept' || rating === 'actioned') return c.green(rating);
  return c.red(rating);
}

function ansiOverhead(rating: Row['user_rating'], c: Painter): number {
  if (c === PLAIN) return 0;
  if (rating === null) {
    const wrapped = c.dim('x');
    return wrapped.length - 1;
  }
  const wrapped = (rating === 'kept' || rating === 'actioned') ? c.green('x') : c.red('x');
  return wrapped.length - 1;
}

function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
