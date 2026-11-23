import { mean, median, pearson, quantile, std } from './stats';

type Row = Record<string, unknown>;

export type ColumnKind = 'numeric' | 'categorical' | 'datetime' | 'boolean' | 'text' | 'identifier' | 'empty';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function toTime(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'string' && ISO_DATE.test(v.trim())) {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const isMissing = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  /** Fraction of rows with a value (0–1) */
  completeness: number;
  distinct: number;
  /** numeric only */
  stats?: { mean: number; std: number; min: number; p25: number; median: number; p75: number; max: number; zeros: number };
  /** categorical / boolean: most frequent values */
  top?: { value: string; count: number }[];
  /** datetime only (ISO) */
  range?: { from: string; to: string };
  /** 12-bin histogram for numeric columns */
  histogram?: { x0: number; x1: number; count: number }[];
  /** Why the column is (not) recommended as a model input */
  note?: string;
}

/** Infers what a column holds from a sample of its values. */
export function inferKind(name: string, values: unknown[]): ColumnKind {
  const present = values.filter((v) => !isMissing(v));
  if (!present.length) return 'empty';
  const sample = present.slice(0, 2000);
  if (sample.every((v) => typeof v === 'boolean' || v === 0 || v === 1 || v === 't' || v === 'f' || v === 'true' || v === 'false') && sample.some((v) => typeof v === 'boolean' || typeof v === 'string'))
    return 'boolean';
  if (sample.every((v) => toTime(v) !== null) && sample.some((v) => typeof v !== 'number')) return 'datetime';
  const nums = sample.map(toNumber);
  const distinct = new Set(present.map((v) => String(v))).size;
  const idName = /(^id$|_id$|^uuid$|_uuid$|^guid$|^pk$|_key$|^code$)/i.test(name);
  if (nums.every((n) => n !== null)) {
    const ints = nums.every((n) => Number.isInteger(n));
    if (ints && idName && distinct > 0.5 * present.length) return 'identifier';
    if (ints && distinct > 0.98 * present.length && present.length > 50 && isMonotonic(nums as number[])) return 'identifier';
    return 'numeric';
  }
  if (distinct > 0.9 * present.length && present.length > 30) return idName || sample.every((v) => /^[0-9a-f-]{16,}$/i.test(String(v))) ? 'identifier' : 'text';
  const avgLen = mean(sample.map((v) => String(v).length));
  if (avgLen > 60) return 'text';
  return 'categorical';
}

function isMonotonic(a: number[]) {
  let up = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[i - 1]) up++;
  return up >= 0.98 * (a.length - 1);
}

export function profileColumns(rows: Row[], columns: string[]): ColumnProfile[] {
  return columns.map((name) => {
    const values = rows.map((r) => r[name]);
    const kind = inferKind(name, values);
    const present = values.filter((v) => !isMissing(v));
    const p: ColumnProfile = {
      name,
      kind,
      completeness: rows.length ? present.length / rows.length : 0,
      distinct: new Set(present.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))).size,
    };
    if (kind === 'numeric') {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      const lo = Math.min(...nums);
      const hi = Math.max(...nums);
      p.stats = {
        mean: mean(nums),
        std: std(nums),
        min: lo,
        p25: quantile(nums, 0.25),
        median: median(nums),
        p75: quantile(nums, 0.75),
        max: hi,
        zeros: nums.filter((n) => n === 0).length,
      };
      const bins = 12;
      const w = (hi - lo) / bins || 1;
      const h = Array.from({ length: bins }, (_v, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, count: 0 }));
      for (const n of nums) h[Math.min(bins - 1, Math.floor((n - lo) / w))].count++;
      p.histogram = h;
    } else if (kind === 'categorical' || kind === 'boolean') {
      const counts = new Map<string, number>();
      for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      p.top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }));
      if (kind === 'categorical' && p.distinct > 50) p.note = `High cardinality (${p.distinct}) — only the top 20 values are encoded`;
    } else if (kind === 'datetime') {
      const ts = present.map(toTime).filter((t): t is number => t !== null);
      p.range = { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString() };
    } else if (kind === 'identifier') p.note = 'Looks like an identifier — excluded from features by default';
    else if (kind === 'text') p.note = 'Free text — not used as a feature';
    if (p.completeness < 0.5 && kind !== 'empty') p.note = `${Math.round((1 - p.completeness) * 100)}% missing`;
    return p;
  });
}

/** Pearson correlations between numeric columns (pairwise complete). */
export function correlationMatrix(rows: Row[], fields: string[]): number[][] {
  const cols = fields.map((f) => rows.map((r) => toNumber(r[f])));
  return fields.map((_a, i) =>
    fields.map((_b, j) => {
      if (i === j) return 1;
      const x: number[] = [];
      const y: number[] = [];
      for (let k = 0; k < rows.length; k++) {
        const a = cols[i][k];
        const b = cols[j][k];
        if (a !== null && b !== null) {
          x.push(a);
          y.push(b);
        }
      }
      return x.length > 2 ? round(pearson(x, y), 3) : 0;
    }),
  );
}

export const round = (v: number, d = 4) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

// ───────────── Encoder ─────────────

export type FeatureSpec =
  | { name: string; kind: 'numeric'; fill: number }
  | { name: string; kind: 'boolean'; fill: number }
  | { name: string; kind: 'categorical'; levels: string[] }
  | { name: string; kind: 'datetime'; parts: ('epochDays' | 'year' | 'month' | 'dayOfWeek' | 'hour' | 'dayOfYear')[]; fill: number };

export interface Encoder {
  specs: FeatureSpec[];
  /** Name of every encoded column, in matrix order */
  columns: string[];
  /** For each encoded column, the index of the source feature it came from (for grouped importance) */
  source: number[];
}

export const MAX_LEVELS = 20;

/** Learns imputation values, category levels and date parts from the training rows. */
export function fitEncoder(rows: Row[], features: { name: string; kind: ColumnKind }[]): Encoder {
  const specs: FeatureSpec[] = [];
  for (const f of features) {
    const values = rows.map((r) => r[f.name]);
    if (f.kind === 'numeric' || f.kind === 'boolean') {
      const nums = values.map(toNumber).filter((n): n is number => n !== null);
      specs.push({ name: f.name, kind: f.kind, fill: nums.length ? median(nums) : 0 });
    } else if (f.kind === 'categorical') {
      const counts = new Map<string, number>();
      for (const v of values) if (!isMissing(v)) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const levels = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_LEVELS).map(([k]) => k);
      specs.push({ name: f.name, kind: 'categorical', levels });
    } else if (f.kind === 'datetime') {
      const ts = values.map(toTime).filter((t): t is number => t !== null);
      const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
      const parts: ('epochDays' | 'year' | 'month' | 'dayOfWeek' | 'hour' | 'dayOfYear')[] = ['epochDays', 'month', 'dayOfWeek'];
      if (span > 2 * 365 * 864e5) parts.push('year');
      if (ts.some((t) => new Date(t).getUTCHours() !== 0)) parts.push('hour');
      if (span > 365 * 864e5) parts.push('dayOfYear');
      specs.push({ name: f.name, kind: 'datetime', parts, fill: ts.length ? median(ts) : 0 });
    }
  }
  const columns: string[] = [];
  const source: number[] = [];
  specs.forEach((s, i) => {
    const add = (c: string) => (columns.push(c), source.push(i));
    if (s.kind === 'categorical') {
      s.levels.forEach((l) => add(`${s.name}=${l}`));
      add(`${s.name}=(other)`);
    } else if (s.kind === 'datetime') s.parts.forEach((p) => add(`${s.name}.${p}`));
    else add(s.name);
  });
  return { specs, columns, source };
}

export function encodeRow(enc: Encoder, r: Row): number[] {
  const out: number[] = [];
  for (const s of enc.specs) {
    const v = r[s.name];
    if (s.kind === 'numeric' || s.kind === 'boolean') {
      const raw = s.kind === 'boolean' && typeof v === 'string' ? (/^(t|true|yes|1)$/i.test(v) ? 1 : 0) : toNumber(v);
      out.push(raw ?? s.fill);
    } else if (s.kind === 'categorical') {
      const idx = isMissing(v) ? -1 : s.levels.indexOf(String(v));
      for (let i = 0; i < s.levels.length; i++) out.push(i === idx ? 1 : 0);
      out.push(idx === -1 ? 1 : 0);
    } else {
      const t = toTime(v) ?? (typeof v === 'number' ? v : s.fill);
      const d = new Date(t);
      for (const p of s.parts) {
        switch (p) {
          case 'epochDays':
            out.push(t / 864e5);
            break;
          case 'year':
            out.push(d.getUTCFullYear());
            break;
          case 'month':
            out.push(d.getUTCMonth() + 1);
            break;
          case 'dayOfWeek':
            out.push(d.getUTCDay());
            break;
          case 'hour':
            out.push(d.getUTCHours());
            break;
          case 'dayOfYear':
            out.push(Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5));
            break;
        }
      }
    }
  }
  return out;
}

export const encode = (enc: Encoder, rows: Row[]) => rows.map((r) => encodeRow(enc, r));

/** Per-column standardisation (z-scores). Constant columns get scale 1 so they become 0. */
export interface Scaler {
  mean: number[];
  scale: number[];
}

export function fitScaler(X: number[][]): Scaler {
  const d = X[0]?.length ?? 0;
  const m = new Array<number>(d).fill(0);
  const s = new Array<number>(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) m[j] += r[j] / X.length;
  for (const r of X) for (let j = 0; j < d; j++) s[j] += (r[j] - m[j]) ** 2 / Math.max(1, X.length - 1);
  return { mean: m, scale: s.map((v) => (v > 1e-18 ? Math.sqrt(v) : 1)) };
}

export const scale = (sc: Scaler, X: number[][]) => X.map((r) => r.map((v, j) => (v - sc.mean[j]) / sc.scale[j]));
