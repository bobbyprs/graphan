export interface Statement {
  text: string;
  /** Offset of the first non-whitespace character within the source */
  start: number;
  end: number;
}

/**
 * Splits a SQL script into statements on top-level semicolons, respecting
 * '…', "…", `…`, […] (T-SQL), $tag$…$tag$ (Postgres), -- and /* *\/ comments.
 */
export function splitSql(src: string): Statement[] {
  const out: Statement[] = [];
  let i = 0;
  let segStart = 0;
  const n = src.length;
  const push = (end: number) => {
    const raw = src.slice(segStart, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    // Skip segments that are only comments
    if (text && text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push({ text, start: segStart + lead, end });
  };
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    if (c === '-' && nx === '-') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && nx === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (src[i] === close && src[i + 1] === close) i += 2;
        else if (src[i] === close) break;
        else i++;
      }
      i++;
    } else if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 64));
      if (m) {
        const e = src.indexOf(m[0], i + m[0].length);
        i = e === -1 ? n : e + m[0].length;
      } else i++;
    } else if (c === ';') {
      push(i);
      segStart = i + 1;
      i++;
    } else i++;
  }
  push(n);
  return out;
}

/** Statement containing (or immediately before) the cursor offset. */
export function statementAt(src: string, offset: number): Statement | undefined {
  const all = splitSql(src);
  return all.find((s) => offset >= s.start && offset <= s.end + 1) ?? [...all].reverse().find((s) => s.start <= offset) ?? all[0];
}
