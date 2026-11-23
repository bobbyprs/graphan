/**
 * Parses Grafana-style time expressions:
 *   now, now-6h, now-7d, now-1M, now/d (start of day), now-1d/d, ISO-8601 strings, epoch millis.
 */
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

export function parseTimeExpr(expr: string, roundUp = false, nowDate = new Date()): Date {
  const s = expr.trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? Number(s) * 1000 : s));
  if (!s.startsWith('now')) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid time "${expr}"`);
    return d;
  }
  let d = new Date(nowDate);
  const re = /([+-])(\d+)([smhdwMy])|\/([smhdwMy])/g;
  let m: RegExpExecArray | null;
  const rest = s.slice(3);
  let consumed = 0;
  while ((m = re.exec(rest))) {
    consumed += m[0].length;
    if (m[4]) {
      d = roundTo(d, m[4], roundUp);
      continue;
    }
    const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
    const u = m[3];
    if (u === 'M') d.setUTCMonth(d.getUTCMonth() + n);
    else if (u === 'y') d.setUTCFullYear(d.getUTCFullYear() + n);
    else d = new Date(d.getTime() + n * UNIT_MS[u]);
  }
  if (consumed !== rest.length) throw new Error(`Invalid time "${expr}"`);
  return d;
}

function roundTo(d: Date, unit: string, up: boolean): Date {
  const r = new Date(d);
  switch (unit) {
    case 'y':
      r.setUTCMonth(0, 1);
      r.setUTCHours(0, 0, 0, 0);
      if (up) r.setUTCFullYear(r.getUTCFullYear() + 1);
      break;
    case 'M':
      r.setUTCDate(1);
      r.setUTCHours(0, 0, 0, 0);
      if (up) r.setUTCMonth(r.getUTCMonth() + 1);
      break;
    case 'w': {
      const day = r.getUTCDay();
      r.setUTCDate(r.getUTCDate() - day);
      r.setUTCHours(0, 0, 0, 0);
      if (up) r.setUTCDate(r.getUTCDate() + 7);
      break;
    }
    case 'd':
      r.setUTCHours(0, 0, 0, 0);
      if (up) r.setUTCDate(r.getUTCDate() + 1);
      break;
    case 'h':
      r.setUTCMinutes(0, 0, 0);
      if (up) r.setUTCHours(r.getUTCHours() + 1);
      break;
    case 'm':
      r.setUTCSeconds(0, 0);
      if (up) r.setUTCMinutes(r.getUTCMinutes() + 1);
      break;
    case 's':
      r.setUTCMilliseconds(0);
      if (up) r.setUTCSeconds(r.getUTCSeconds() + 1);
      break;
  }
  if (up) r.setTime(r.getTime() - 1);
  return r;
}

export function parseTimeRange(range: { from: string; to: string }) {
  const from = parseTimeExpr(range.from, false);
  const to = parseTimeExpr(range.to, true);
  if (from > to) throw new Error('Time range "from" must be before "to"');
  return { from, to };
}
