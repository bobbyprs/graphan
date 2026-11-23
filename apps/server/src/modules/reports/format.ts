import type { QueryResult } from '../../connectors/types';
import { AGGREGATES } from './report.schema';

export interface FormatContext {
  locale: string;
  currency: string;
  timezone: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Date parts in the report's time zone (dates without a time are treated as UTC calendar dates). */
function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, M: +o.month, d: +o.day, H: +o.hour, m: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}

function datePattern(d: Date, pattern: string, tz: string): string {
  const p = parts(d, tz);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|ss|tt/g, (t) => {
    switch (t) {
      case 'yyyy': return String(p.y);
      case 'yy': return pad(p.y % 100);
      case 'MMMM': return MONTHS[p.M - 1];
      case 'MMM': return MONTHS[p.M - 1].slice(0, 3);
      case 'MM': return pad(p.M);
      case 'M': return String(p.M);
      case 'dddd': return DAYS[p.wd];
      case 'ddd': return DAYS[p.wd].slice(0, 3);
      case 'dd': return pad(p.d);
      case 'd': return String(p.d);
      case 'HH': return pad(p.H);
      case 'H': return String(p.H);
      case 'hh': return pad(p.H % 12 || 12);
      case 'h': return String(p.H % 12 || 12);
      case 'mm': return pad(p.m);
      case 'ss': return pad(p.s);
      case 'tt': return p.H < 12 ? 'AM' : 'PM';
      default: return t;
    }
  });
}

/** Formats a value for display using an SSRS-style format code. */
export function formatValue(v: unknown, fmt: string | undefined, ctx: FormatContext): string {
  if (v === null || v === undefined) return '';
  const code = fmt?.trim();
  const m = code ? /^([NCPFG])(\d{0,2})$/i.exec(code) : null;
  if (m) {
    const n = toNumber(v);
    if (n === null) return String(v);
    const digits = m[2] === '' ? (m[1].toUpperCase() === 'P' ? 1 : m[1].toUpperCase() === 'G' ? undefined : 2) : +m[2];
    const opts = (min?: number): Intl.NumberFormatOptions => ({ minimumFractionDigits: min, maximumFractionDigits: min });
    switch (m[1].toUpperCase()) {
      case 'N': return n.toLocaleString(ctx.locale, opts(digits));
      case 'F': return n.toLocaleString(ctx.locale, { ...opts(digits), useGrouping: false });
      case 'P': return `${(n * 100).toLocaleString(ctx.locale, opts(digits))}%`;
      case 'C': {
        const s = Math.abs(n).toLocaleString(ctx.locale, opts(digits));
        return n < 0 ? `-${ctx.currency}${s}` : `${ctx.currency}${s}`;
      }
      default: return n.toLocaleString(ctx.locale);
    }
  }
  const d = v instanceof Date || (typeof v === 'string' && code) ? toDate(v) : null;
  if (code && d) {
    if (code === 'D') return datePattern(d, 'yyyy-MM-dd', ctx.timezone);
    if (code === 'DT') return datePattern(d, 'yyyy-MM-dd HH:mm', ctx.timezone);
    if (code === 'T') return datePattern(d, 'HH:mm:ss', ctx.timezone);
    return datePattern(d, code, ctx.timezone);
  }
  if (v instanceof Date) return datePattern(v, 'yyyy-MM-dd HH:mm:ss', ctx.timezone);
  // Unformatted numbers print as-is (IDs, years); use N0/N2/C2 for grouping
  if (typeof v === 'number') return v.toLocaleString(ctx.locale, { maximumFractionDigits: 6, useGrouping: false });
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Maps a format code to an Excel number format. */
export function excelFormat(fmt: string | undefined, ctx: FormatContext): string | undefined {
  if (!fmt) return undefined;
  const m = /^([NCPFG])(\d{0,2})$/i.exec(fmt.trim());
  const dec = (n: number) => (n > 0 ? `.${'0'.repeat(n)}` : '');
  if (m) {
    const k = m[1].toUpperCase();
    const n = m[2] === '' ? (k === 'P' ? 1 : 2) : +m[2];
    if (k === 'N') return `#,##0${dec(n)}`;
    if (k === 'F') return `0${dec(n)}`;
    if (k === 'P') return `0${dec(n)}%`;
    if (k === 'C') return `"${ctx.currency.replace(/"/g, '')}"#,##0${dec(n)};-"${ctx.currency.replace(/"/g, '')}"#,##0${dec(n)}`;
    return undefined;
  }
  if (fmt === 'D') return 'yyyy-mm-dd';
  if (fmt === 'DT') return 'yyyy-mm-dd hh:mm';
  if (fmt === 'T') return 'hh:mm:ss';
  // Excel decides month vs minute for "mm" from context (after h / before s = minutes), so lower-casing works
  if (/[yMdHhms]/.test(fmt)) return fmt.toLowerCase().replace(/tt/g, 'AM/PM');
  return undefined;
}

// ───────────────────────── Aggregation ─────────────────────────

export type Aggregate = (typeof AGGREGATES)[number];

export function aggregate(rows: Record<string, unknown>[], field: string, fn: Aggregate): unknown {
  if (fn === 'count') return rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
  if (fn === 'countDistinct') return new Set(rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined).map((v) => String(v))).size;
  if (fn === 'first') return rows[0]?.[field] ?? null;
  if (fn === 'last') return rows[rows.length - 1]?.[field] ?? null;
  const nums = rows.map((r) => toNumber(r[field])).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (fn) {
    case 'sum': return round(nums.reduce((a, b) => a + b, 0));
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
  }
}
const round = (n: number) => Math.round(n * 1e9) / 1e9;

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null && typeof a !== 'string') return na - nb;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// ───────────────────────── {{ expressions }} ─────────────────────────

export interface ExpressionScope {
  fmt: FormatContext;
  reportName: string;
  executionTime: Date;
  user: string;
  parameters: Record<string, unknown>;
  /** Parameter values formatted for display (labels for selections) */
  parameterLabels: Record<string, string>;
  datasets: Record<string, QueryResult>;
  /** Left as tokens so page-level renderers can substitute them */
  keepPageTokens?: boolean;
}

const AGG_FN: Record<string, Aggregate> = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', count: 'count', countdistinct: 'countDistinct', first: 'first', last: 'last' };

/** Evaluates {{...}} placeholders. Unknown references render as "#Error" (like SSRS) rather than throwing. */
export function evaluateText(src: string, s: ExpressionScope): string {
  if (!src.includes('{{')) return src;
  return src.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr: string) => {
    try {
      return evalExpr(expr, s) ?? whole;
    } catch {
      return '#Error';
    }
  });
}

function evalExpr(expr: string, s: ExpressionScope): string | null {
  const g = /^Globals\.(\w+)$/i.exec(expr);
  if (g) {
    switch (g[1].toLowerCase()) {
      case 'reportname': return s.reportName;
      case 'executiontime': return formatValue(s.executionTime, 'DT', s.fmt);
      case 'executiondate': return formatValue(s.executionTime, 'D', s.fmt);
      case 'pagenumber':
      case 'totalpages':
        return s.keepPageTokens ? `{{Globals.${g[1]}}}` : '';
      default: return '#Error';
    }
  }
  const u = /^User\.(\w+)$/i.exec(expr);
  if (u) return s.user;
  const p = /^Parameters\.(\w+)(?:\s*,\s*([^,]+))?$/i.exec(expr);
  if (p) {
    if (!(p[1] in s.parameters)) return '#Error';
    if (p[2]) {
      const v = s.parameters[p[1]];
      return Array.isArray(v) ? v.map((x) => formatValue(x, p[2].trim(), s.fmt)).join(', ') : formatValue(v, p[2].trim(), s.fmt);
    }
    return s.parameterLabels[p[1]] ?? '';
  }
  const a = /^(\w+)\(\s*(\w+)(?:\.(\w+))?\s*(?:,\s*([^)]+))?\)$/.exec(expr);
  if (a) {
    const fn = AGG_FN[a[1].toLowerCase()];
    const ds = s.datasets[a[2]];
    if (!fn || !ds) return '#Error';
    if (!a[3]) return fn === 'count' ? formatValue(ds.rows.length, a[4]?.trim() ?? 'N0', s.fmt) : '#Error';
    return formatValue(aggregate(ds.rows, a[3], fn), a[4]?.trim(), s.fmt);
  }
  return '#Error';
}

/** Resolves "today", "today-7d", "startOfMonth", "startOfYear", "endOfMonth" date keywords to yyyy-MM-dd. */
export function resolveDateKeyword(v: string, tz: string): string {
  const m = /^(today|now|startOfMonth|startOfYear|startOfWeek|endOfMonth)\s*(?:([+-])\s*(\d+)\s*([dwmy]))?$/i.exec(v.trim());
  if (!m) return v;
  const p = parts(new Date(), tz);
  const d = new Date(Date.UTC(p.y, p.M - 1, p.d));
  switch (m[1].toLowerCase()) {
    case 'startofmonth': d.setUTCDate(1); break;
    case 'startofyear': d.setUTCMonth(0, 1); break;
    case 'startofweek': d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); break;
    case 'endofmonth': d.setUTCMonth(d.getUTCMonth() + 1, 0); break;
  }
  if (m[2]) {
    const n = (m[2] === '-' ? -1 : 1) * +m[3];
    const unit = m[4].toLowerCase();
    if (unit === 'd') d.setUTCDate(d.getUTCDate() + n);
    if (unit === 'w') d.setUTCDate(d.getUTCDate() + 7 * n);
    if (unit === 'm') d.setUTCMonth(d.getUTCMonth() + n);
    if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() + n);
  }
  return d.toISOString().slice(0, 10);
}
