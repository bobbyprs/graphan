import { z } from 'zod';
import type { ColumnMeta, QueryResult } from '../connectors/types';
import { toNumber, toTime } from './preprocess';
import { median } from './stats';
import { calendarPeriods, forecastSeries, TS_MODEL_IDS, TsError, type TsResult } from './timeseries';

type Row = Record<string, unknown>;

export const forecastConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Time / ordering column. Auto-detected when omitted. */
  xField: z.string().max(200).optional(),
  /** Numeric columns to forecast. Defaults to every numeric column (max 5). */
  fields: z.array(z.string().max(200)).max(5).optional(),
  horizon: z.number().int().min(1).max(1000).default(12),
  model: z.enum(['auto', ...TS_MODEL_IDS]).default('auto'),
  seasonality: z.union([z.enum(['auto', 'none']), z.number().int().min(2).max(1500)]).default('auto'),
  confidence: z.number().min(0.5).max(0.99).default(0.95),
  anomalies: z.boolean().default(false),
  sensitivity: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type ForecastConfig = z.infer<typeof forecastConfigSchema>;

export interface ForecastMeta {
  field: string;
  xField: string;
  model: string;
  label: string;
  period: number | null;
  seasonalStrength: number | null;
  horizon: number;
  confidence: number;
  metrics: { mase: number; smape: number; rmse: number };
  leaderboard: { id: string; label: string; mase: number; smape: number; rmse: number }[];
  backtest: { horizon: number; origins: number };
  trendPct: number | null;
  next: { x: unknown; yhat: number; lower: number; upper: number } | null;
  last: number | null;
  anomalyCount: number;
  step: string;
  /** The last bucket was still in progress: excluded from training and forecast instead */
  partial?: boolean;
  error?: string;
}

export const FC = {
  forecast: (f: string) => `${f}__forecast`,
  lower: (f: string) => `${f}__lower`,
  upper: (f: string) => `${f}__upper`,
  anomaly: (f: string) => `${f}__anomaly`,
  future: '__future',
};

const MAX_POINTS = 3000;
const DAY = 864e5;

type Step = { kind: 'ms'; ms: number } | { kind: 'months'; months: number };

function addStep(t: number, s: Step, k: number) {
  if (s.kind === 'ms') return t + s.ms * k;
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + s.months * k);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.getTime();
}

function stepIndex(t0: number, t: number, s: Step) {
  if (s.kind === 'ms') return Math.round((t - t0) / s.ms);
  const a = new Date(t0);
  const b = new Date(t);
  return Math.round(((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() - a.getUTCDate()) / 30) / s.months);
}

function describeStep(s: Step): string {
  if (s.kind === 'months') return s.months === 12 ? '1 year' : s.months === 3 ? '1 quarter' : `${s.months} month${s.months > 1 ? 's' : ''}`;
  const units: [number, string][] = [
    [6048e5, 'week'],
    [DAY, 'day'],
    [36e5, 'hour'],
    [6e4, 'minute'],
    [1e3, 'second'],
  ];
  for (const [ms, name] of units) if (s.ms >= ms && s.ms % ms === 0) return `${s.ms / ms} ${name}${s.ms / ms > 1 ? 's' : ''}`;
  return `${s.ms} ms`;
}

const isFcColumn = (n: string) => n === FC.future || /__(forecast|lower|upper|anomaly)$/.test(n);

/**
 * Appends forecast rows (and anomaly markers) to a query result.
 * Output columns per field f: f__forecast, f__lower, f__upper (+ f__anomaly); future rows carry __future = true.
 */
export function applyForecast(result: QueryResult, cfg: ForecastConfig): QueryResult {
  if (!cfg.enabled || !result.rows.length) return result;
  const cols = result.columns.map((c) => c.name).filter((c) => !isFcColumn(c));
  const sample = result.rows.slice(0, 200);
  const xField =
    cfg.xField && cols.includes(cfg.xField)
      ? cfg.xField
      : (cols.find((c) => sample.filter((r) => r[c] != null).every((r) => toTime(r[c]) !== null) && sample.some((r) => r[c] != null)) ?? cols[0]);
  const fields = (cfg.fields?.length ? cfg.fields : cols.filter((c) => c !== xField && sample.some((r) => typeof r[c] === 'number')))
    .filter((f) => f !== xField && cols.includes(f))
    .slice(0, 5);
  if (!xField || !fields.length) return result;

  // ── Determine the x axis kind and order rows ──
  const xs = result.rows.map((r) => r[xField]);
  const timeVals = xs.map(toTime);
  const numVals = xs.map(toNumber);
  const kind: 'time' | 'number' | 'category' = timeVals.every((t) => t !== null) ? 'time' : numVals.every((n) => n !== null) ? 'number' : 'category';
  const key = (i: number) => (kind === 'time' ? timeVals[i]! : kind === 'number' ? numVals[i]! : i);
  const order = result.rows.map((_r, i) => i);
  if (kind !== 'category') order.sort((a, b) => key(a) - key(b));
  const rows = order.map((i) => ({ ...result.rows[i] }));
  const keys = order.map(key);
  const dateOnly = kind === 'time' && xs.every((x) => typeof x === 'string' && x.length === 10);

  // Collapse duplicate x values (sum) so long-format data still yields one series
  const uniqKeys: number[] = [];
  const firstRow: number[] = [];
  const sums = fields.map(() => [] as (number | null)[]);
  let duplicates = false;
  keys.forEach((k, i) => {
    const last = uniqKeys.length - 1;
    if (kind !== 'category' && last >= 0 && uniqKeys[last] === k) {
      duplicates = true;
      fields.forEach((f, j) => {
        const v = toNumber(rows[i][f]);
        if (v !== null) sums[j][last] = (sums[j][last] ?? 0) + v;
      });
      return;
    }
    uniqKeys.push(k);
    firstRow.push(i);
    fields.forEach((f, j) => sums[j].push(toNumber(rows[i][f])));
  });

  // ── Regular grid ──
  let step: Step | null = null;
  let gridIndex: number[] = uniqKeys.map((_k, i) => i);
  if (kind !== 'category' && uniqKeys.length > 2) {
    const diffs = uniqKeys.slice(1).map((k, i) => k - uniqKeys[i]).filter((d) => d > 0);
    const md = median(diffs);
    if (kind === 'time') {
      if (md >= 27 * DAY && md <= 32 * DAY) step = { kind: 'months', months: 1 };
      else if (md >= 88 * DAY && md <= 93 * DAY) step = { kind: 'months', months: 3 };
      else if (md >= 364 * DAY && md <= 367 * DAY) step = { kind: 'months', months: 12 };
      else step = { kind: 'ms', ms: md };
    } else step = { kind: 'ms', ms: md };
    const idx = uniqKeys.map((k) => stepIndex(uniqKeys[0], k, step!));
    const span = idx[idx.length - 1] + 1;
    const monotone = idx.every((v, i) => i === 0 || v > idx[i - 1]);
    if (monotone && span <= Math.max(MAX_POINTS * 2, uniqKeys.length * 1.5)) gridIndex = idx;
  }
  const gridLen = gridIndex[gridIndex.length - 1] + 1;
  // An incomplete final bucket (today's revenue at 10am, or data that stops mid-interval) drags every
  // model toward zero, so it is held out of training and forecast like a future period instead.
  // Detected when the bucket contains "now", or when every measure is non-negative and collapses
  // below 40% of its recent median at once (the signature of truncation rather than a real event).
  const lastIdx = firstRow.length - 1;
  const containsNow = kind === 'time' && !!step && addStep(uniqKeys[lastIdx], step, 1) > Date.now();
  const truncated =
    kind === 'time' &&
    lastIdx >= 8 &&
    fields.every((_f, j) => {
      const recent = sums[j].slice(Math.max(0, lastIdx - 8), lastIdx).filter((v): v is number => v !== null);
      const last = sums[j][lastIdx];
      return last !== null && recent.length >= 4 && recent.every((v) => v >= 0) && last >= 0 && last < 0.4 * median(recent);
    });
  const partial = uniqKeys.length >= 8 && (containsNow || truncated);
  if (partial) rows[firstRow[lastIdx]].__partial = true;

  const metas: ForecastMeta[] = [];
  const futureCount = cfg.horizon;
  const futureRows: Row[] = Array.from({ length: futureCount }, (_v, k) => {
    let x: unknown;
    const lastKey = uniqKeys[uniqKeys.length - 1];
    if (kind === 'time' && step) {
      const t = addStep(lastKey, step, k + 1);
      x = dateOnly ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString();
    } else if (kind === 'number' && step) x = lastKey + (step as { ms: number }).ms * (k + 1);
    else x = `+${k + 1}`;
    return { [xField]: x, [FC.future]: true };
  });

  const newCols: ColumnMeta[] = [];
  fields.forEach((f, j) => {
    // Series on the grid with linear interpolation across gaps / missing values
    const y = new Array<number>(gridLen).fill(NaN);
    gridIndex.forEach((g, i) => {
      const v = sums[j][i];
      if (v !== null && Number.isFinite(v)) y[g] = v;
    });
    interpolate(y);
    const usable = partial ? y.slice(0, -1) : y;
    const offset = Math.max(0, usable.length - MAX_POINTS);
    const series = usable.slice(offset);
    const nonNegative = series.every((v) => v >= 0);
    const base: Omit<ForecastMeta, 'model' | 'label' | 'metrics' | 'leaderboard' | 'backtest' | 'period' | 'seasonalStrength' | 'trendPct' | 'next' | 'anomalyCount'> = {
      field: f,
      xField,
      horizon: cfg.horizon,
      confidence: cfg.confidence,
      last: series.length ? series[series.length - 1] : null,
      step: step ? describeStep(step) : 'row',
      partial,
    };
    let r: TsResult;
    try {
      if (series.some((v) => !Number.isFinite(v))) throw new TsError(`"${f}" has no numeric values`);
      const candidates = !step ? [] : step.kind === 'months' ? (step.months === 1 ? [12, 3] : step.months === 3 ? [4] : []) : kind === 'time' ? calendarPeriods(step.ms) : [];
      r = forecastSeries(series, { ...cfg, horizon: cfg.horizon + (partial ? 1 : 0), candidatesPeriods: candidates });
      // a quantity that has never been negative cannot be forecast below zero
      if (nonNegative) r.forecast = r.forecast.map((p) => ({ yhat: Math.max(0, p.yhat), lower: Math.max(0, p.lower), upper: Math.max(0, p.upper) }));
    } catch (e) {
      metas.push({
        ...base,
        model: 'none',
        label: 'Not forecast',
        period: null,
        seasonalStrength: null,
        metrics: { mase: NaN, smape: NaN, rmse: NaN },
        leaderboard: [],
        backtest: { horizon: 0, origins: 0 },
        trendPct: null,
        next: null,
        anomalyCount: 0,
        error: (e as Error).message,
      });
      return;
    }
    // bridge: make the forecast line start at the last actual point
    const bridgeIdx = partial ? lastIdx - 1 : lastIdx;
    const lastVal = sums[j][bridgeIdx];
    if (lastVal !== null) Object.assign(rows[firstRow[bridgeIdx]], { [FC.forecast(f)]: lastVal, [FC.lower(f)]: lastVal, [FC.upper(f)]: lastVal });
    const put = (row: Row, p: { yhat: number; lower: number; upper: number }) => Object.assign(row, { [FC.forecast(f)]: round(p.yhat), [FC.lower(f)]: round(p.lower), [FC.upper(f)]: round(p.upper) });
    const fcs = r.forecast;
    if (partial) put(rows[firstRow[lastIdx]], fcs[0]);
    fcs.slice(partial ? 1 : 0).forEach((p, k) => put(futureRows[k], p));
    newCols.push({ name: FC.forecast(f), type: 'number' }, { name: FC.lower(f), type: 'number' }, { name: FC.upper(f), type: 'number' });
    if (cfg.anomalies) {
      const gridToRow = new Map(gridIndex.map((g, i) => [g, firstRow[i]]));
      for (const a of r.anomalies) {
        const ri = gridToRow.get(a + offset);
        if (ri !== undefined) rows[ri][FC.anomaly(f)] = sums[j][gridIndex.indexOf(a + offset)];
      }
      newCols.push({ name: FC.anomaly(f), type: 'number' });
    }
    metas.push({
      ...base,
      model: r.model,
      label: r.label,
      period: r.period,
      seasonalStrength: r.seasonalStrength,
      metrics: { mase: round(r.metrics.mase, 3), smape: round(r.metrics.smape, 2), rmse: round(r.metrics.rmse) },
      leaderboard: r.leaderboard.slice(0, 6).map((b) => ({ id: b.id, label: b.label, mase: round(b.mase, 3), smape: round(b.smape, 2), rmse: round(b.rmse) })),
      backtest: r.backtest,
      trendPct: r.trendPct === null ? null : round(r.trendPct, 2),
      next: fcs[0] ? { x: partial ? rows[firstRow[lastIdx]][xField] : futureRows[0][xField], yhat: round(fcs[0].yhat), lower: round(fcs[0].lower), upper: round(fcs[0].upper) } : null,
      anomalyCount: r.anomalies.length,
    });
  });

  if (!newCols.length) return { ...result, meta: { ...result.meta, forecast: metas } };
  const warnings = duplicates ? ['Rows sharing the same x value were summed before forecasting'] : [];
  const columns = [...result.columns.filter((c) => !isFcColumn(c.name)), ...newCols, { name: FC.future, type: 'boolean' }];
  const allRows = [...rows, ...futureRows];
  return { ...result, columns, rows: allRows, rowCount: allRows.length, meta: { ...result.meta, forecast: metas, warnings: [...(result.meta?.warnings ?? []), ...warnings] } };
}

function interpolate(y: number[]) {
  let prev = -1;
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) continue;
    if (prev === -1) for (let k = 0; k < i; k++) y[k] = y[i];
    else if (i - prev > 1) for (let k = prev + 1; k < i; k++) y[k] = y[prev] + ((y[i] - y[prev]) * (k - prev)) / (i - prev);
    prev = i;
  }
  if (prev >= 0) for (let k = prev + 1; k < y.length; k++) y[k] = y[prev];
}

function round(v: number, d = 4) {
  if (!Number.isFinite(v)) return v;
  const mag = Math.abs(v) >= 1 ? d : d + Math.ceil(-Math.log10(Math.abs(v) || 1));
  return Number(v.toFixed(Math.min(12, Math.max(0, mag))));
}
