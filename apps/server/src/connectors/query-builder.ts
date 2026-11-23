import type { Connector } from './types';

export interface TimeRange {
  from: Date;
  to: Date;
}

export type VariableValue = string | number | boolean | null | (string | number)[];

export interface BuildContext {
  timeRange?: TimeRange;
  /** Desired number of data points for $__interval (default 500) */
  maxDataPoints?: number;
  variables?: Record<string, VariableValue>;
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
  intervalSeconds: number;
}

const NICE_INTERVALS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 604800, 2592000];

export function autoInterval(range: TimeRange | undefined, maxPoints = 500): number {
  if (!range) return 60;
  const raw = (range.to.getTime() - range.from.getTime()) / 1000 / maxPoints;
  return NICE_INTERVALS.find((i) => i >= raw) ?? NICE_INTERVALS[NICE_INTERVALS.length - 1];
}

export function parseIntervalLiteral(v: string): number {
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(v.trim());
  if (!m) throw new Error(`Invalid interval "${v}"`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's'];
}

/**
 * Expands Grafana-style macros into dialect-specific SQL with *bound parameters*.
 * User-supplied values (variables, time range) are never concatenated into SQL text.
 *
 * Supported:
 *   $__timeFrom / $__timeTo            → bound timestamp parameters
 *   $__timeFilter(col)                 → col BETWEEN :from AND :to
 *   $__timeGroup(col[, 5m|auto])       → dialect time bucketing expression
 *   $__interval_s                      → bucket size in seconds (literal integer)
 *   ${var} / $var                      → bound parameter; arrays expand to (p1, p2, ...)
 */
export function buildQuery(connector: Connector, sql: string, ctx: BuildContext = {}): BuiltQuery {
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return connector.placeholder(params.length);
  };
  const intervalSeconds = autoInterval(ctx.timeRange, ctx.maxDataPoints);
  const isMongo = connector.dialect === 'mongodb';
  const ident = (c: string) => c.trim();

  let text = sql;
  const vars = ctx.variables ?? {};

  const resolveInterval = (iv?: string): number => {
    if (!iv || iv === 'auto' || iv === '$__interval') return intervalSeconds;
    if (iv.startsWith('$')) {
      // Interval variable, e.g. $__timeGroup(ts, $bucket) — validated server-side as /^\d+(s|m|h|d)$/
      const v = vars[iv.replace(/^\$\{?|\}$/g, '')];
      return typeof v === 'string' ? parseIntervalLiteral(v) : intervalSeconds;
    }
    return parseIntervalLiteral(iv);
  };

  text = text.replace(/\$__timeGroup\(\s*([^,)]+?)\s*(?:,\s*([^)]+?)\s*)?\)/g, (_m, col: string, iv?: string) =>
    connector.timeGroupExpr(ident(col), resolveInterval(iv)),
  );

  text = text.replace(/\$__timeFilter\(\s*([^)]+?)\s*\)/g, (_m, col: string) => {
    if (!ctx.timeRange) return '1=1';
    return `${ident(col)} BETWEEN ${bind(ctx.timeRange.from)} AND ${bind(ctx.timeRange.to)}`;
  });

  text = text.replace(/\$__timeFrom\b/g, () => bind(ctx.timeRange?.from ?? new Date(0)));
  text = text.replace(/\$__timeTo\b/g, () => bind(ctx.timeRange?.to ?? new Date()));
  text = text.replace(/\$__interval_s\b/g, String(intervalSeconds));

  text = text.replace(/\$\{(\w+)\}|\$(?!__)(\w+)\b/g, (match, a?: string, b?: string) => {
    const name = (a ?? b)!;
    if (!(name in vars)) return match; // leave untouched (e.g. Postgres $1 or Mongo $match)
    const v = vars[name];
    if (Array.isArray(v)) {
      if (v.length === 0) return isMongo ? '[]' : '(NULL)';
      const ph = v.map((x) => bind(x));
      return isMongo ? `[${ph.map((p) => `"${p}"`).join(',')}]` : `(${ph.join(', ')})`;
    }
    return bind(v);
  });

  return { text, params, intervalSeconds };
}
