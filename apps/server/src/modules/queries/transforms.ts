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
  /** Time-series forecast + anomaly detection, applied last */
  forecast: forecastConfigSchema.optional(),
});

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

/** Applies panel transforms in a fixed order: filter → calculate → group → sort → limit → forecast. */
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

  const out = { ...result, rows, columns, rowCount: rows.length };
  if (!t.forecast?.enabled) return out;
  try {
    return applyForecast(out, t.forecast);
  } catch (e) {
    // A forecasting problem must never break the underlying panel
    return { ...out, meta: { ...out.meta, warnings: [...(out.meta?.warnings ?? []), `Forecast failed: ${(e as Error).message}`] } };
  }
}
