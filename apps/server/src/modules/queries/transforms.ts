import { z } from 'zod';
import type { ColumnMeta, QueryResult } from '../../connectors/types';
import { compileExpression } from './expression';
import { applyForecast, forecastConfigSchema } from '../../ml/forecast';

export const transformSchema = z.object({
  /** Drill-down / ad-hoc filters applied after the query */
  filters: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
      }),
    )
    .default([]),
  calculatedFields: z.array(z.object({ name: z.string().min(1).max(64), expression: z.string().min(1).max(2000) })).default([]),
  groupBy: z
    .object({
      fields: z.array(z.string()).min(1),
      aggregations: z
        .array(
          z.object({
            field: z.string(),
            fn: z.enum(['sum', 'avg', 'min', 'max', 'count', 'distinct', 'first', 'last']),
            as: z.string().optional(),
          }),
        )
        .min(1),
    })
    .optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).default('asc') })).default([]),
  limit: z.number().int().positive().max(100_000).optional(),
  /** Reshape long → wide: distinct values of columnField become columns. */
  pivot: z
    .object({
      rowField: z.string().min(1),
      columnField: z.string().min(1),
      valueField: z.string().min(1),
      agg: z.enum(['sum', 'avg', 'min', 'max', 'count', 'first', 'last']).default('sum'),
    })
    .optional(),
  /** Relabel, reorder and drop output columns (applied last, after forecast). */
  rename: z
    .object({
      map: z.record(z.string().max(128)).default({}),
      drop: z.array(z.string()).default([]),
      order: z.array(z.string()).default([]),
    })
    .partial()
    .optional(),
  /** Time-series forecast + anomaly detection, applied last */
  forecast: forecastConfigSchema.optional(),
});

/** Max distinct pivot columns before we stop (guards against exploding a key column). */
const PIVOT_COLUMN_CAP = 200;

export type Transforms = z.infer<typeof transformSchema>;

type Row = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function matches(row: Row, f: Transforms['filters'][number]): boolean {
  const v = row[f.field];
  switch (f.op) {
    case 'eq':
      return String(v) === String(f.value);
    case 'neq':
      return String(v) !== String(f.value);
    case 'gt':
      return cmp(v, f.value) > 0;
    case 'gte':
      return cmp(v, f.value) >= 0;
    case 'lt':
      return cmp(v, f.value) < 0;
    case 'lte':
      return cmp(v, f.value) <= 0;
    case 'in':
      return Array.isArray(f.value) && f.value.map(String).includes(String(v));
    case 'contains':
      return String(v ?? '').toLowerCase().includes(String(f.value).toLowerCase());
  }
}

function aggregate(values: unknown[], fn: string): unknown {
  const nums = values.map(Number).filter((n) => !Number.isNaN(n));
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'count':
      return values.length;
    case 'distinct':
      return new Set(values.map(String)).size;
    case 'first':
      return values[0] ?? null;
    case 'last':
      return values[values.length - 1] ?? null;
  }
  return null;
}

const NUMERIC_AGGS = new Set(['sum', 'avg', 'min', 'max', 'count']);

/** Long → wide reshape: one row per rowField value, one column per distinct columnField value. */
function applyPivot(rows: Row[], columns: ColumnMeta[], p: NonNullable<Transforms['pivot']>): { rows: Row[]; columns: ColumnMeta[]; warning?: string } {
  const rowKeys: string[] = [];
  const rowVals = new Map<string, unknown>(); // stringified key → original rowField value
  const colKeys: string[] = [];
  const cells = new Map<string, unknown[]>();
  let capped = false;

  for (const r of rows) {
    const rk = String(r[p.rowField]);
    const ck = String(r[p.columnField]);
    if (!rowVals.has(rk)) {
      rowVals.set(rk, r[p.rowField]);
      rowKeys.push(rk);
    }
    if (!colKeys.includes(ck)) {
      if (colKeys.length >= PIVOT_COLUMN_CAP) {
        capped = true;
        continue; // ignore values that would create a new column beyond the cap
      }
      colKeys.push(ck);
    }
    const key = `${rk}\u0000${ck}`;
    const arr = cells.get(key);
    if (arr) arr.push(r[p.valueField]);
    else cells.set(key, [r[p.valueField]]);
  }

  const outRows: Row[] = rowKeys.map((rk) => {
    const o: Row = { [p.rowField]: rowVals.get(rk) };
    for (const ck of colKeys) {
      const vals = cells.get(`${rk}\u0000${ck}`);
      o[ck] = vals ? aggregate(vals, p.agg) : null;
    }
    return o;
  });

  const rowCol = columns.find((c) => c.name === p.rowField) ?? { name: p.rowField, type: 'string' as const };
  const valType = NUMERIC_AGGS.has(p.agg) ? 'number' : 'string';
  const outCols: ColumnMeta[] = [rowCol, ...colKeys.map((ck) => ({ name: ck, type: valType }) as ColumnMeta)];
  return { rows: outRows, columns: outCols, warning: capped ? `Pivot truncated to ${PIVOT_COLUMN_CAP} columns` : undefined };
}

/** Relabel, reorder and drop columns. Row keys are rewritten to match. */
function applyRename(result: QueryResult, rn: NonNullable<Transforms['rename']>): QueryResult {
  const map = rn.map ?? {};
  const drop = new Set(rn.drop ?? []);
  let cols = result.columns.filter((c) => !drop.has(c.name));
  if (rn.order?.length) {
    const order = rn.order;
    const ordered = order.map((n) => cols.find((c) => c.name === n)).filter((c): c is ColumnMeta => !!c);
    const rest = cols.filter((c) => !order.includes(c.name));
    cols = [...ordered, ...rest];
  }
  const keep = cols.map((c) => c.name);
  const newCols = cols.map((c) => ({ ...c, name: map[c.name] ?? c.name }));
  const rows = result.rows.map((r) => {
    const o: Row = {};
    for (const name of keep) o[map[name] ?? name] = r[name];
    return o;
  });
  return { ...result, columns: newCols, rows, rowCount: rows.length };
}

/** Applies panel transforms in a fixed order: filter → calculate → group → pivot → sort → limit → forecast → rename. */
export function applyTransforms(result: QueryResult, t?: Partial<Transforms>): QueryResult {
  if (!t) return result;
  let rows: Row[] = result.rows;
  let columns: ColumnMeta[] = [...result.columns];

  if (t.filters?.length) rows = rows.filter((r) => t.filters!.every((f) => matches(r, f)));

  if (t.calculatedFields?.length) {
    const compiled = t.calculatedFields.map((c) => ({ name: c.name, fn: compileExpression(c.expression) }));
    rows = rows.map((r) => {
      const out = { ...r };
      for (const c of compiled) out[c.name] = c.fn.evaluate(out);
      return out;
    });
    for (const c of compiled) if (!columns.some((x) => x.name === c.name)) columns.push({ name: c.name, type: 'number' });
  }

  if (t.groupBy) {
    const { fields, aggregations } = t.groupBy;
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = JSON.stringify(fields.map((f) => r[f]));
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    rows = [...groups.values()].map((g) => {
      const o: Row = {};
      for (const f of fields) o[f] = g[0][f];
      for (const a of aggregations) o[a.as ?? `${a.fn}_${a.field}`] = aggregate(g.map((r) => r[a.field]), a.fn);
      return o;
    });
    columns = [
      ...fields.map((f) => columns.find((c) => c.name === f) ?? { name: f, type: 'string' }),
      ...aggregations.map((a) => ({ name: a.as ?? `${a.fn}_${a.field}`, type: 'number' })),
    ];
  }

  let pivotWarning: string | undefined;
  if (t.pivot) {
    const pv = applyPivot(rows, columns, t.pivot);
    rows = pv.rows;
    columns = pv.columns;
    pivotWarning = pv.warning;
  }

  if (t.sort?.length) {
    rows = [...rows].sort((a, b) => {
      for (const s of t.sort!) {
        const c = cmp(a[s.field], b[s.field]);
        if (c !== 0) return s.dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  if (t.limit && rows.length > t.limit) rows = rows.slice(0, t.limit);

  let out: QueryResult = { ...result, rows, columns, rowCount: rows.length };
  if (pivotWarning) out = { ...out, meta: { ...out.meta, warnings: [...(out.meta?.warnings ?? []), pivotWarning] } };
  if (t.forecast?.enabled) {
    try {
      out = applyForecast(out, t.forecast);
    } catch (e) {
      // A forecasting problem must never break the underlying panel
      out = { ...out, meta: { ...out.meta, warnings: [...(out.meta?.warnings ?? []), `Forecast failed: ${(e as Error).message}`] } };
    }
  }
  // Relabel/reorder/drop columns last, so forecast still sees the original field names.
  if (t.rename) out = applyRename(out, t.rename);
  return out;
}
