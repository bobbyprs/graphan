import type { ColumnMeta, QueryResult } from './types';

export function now() {
  return performance.now();
}

export function elapsed(start: number) {
  return Math.round(performance.now() - start);
}

/** Normalises driver values into JSON-safe primitives (BigInt, Buffer, Date, Decimal objects...). */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.length > 256 ? `<binary ${v.length} bytes>` : `0x${v.toString('hex')}`;
  if (typeof v === 'object') {
    const ctor = (v as object).constructor?.name;
    if (ctor === 'ObjectId' || ctor === 'Decimal128' || ctor === 'Long') return String(v);
    if (Array.isArray(v)) return v.map(normalizeValue);
    return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
  }
  return v;
}

export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r)) o[k] = normalizeValue(r[k]);
    return o;
  });
}

export function inferColumns(rows: Record<string, unknown>[]): ColumnMeta[] {
  const seen = new Map<string, string>();
  for (const row of rows.slice(0, 200)) {
    for (const [k, v] of Object.entries(row)) {
      if (!seen.has(k) || seen.get(k) === 'null') seen.set(k, inferType(v));
    }
  }
  return [...seen.entries()].map(([name, type]) => ({ name, type }));
}

function inferType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return 'datetime';
  if (typeof v === 'object') return 'json';
  return 'string';
}

export function buildResult(
  rawRows: Record<string, unknown>[],
  maxRows: number,
  start: number,
  columns?: ColumnMeta[],
  affectedRows?: number,
): QueryResult {
  const truncated = rawRows.length > maxRows;
  const rows = normalizeRows(truncated ? rawRows.slice(0, maxRows) : rawRows);
  return {
    columns: columns ?? inferColumns(rows),
    rows,
    rowCount: rows.length,
    truncated,
    durationMs: elapsed(start),
    affectedRows,
  };
}

/** Loads an optional database driver with a helpful error if it isn't installed. */
export function loadDriver<T>(name: string): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(name) as T;
  } catch (e) {
    throw new Error(`Database driver "${name}" is not installed. Run: npm i ${name} -w apps/server (${(e as Error).message})`);
  }
}

export function quoteDouble(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}
