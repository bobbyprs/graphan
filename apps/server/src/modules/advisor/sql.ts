import type { Dialect } from '../../connectors/types';

/**
 * Structured query specs for advisor suggestions. Suggestions are stored as specs, not SQL
 * strings, so the same suggestion can be rendered for a dashboard (Grafana-style macros),
 * a paginated report (date parameters) or a probe run, with or without a filter.
 */

export interface TableKeyRef {
  schema: string;
  table: string;
}

export interface JoinStep {
  /** alias of the table we join from (t0 = the base table) */
  fromAlias: string;
  fromColumn: string;
  table: TableKeyRef;
  alias: string;
  column: string;
  joinId: string;
}

export type TimeUnit = 'day' | 'week' | 'month';

export type SelectItem =
  | { kind: 'col'; alias: string; col: string; as: string }
  | { kind: 'time'; alias: string; col: string; as: string }
  | { kind: 'agg'; fn: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'countDistinct'; alias?: string; col?: string; as: string }
  /** 100 × share of rows whose (lower-cased) value is in `values` */
  | { kind: 'rate'; alias: string; col: string; values: string[]; bool?: boolean; negate?: boolean; as: string }
  /** rows whose value is (not) in `values` */
  | { kind: 'countWhere'; alias: string; col: string; values: string[]; negate?: boolean; bool?: boolean; as: string };

export interface QuerySpec {
  base: TableKeyRef;
  joins: JoinStep[];
  select: SelectItem[];
  /** time column used for the time filter (alias + column) */
  time?: { alias: string; col: string };
  group: boolean;
  orderBy?: { as: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  /** extra non-null condition for dimension columns */
  notNull?: { alias: string; col: string; text?: boolean }[];
  /** value filters (from questions): text compares case-insensitively */
  where?: WhereCond[];
  /**
   * Fixed date range on `time` (from questions). `relative` ranges ("now-30d") are left to the dashboard time picker
   * or report date parameters; absolute ones are always applied.
   */
  range?: { from?: string; to?: string; relative?: string };
}

export interface WhereCond {
  alias: string;
  col: string;
  values: (string | number)[];
  negate?: boolean;
  /** compare as numbers (no quotes, no LOWER) */
  numeric?: boolean;
  /** boolean column: TRUE (or FALSE with negate) */
  bool?: boolean;
}

export interface SqlTarget {
  dialect: Dialect;
  quote: (s: string) => string;
  /** timeGroupExpr from the connector (for probe/report fallbacks) */
  timeGroup: (col: string, seconds: number) => string;
}

export type RenderMode =
  | { mode: 'dashboard' }
  | { mode: 'report'; unit: TimeUnit }
  | { mode: 'probe'; unit: TimeUnit };

export interface FilterRef {
  alias: string;
  col: string;
  /** dashboard variable / report parameter name */
  name: string;
}

const UNIT_SECONDS: Record<TimeUnit, number> = { day: 86_400, week: 604_800, month: 2_592_000 };

export function tableSql(t: SqlTarget, ref: TableKeyRef) {
  if (t.dialect === 'sqlite' && (!ref.schema || ref.schema === 'main')) return t.quote(ref.table);
  return `${t.quote(ref.schema)}.${t.quote(ref.table)}`;
}

/** Calendar-aligned truncation so report/insight buckets read "Jan 2025", not epoch slices. */
export function truncExpr(t: SqlTarget, col: string, unit: TimeUnit): string {
  switch (t.dialect) {
    case 'postgres':
      return `date_trunc('${unit}', ${col})`;
    case 'mysql':
      return unit === 'month' ? `DATE_FORMAT(${col}, '%Y-%m-01')` : unit === 'week' ? `DATE_SUB(DATE(${col}), INTERVAL WEEKDAY(${col}) DAY)` : `DATE(${col})`;
    case 'mssql':
      return unit === 'month'
        ? `DATEFROMPARTS(YEAR(${col}), MONTH(${col}), 1)`
        : unit === 'week'
          ? `DATEADD(week, DATEDIFF(week, 0, ${col}), 0)`
          : `CAST(${col} AS date)`;
    case 'oracle':
      return unit === 'month' ? `TRUNC(${col}, 'MM')` : unit === 'week' ? `TRUNC(${col}, 'IW')` : `TRUNC(${col})`;
    case 'sqlite':
      return unit === 'month' ? `strftime('%Y-%m-01', ${col})` : unit === 'week' ? `date(${col}, 'weekday 1', '-7 days')` : `date(${col})`;
    default:
      return t.timeGroup(col, UNIT_SECONDS[unit]);
  }
}

/**
 * Bucket as text ("2026-03-01", or "2026-03" for months in reports): avoids driver time-zone shifts of
 * timestamp-without-time-zone values and gives readable chart categories.
 */
export function dateText(t: SqlTarget, expr: string, month: boolean): string {
  switch (t.dialect) {
    case 'postgres':
      return `to_char(${expr}, '${month ? 'YYYY-MM' : 'YYYY-MM-DD'}')`;
    case 'mysql':
      return `DATE_FORMAT(${expr}, '${month ? '%Y-%m' : '%Y-%m-%d'}')`;
    case 'mssql':
      return `CONVERT(varchar(${month ? 7 : 10}), ${expr}, 23)`;
    case 'oracle':
      return `TO_CHAR(${expr}, '${month ? 'YYYY-MM' : 'YYYY-MM-DD'}')`;
    case 'sqlite':
      return month ? `strftime('%Y-%m', ${expr})` : expr;
    default:
      return expr;
  }
}

/** Date-range condition on report parameters date_from / date_to (inclusive end day). */
export function reportDateFilter(t: SqlTarget, col: string): string {
  switch (t.dialect) {
    case 'postgres':
      return `${col} >= \${date_from}::date AND ${col} < \${date_to}::date + 1`;
    case 'mysql':
      return `${col} >= \${date_from} AND ${col} < DATE_ADD(\${date_to}, INTERVAL 1 DAY)`;
    case 'mssql':
      return `${col} >= \${date_from} AND ${col} < DATEADD(day, 1, CAST(\${date_to} AS date))`;
    case 'oracle':
      return `${col} >= TO_DATE(\${date_from}, 'YYYY-MM-DD') AND ${col} < TO_DATE(\${date_to}, 'YYYY-MM-DD') + 1`;
    case 'sqlite':
      return `${col} >= \${date_from} AND ${col} < date(\${date_to}, '+1 day')`;
    default:
      return `${col} >= \${date_from} AND ${col} <= \${date_to}`;
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function limitSql(dialect: Dialect, sql: string, n: number) {
  if (dialect === 'mssql') return sql.replace(/^SELECT /, `SELECT TOP ${n} `);
  if (dialect === 'oracle') return `${sql}\nFETCH FIRST ${n} ROWS ONLY`;
  return `${sql}\nLIMIT ${n}`;
}

export function renderSpec(t: SqlTarget, spec: QuerySpec, mode: RenderMode, filter?: FilterRef | null): string {
  const q = t.quote;
  const c = (alias: string, col: string) => `${alias}.${q(col)}`;
  const boolTrue = t.dialect === 'postgres' ? 'TRUE' : '1';
  const exprs: { sql: string; as: string; grouped: boolean }[] = spec.select.map((s) => {
    switch (s.kind) {
      case 'col':
        return { sql: c(s.alias, s.col), as: s.as, grouped: true };
      case 'time': {
        const col = c(s.alias, s.col);
        const sql = mode.mode === 'dashboard' ? `$__timeGroup(${col}, auto)` : dateText(t, truncExpr(t, col, mode.unit), mode.mode === 'report' && mode.unit === 'month');
        return { sql, as: s.as, grouped: true };
      }
      case 'agg': {
        const col = s.alias && s.col ? c(s.alias, s.col) : '*';
        const fn = s.fn === 'countDistinct' ? `COUNT(DISTINCT ${col})` : s.fn === 'count' ? `COUNT(${col})` : `${s.fn.toUpperCase()}(${col})`;
        return { sql: fn, as: s.as, grouped: false };
      }
      case 'rate': {
        const col = c(s.alias, s.col);
        const inList = s.bool ? `${col} = ${boolTrue}` : `LOWER(${col}) IN (${s.values.map(lit).join(', ')})`;
        const cond = s.negate ? `NOT (${inList})` : inList;
        return { sql: `100.0 * SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) / NULLIF(COUNT(${col}), 0)`, as: s.as, grouped: false };
      }
      case 'countWhere': {
        const col = c(s.alias, s.col);
        const inList = s.bool ? `${col} = ${boolTrue}` : `LOWER(${col}) IN (${s.values.map(lit).join(', ')})`;
        const cond = s.negate ? `${col} IS NOT NULL AND NOT (${inList})` : inList;
        return { sql: `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`, as: s.as, grouped: false };
      }
    }
  });

  const from = [`FROM ${tableSql(t, spec.base)} t0`];
  for (const j of spec.joins) from.push(`LEFT JOIN ${tableSql(t, j.table)} ${j.alias} ON ${j.alias}.${q(j.column)} = ${j.fromAlias}.${q(j.fromColumn)}`);

  const where: string[] = [];
  if (spec.time) {
    const col = c(spec.time.alias, spec.time.col);
    if (mode.mode === 'dashboard') where.push(`$__timeFilter(${col})`);
    else if (mode.mode === 'report') where.push(reportDateFilter(t, col));
  }
  // Oracle treats '' as NULL, so the extra check would drop every row there
  for (const n of spec.notNull ?? []) where.push(n.text && t.dialect !== 'oracle' ? `${c(n.alias, n.col)} IS NOT NULL AND ${c(n.alias, n.col)} <> ''` : `${c(n.alias, n.col)} IS NOT NULL`);
  for (const w of spec.where ?? []) where.push(whereSql(t, c(w.alias, w.col), w));
  if (spec.range && spec.time && (!spec.range.relative || mode.mode === 'probe')) {
    const col = c(spec.time.alias, spec.time.col);
    if (spec.range.from) where.push(`${col} >= ${dateLit(t, spec.range.from)}`);
    if (spec.range.to) where.push(`${col} < ${dateLit(t, spec.range.to)}`);
  }
  if (filter && mode.mode !== 'probe') where.push(`${c(filter.alias, filter.col)} IN \${${filter.name}}`);

  const lines = [`SELECT ${exprs.map((e) => `${e.sql} AS ${q(e.as)}`).join(',\n       ')}`, ...from];
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`);
  const grouped = exprs.filter((e) => e.grouped);
  if (spec.group && grouped.length && grouped.length < exprs.length) lines.push(`GROUP BY ${grouped.map((e) => e.sql).join(', ')}`);
  if (spec.orderBy?.length) {
    const idx = (as: string) => exprs.findIndex((e) => e.as === as) + 1;
    // Positional ORDER BY works everywhere (and with macros that expand to expressions)
    lines.push(`ORDER BY ${spec.orderBy.map((o) => `${idx(o.as)} ${o.dir.toUpperCase()}`).join(', ')}`);
  }
  const sql = lines.join('\n');
  return spec.limit ? limitSql(t.dialect, sql, spec.limit) : sql;
}

function whereSql(t: SqlTarget, col: string, w: WhereCond) {
  if (w.bool) return `${col} = ${t.dialect === 'postgres' ? (w.negate ? 'FALSE' : 'TRUE') : w.negate ? '0' : '1'}`;
  const vals = w.numeric ? w.values.map((v) => String(Number(v))).filter((v) => v !== 'NaN') : w.values.map((v) => lit(String(v).toLowerCase()));
  const inList = w.numeric ? `${col} IN (${vals.join(', ')})` : `LOWER(${col}) IN (${vals.join(', ')})`;
  return w.negate ? `${col} IS NOT NULL AND NOT (${inList})` : inList;
}

/** Date literal for a YYYY-MM-DD string (validated, so it is safe to inline). */
export function dateLit(t: SqlTarget, d: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Invalid date ${d}`);
  switch (t.dialect) {
    case 'postgres':
    case 'oracle':
      return `DATE '${d}'`;
    case 'mssql':
      return `CAST('${d}' AS date)`;
    default:
      return `'${d}'`;
  }
}

/** Aliases (t0, j1, …) a spec can filter on, mapped to their table. */
export function specTables(spec: QuerySpec): { alias: string; table: TableKeyRef }[] {
  return [{ alias: 't0', table: spec.base }, ...spec.joins.map((j) => ({ alias: j.alias, table: j.table }))];
}
