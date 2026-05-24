type Filter = (input: unknown) => string;

const filters: Record<string, Filter> = {
  join_lines: (v) =>
    Array.isArray(v)
      ? v
          .map((item) =>
            typeof item === 'object' && item !== null
              ? `line ${(item as Record<string, unknown>).line}: ${(item as Record<string, unknown>).text ?? JSON.stringify(item)}`
              : String(item),
          )
          .join('\n')
      : String(v),
  bullet_list: (v) =>
    Array.isArray(v)
      ? v
          .map((item) =>
            `- ${typeof item === 'object' && item ? (item as Record<string, unknown>).body ?? JSON.stringify(item) : String(item)}`,
          )
          .join('\n')
      : String(v),
  quote: (v) =>
    Array.isArray(v)
      ? v.map((x) => `> ${String(x).replace(/\n/g, '\n> ')}`).join('\n\n')
      : `> ${String(v)}`,
  slug: (v) =>
    String(v)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
};

function lookup(path: string, ctx: unknown): unknown {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function applyFilters(value: unknown, chain: string[]): string {
  let cur: unknown = value;
  for (const name of chain) {
    const f = filters[name.trim()];
    if (!f) throw new Error(`unknown filter: ${name}`);
    cur = f(cur);
  }
  return typeof cur === 'string' ? cur : cur == null ? '' : String(cur);
}

function evalExpr(expr: string, ctx: unknown): boolean {
  const m = expr.match(/^\s*([\w.]+)\s*==\s*"([^"]*)"\s*$/);
  if (!m) throw new Error(`unsupported if-expression: ${expr}`);
  return lookup(m[1], ctx) === m[2];
}

export function render(
  template: string,
  ctx: unknown,
  onWarn: (msg: string) => void = () => {},
): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf('}}', open);
    if (close === -1) {
      out += template.slice(open);
      break;
    }
    const tag = template.slice(open + 2, close).trim();

    if (tag.startsWith('#if ')) {
      const block = consumeIfBlock(template, open);
      out += renderIfBlock(block.branches, ctx, onWarn);
      i = block.endIndex;
      continue;
    }

    // Variable with optional filter chain
    const parts = tag.split('|').map((s) => s.trim());
    const varPath = parts[0];
    const value = lookup(varPath, ctx);
    if (value === undefined) {
      onWarn(`unknown variable: ${varPath}`);
      out += `{{${tag}}}`;
    } else {
      out += applyFilters(value, parts.slice(1));
    }
    i = close + 2;
  }
  return out;
}

type IfBranch = { cond: string | null; body: string };

function consumeIfBlock(
  template: string,
  openIdx: number,
): { branches: IfBranch[]; endIndex: number } {
  const branches: IfBranch[] = [];
  let cursor = openIdx;
  for (;;) {
    const tagOpen = template.indexOf('{{', cursor);
    const tagClose = template.indexOf('}}', tagOpen);
    const tag = template.slice(tagOpen + 2, tagClose).trim();
    const bodyStart = tagClose + 2;
    const nextOpen = findNextControlTag(template, bodyStart);
    const body = template.slice(bodyStart, nextOpen);
    if (tag.startsWith('#if ')) branches.push({ cond: tag.slice(4), body });
    else if (tag.startsWith('else if ')) branches.push({ cond: tag.slice(8), body });
    else throw new Error(`unexpected tag in if-block: ${tag}`);
    const nextClose = template.indexOf('}}', nextOpen);
    const nextTag = template.slice(nextOpen + 2, nextClose).trim();
    if (nextTag === '/if') return { branches, endIndex: nextClose + 2 };
    cursor = nextOpen;
  }
}

function findNextControlTag(template: string, from: number): number {
  let i = from;
  while (i < template.length) {
    const o = template.indexOf('{{', i);
    if (o === -1) throw new Error('unterminated if-block');
    const c = template.indexOf('}}', o);
    const t = template.slice(o + 2, c).trim();
    if (t.startsWith('else if ') || t === '/if') return o;
    i = c + 2;
  }
  throw new Error('unterminated if-block');
}

function renderIfBlock(
  branches: IfBranch[],
  ctx: unknown,
  onWarn: (m: string) => void,
): string {
  for (const b of branches) {
    if (b.cond && evalExpr(b.cond, ctx)) return render(b.body, ctx, onWarn);
  }
  return '';
}
