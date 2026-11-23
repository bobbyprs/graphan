import { leastSquares, mad, mean, median, nelderMead, normInv, sigmoid, smape, std } from './stats';

/**
 * Univariate forecasting on a regularly spaced series.
 * Model selection follows forecasting-competition practice (M3/M4): a pool of exponential
 * smoothing, Theta, regression and autoregressive models is backtested on rolling origins,
 * ranked by MASE (scale-free), and the top three are also offered as an equal-weight ensemble.
 */

export const TS_MODEL_IDS = ['naive', 'drift', 'seasonal_naive', 'ses', 'holt', 'holt_winters', 'holt_winters_mul', 'theta', 'fourier', 'ar', 'ensemble'] as const;
export type TsModelId = (typeof TS_MODEL_IDS)[number];

export const TS_MODEL_INFO: Record<TsModelId, { label: string; description: string }> = {
  naive: { label: 'Naive', description: 'Repeats the last observation (random walk).' },
  drift: { label: 'Drift', description: 'Random walk with the average historical slope.' },
  seasonal_naive: { label: 'Seasonal naive', description: 'Repeats the last full season.' },
  ses: { label: 'Exponential smoothing', description: 'Simple exponential smoothing: a level that adapts to recent data.' },
  holt: { label: 'Holt (damped trend)', description: 'Exponential smoothing with a damped trend.' },
  holt_winters: { label: 'Holt-Winters', description: 'Level + damped trend + additive seasonality.' },
  holt_winters_mul: { label: 'Holt-Winters (multiplicative)', description: 'Seasonal swings that scale with the level.' },
  theta: { label: 'Theta', description: 'M3-competition winner: SES with half the long-run drift, on deseasonalised data.' },
  fourier: { label: 'Trend + Fourier', description: 'Linear trend plus sine/cosine seasonal harmonics (ridge regression).' },
  ar: { label: 'Autoregressive', description: 'AR(p) on the (differenced) series, order chosen by AIC, with a seasonal lag.' },
  ensemble: { label: 'Ensemble (top 3)', description: 'Equal-weight average of the three best backtested models — usually the most robust.' },
};

interface Fit {
  /** one-step-ahead in-sample predictions (NaN during warm-up) */
  fitted: number[];
  forecast(h: number): number[];
  /** forecast-error variance multiplier relative to one-step σ² for step h (1-based) */
  varMult(h: number): number;
}

type Fitter = (y: number[], periods: number[]) => Fit | null;

const unit = (x: number) => sigmoid(x);
const damp = (x: number) => 0.8 + 0.18 * sigmoid(x);

function sse(y: number[], fitted: number[], from: number) {
  let s = 0;
  for (let i = from; i < y.length; i++) {
    const e = y[i] - fitted[i];
    s += Number.isFinite(e) ? e * e : 1e30;
  }
  return s;
}

// ───────────── Models ─────────────

const naive: Fitter = (y) => ({
  fitted: y.map((_v, i) => (i ? y[i - 1] : NaN)),
  forecast: (h) => new Array(h).fill(y[y.length - 1]),
  varMult: (h) => h,
});

const drift: Fitter = (y) => {
  const n = y.length;
  const slope = (y[n - 1] - y[0]) / (n - 1);
  return {
    fitted: y.map((_v, i) => (i ? y[i - 1] + slope : NaN)),
    forecast: (h) => Array.from({ length: h }, (_v, k) => y[n - 1] + slope * (k + 1)),
    varMult: (h) => h * (1 + h / (n - 1)),
  };
};

const seasonalNaive: Fitter = (y, periods) => {
  const m = periods[0];
  if (!m || y.length < 2 * m) return null;
  const n = y.length;
  return {
    fitted: y.map((_v, i) => (i >= m ? y[i - m] : NaN)),
    forecast: (h) => Array.from({ length: h }, (_v, k) => y[n - m + (k % m)]),
    varMult: (h) => Math.floor((h - 1) / m) + 1,
  };
};

function runSes(y: number[], a: number) {
  const fitted = new Array<number>(y.length);
  let l = y[0];
  fitted[0] = NaN;
  for (let i = 1; i < y.length; i++) {
    fitted[i] = l;
    l = a * y[i] + (1 - a) * l;
  }
  return { fitted, level: l };
}

const ses: Fitter = (y) => {
  const [p] = nelderMead((x) => sse(y, runSes(y, unit(x[0])).fitted, 1), [0], { maxIter: 120 });
  const a = unit(p);
  const r = runSes(y, a);
  return { fitted: r.fitted, forecast: (h) => new Array(h).fill(r.level), varMult: (h) => 1 + (h - 1) * a * a };
};

function runHolt(y: number[], a: number, b: number, phi: number) {
  let l = y[0];
  let t = y[1] - y[0];
  const fitted = new Array<number>(y.length).fill(NaN);
  for (let i = 1; i < y.length; i++) {
    fitted[i] = l + phi * t;
    const nl = a * y[i] + (1 - a) * (l + phi * t);
    t = b * (nl - l) + (1 - b) * phi * t;
    l = nl;
  }
  return { fitted, l, t };
}

const holt: Fitter = (y) => {
  if (y.length < 6) return null;
  const x = nelderMead((p) => sse(y, runHolt(y, unit(p[0]), unit(p[1]), damp(p[2])).fitted, 2), [0, -2, 1], { maxIter: 300 });
  const [a, b, phi] = [unit(x[0]), unit(x[1]), damp(x[2])];
  const r = runHolt(y, a, b, phi);
  return {
    fitted: r.fitted,
    forecast: (h) => {
      let cum = 0;
      return Array.from({ length: h }, (_v, k) => {
        cum += phi ** (k + 1);
        return r.l + cum * r.t;
      });
    },
    varMult: (h) => {
      let s = 1;
      for (let j = 1; j < h; j++) s += (a * (1 + b * j)) ** 2;
      return s;
    },
  };
};

function runHw(y: number[], m: number, a: number, b: number, g: number, phi: number, mult: boolean) {
  const s1 = mean(y.slice(0, m));
  const s2 = mean(y.slice(m, 2 * m));
  let l = s1;
  let t = (s2 - s1) / m;
  const s = y.slice(0, m).map((v) => (mult ? v / s1 : v - s1));
  const fitted = new Array<number>(y.length).fill(NaN);
  for (let i = m; i < y.length; i++) {
    const si = s[i % m];
    fitted[i] = mult ? (l + phi * t) * si : l + phi * t + si;
    const nl = mult ? (a * y[i]) / si + (1 - a) * (l + phi * t) : a * (y[i] - si) + (1 - a) * (l + phi * t);
    t = b * (nl - l) + (1 - b) * phi * t;
    s[i % m] = mult ? (g * y[i]) / nl + (1 - g) * si : g * (y[i] - nl) + (1 - g) * si;
    l = nl;
  }
  return { fitted, l, t, s, n: y.length };
}

const holtWinters =
  (mult: boolean): Fitter =>
  (y, periods) => {
    const m = periods[0];
    if (!m || m < 2 || y.length < 2 * m + 2) return null;
    if (mult && y.some((v) => v <= 0)) return null;
    const x = nelderMead((p) => sse(y, runHw(y, m, unit(p[0]), unit(p[1]), unit(p[2]), damp(p[3]), mult).fitted, m), [-1, -3, -2, 1], { maxIter: 300 });
    const [a, b, g, phi] = [unit(x[0]), unit(x[1]), unit(x[2]), damp(x[3])];
    const r = runHw(y, m, a, b, g, phi, mult);
    return {
      fitted: r.fitted,
      forecast: (h) => {
        let cum = 0;
        return Array.from({ length: h }, (_v, k) => {
          cum += phi ** (k + 1);
          const si = r.s[(r.n + k) % m];
          return mult ? (r.l + cum * r.t) * si : r.l + cum * r.t + si;
        });
      },
      varMult: (h) => {
        let s = 1;
        for (let j = 1; j < h; j++) s += (a * (1 + b * j) + (j % m === 0 ? g * (1 - a) : 0)) ** 2;
        return s;
      },
    };
  };

/** Classical decomposition seasonal indices (multiplicative when the series is positive). */
function seasonalIndices(y: number[], m: number) {
  const mult = y.every((v) => v > 0);
  const n = y.length;
  const trend = new Array<number>(n).fill(NaN);
  const half = Math.floor(m / 2);
  for (let i = half; i < n - half; i++) {
    let s = 0;
    if (m % 2) for (let k = -half; k <= half; k++) s += y[i + k];
    else {
      for (let k = -half + 1; k < half; k++) s += y[i + k];
      s += 0.5 * (y[i - half] + y[i + half]);
    }
    trend[i] = s / m;
  }
  const buckets = Array.from({ length: m }, () => [] as number[]);
  for (let i = 0; i < n; i++) if (Number.isFinite(trend[i])) buckets[i % m].push(mult ? y[i] / trend[i] : y[i] - trend[i]);
  let idx = buckets.map((b) => (b.length ? mean(b) : mult ? 1 : 0));
  const norm = mean(idx);
  idx = idx.map((v) => (mult ? v / norm : v - norm));
  return { idx, mult };
}

const theta: Fitter = (y, periods) => {
  const n = y.length;
  if (n < 8) return null;
  const m = periods[0];
  const seasonal = !!m && n >= 2 * m + 2;
  const si = seasonal ? seasonalIndices(y, m) : null;
  const adj = (v: number, i: number) => (!si ? v : si.mult ? v / si.idx[i % m] : v - si.idx[i % m]);
  const re = (v: number, i: number) => (!si ? v : si.mult ? v * si.idx[i % m] : v + si.idx[i % m]);
  const d = y.map(adj);
  const t = d.map((_v, i) => [i]);
  const slope = leastSquares(t, d).coef[0] ?? 0;
  const [p] = nelderMead((x) => sse(d, runSes(d, unit(x[0])).fitted.map((f) => f + slope / 2), 1), [0], { maxIter: 120 });
  const a = unit(p);
  const r = runSes(d, a);
  return {
    fitted: r.fitted.map((f, i) => re(f + slope / 2, i)),
    forecast: (h) => Array.from({ length: h }, (_v, k) => re(r.level + (slope / 2) * (k + 1 / a - ((1 - a) ** n) / a), n + k)),
    varMult: (h) => 1 + (h - 1) * a * a,
  };
};

function fourierRow(i: number, periods: number[]) {
  const row = [i];
  for (const m of periods) {
    const K = Math.min(Math.floor(m / 2), m > 50 ? 8 : 4);
    for (let k = 1; k <= K; k++) {
      row.push(Math.sin((2 * Math.PI * k * i) / m), Math.cos((2 * Math.PI * k * i) / m));
    }
  }
  return row;
}

const fourier: Fitter = (y, periods) => {
  const n = y.length;
  const ps = periods.filter((m) => m >= 2 && n >= 2 * m).slice(0, 2);
  const X = y.map((_v, i) => fourierRow(i, ps));
  // scale time to [0,1] so the ridge penalty treats trend and harmonics alike
  const Xs = X.map((r) => [r[0] / n, ...r.slice(1)]);
  const { coef, intercept } = leastSquares(Xs, y, 1e-4);
  const f = (i: number) => {
    const r = fourierRow(i, ps);
    r[0] /= n;
    return r.reduce((s, v, j) => s + v * coef[j], intercept);
  };
  return { fitted: y.map((_v, i) => f(i)), forecast: (h) => Array.from({ length: h }, (_v, k) => f(n + k)), varMult: (h) => 1 + h / n };
};

const ar: Fitter = (y, periods) => {
  const n = y.length;
  if (n < 12) return null;
  const diffs = y.slice(1).map((v, i) => v - y[i]);
  const diffed = std(diffs) < 0.7 * std(y);
  const z = diffed ? diffs : y;
  const m = periods[0];
  const maxP = Math.min(12, Math.floor(z.length / 6));
  let best: { aic: number; lags: number[]; coef: number[]; intercept: number; sigma2: number } | null = null;
  for (let p = 1; p <= maxP; p++) {
    const lags = Array.from({ length: p }, (_v, i) => i + 1);
    if (m && m > p && m <= 200 && z.length > 3 * m) lags.push(m);
    const start = Math.max(...lags);
    const X: number[][] = [];
    const t: number[] = [];
    for (let i = start; i < z.length; i++) {
      X.push(lags.map((l) => z[i - l]));
      t.push(z[i]);
    }
    if (X.length < lags.length + 5) break;
    const { coef, intercept } = leastSquares(X, t, 1e-6);
    let s = 0;
    X.forEach((r, i) => (s += (t[i] - r.reduce((a, v, j) => a + v * coef[j], intercept)) ** 2));
    const sigma2 = s / X.length;
    const aic = X.length * Math.log(sigma2 + 1e-12) + 2 * (lags.length + 1);
    if (!best || aic < best.aic) best = { aic, lags, coef, intercept, sigma2 };
  }
  if (!best) return null;
  const { lags, coef, intercept } = best;
  const step = (hist: number[], i: number) => lags.reduce((a, l, j) => a + coef[j] * (hist[i - l] ?? 0), intercept);
  const start = Math.max(...lags);
  const zf = z.map((_v, i) => (i >= start ? step(z, i) : NaN));
  const fitted = diffed ? y.map((_v, i) => (i >= 1 && Number.isFinite(zf[i - 1]) ? y[i - 1] + zf[i - 1] : NaN)) : zf;
  // ψ-weights of the MA(∞) representation give exact AR forecast-error variances
  const maxLag = Math.max(...lags);
  const phi = new Array(maxLag + 1).fill(0);
  lags.forEach((l, j) => (phi[l] = coef[j]));
  const psi = (h: number) => {
    const w = [1];
    for (let j = 1; j < h; j++) {
      let s = 0;
      for (let k = 1; k <= Math.min(j, maxLag); k++) s += phi[k] * w[j - k];
      w.push(s);
    }
    if (!diffed) return w;
    let c = 0;
    return w.map((v) => (c += v));
  };
  return {
    fitted,
    forecast: (h) => {
      const hist = z.slice();
      for (let k = 0; k < h; k++) hist.push(step(hist, hist.length));
      const fz = hist.slice(z.length);
      if (!diffed) return fz;
      let last = y[n - 1];
      return fz.map((d) => (last += d));
    },
    varMult: (h) => Math.min(1e6, psi(h).reduce((s, w) => s + w * w, 0)),
  };
};

const FITTERS: Record<Exclude<TsModelId, 'ensemble'>, Fitter> = {
  naive,
  drift,
  seasonal_naive: seasonalNaive,
  ses,
  holt,
  holt_winters: holtWinters(false),
  holt_winters_mul: holtWinters(true),
  theta,
  fourier,
  ar,
};

// ───────────── Seasonality ─────────────

function acf(y: number[], lag: number, m = mean(y), v = y.reduce((s, x) => s + (x - m) ** 2, 0)): number {
  if (!v || lag >= y.length) return 0;
  let s = 0;
  for (let i = lag; i < y.length; i++) s += (y[i] - m) * (y[i - lag] - m);
  return s / v;
}

function detrend(y: number[]) {
  const { coef, intercept } = leastSquares(
    y.map((_v, i) => [i]),
    y,
  );
  return y.map((v, i) => v - (intercept + coef[0] * i));
}

/** Calendar cycles (hour, day, week, year) expressed in sample steps. */
export function calendarPeriods(stepMs: number): number[] {
  if (!stepMs) return [];
  const cycles = [3600e3, 864e5, 6048e5, 315576e5];
  return cycles
    .map((c) => c / stepMs)
    .filter((m) => m >= 2 && Math.abs(m - Math.round(m)) < 0.05 * m)
    .map((m) => Math.round(m))
    .filter((m) => m <= 1500);
}

/** Returns significant seasonal periods, strongest first. */
export function detectPeriods(y: number[], candidates: number[]): { periods: number[]; strength: Record<number, number> } {
  const d = detrend(y);
  const m = mean(d);
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0);
  const strength: Record<number, number> = {};
  const usable = candidates.filter((p) => y.length >= 2 * p + 2);
  for (const p of usable) strength[p] = acf(d, p, m, v);
  let periods = usable.filter((p) => strength[p] > 0.25).sort((a, b) => strength[b] - strength[a]);
  if (!periods.length) {
    // Generic search for the strongest local ACF peak. When calendar cycles were available and
    // none was significant, demand much stronger evidence so noise doesn't become "seasonality".
    const threshold = candidates.length ? 0.55 : 0.35;
    const maxLag = Math.min(400, Math.floor(y.length / 2.5));
    const r = [0, ...Array.from({ length: maxLag }, (_v, i) => acf(d, i + 1, m, v))];
    let bestP = 0;
    for (let p = 3; p < maxLag; p++) if (r[p] > r[p - 1] && r[p] >= r[p + 1] && r[p] > threshold && (!bestP || r[p] > r[bestP])) bestP = p;
    if (bestP) {
      strength[bestP] = r[bestP];
      periods = [bestP];
    }
  }
  return { periods, strength };
}

// ───────────── Selection & forecast ─────────────

export interface TsOptions {
  horizon: number;
  model?: TsModelId | 'auto';
  /** 'auto' (detect), 'none', or an explicit period in steps */
  seasonality?: 'auto' | 'none' | number;
  candidatesPeriods?: number[];
  confidence?: number;
  anomalies?: boolean;
  sensitivity?: 'low' | 'medium' | 'high';
}

export interface TsLeaderboardEntry {
  id: TsModelId;
  label: string;
  description: string;
  mase: number;
  smape: number;
  rmse: number;
}

export interface TsResult {
  model: TsModelId;
  label: string;
  period: number | null;
  seasonalStrength: number | null;
  leaderboard: TsLeaderboardEntry[];
  backtest: { horizon: number; origins: number };
  fitted: number[];
  forecast: { yhat: number; lower: number; upper: number }[];
  /** indices into the input series */
  anomalies: number[];
  /** Per-model forecasts (for comparison charts) — only when requested */
  alternatives?: Partial<Record<TsModelId, number[]>>;
  metrics: { mase: number; smape: number; rmse: number };
  confidence: number;
  /** % change of the forecast mean vs the mean of the last `horizon` actuals */
  trendPct: number | null;
}

export class TsError extends Error {}

/** Fits, backtests and forecasts a regularly spaced series `y`. */
export function forecastSeries(y: number[], opts: TsOptions, withAlternatives = false): TsResult {
  const n = y.length;
  if (n < 6) throw new TsError(`Need at least 6 points to forecast (have ${n})`);
  const horizon = Math.max(1, Math.min(opts.horizon, 2000));
  const conf = opts.confidence ?? 0.95;

  let periods: number[] = [];
  let strength: Record<number, number> = {};
  if (typeof opts.seasonality === 'number') periods = n >= 2 * opts.seasonality ? [opts.seasonality] : [];
  else if (opts.seasonality !== 'none') ({ periods, strength } = detectPeriods(y, opts.candidatesPeriods ?? []));

  const requested = opts.model && opts.model !== 'auto' ? opts.model : null;
  let pool = (Object.keys(FITTERS) as Exclude<TsModelId, 'ensemble'>[]).filter((id) => (periods.length ? true : !['seasonal_naive', 'holt_winters', 'holt_winters_mul'].includes(id)));
  if (requested && requested !== 'ensemble') pool = [requested];

  // Rolling-origin backtest
  const m = periods[0] ?? 1;
  const H = Math.max(1, Math.min(horizon, Math.floor(n / 4)));
  const minTrain = Math.max(8, periods.length ? 2 * m + 2 : 8);
  const origins = Math.max(0, Math.min(3, Math.floor((n - minTrain) / H)));
  const scaleDen = (() => {
    const lag = m > 1 && n > m + 1 ? m : 1;
    let s = 0;
    for (let i = lag; i < n; i++) s += Math.abs(y[i] - y[i - lag]);
    return s / (n - lag) || mean(y.map(Math.abs)) || 1;
  })();

  type Bt = { id: Exclude<TsModelId, 'ensemble'>; preds: number[][]; acts: number[][] };
  const bts: Bt[] = [];
  if (origins > 0) {
    for (const id of pool) {
      const preds: number[][] = [];
      const acts: number[][] = [];
      let ok = true;
      for (let o = origins; o >= 1; o--) {
        const end = n - o * H;
        const fit = safeFit(id, y.slice(0, end), periods);
        if (!fit) {
          ok = false;
          break;
        }
        const f = fit.forecast(H);
        if (f.some((v) => !Number.isFinite(v))) {
          ok = false;
          break;
        }
        preds.push(f);
        acts.push(y.slice(end, end + H));
      }
      if (ok) bts.push({ id, preds, acts });
    }
  }

  const score = (preds: number[][], acts: number[][]) => {
    const a = acts.flat();
    const p = preds.flat();
    const mae = mean(a.map((v, i) => Math.abs(v - p[i])));
    return { mase: mae / scaleDen, smape: smape(a, p), rmse: Math.sqrt(mean(a.map((v, i) => (v - p[i]) ** 2))) };
  };
  const board: TsLeaderboardEntry[] = bts.map((b) => ({ id: b.id, ...TS_MODEL_INFO[b.id], ...score(b.preds, b.acts) })).sort((a, b) => a.mase - b.mase);

  const top3 = board.slice(0, 3).map((b) => b.id as Exclude<TsModelId, 'ensemble'>);
  if (top3.length >= 2 && !requested) {
    const members = bts.filter((b) => top3.includes(b.id));
    const preds = members[0].preds.map((row, o) => row.map((_v, k) => mean(members.map((mm) => mm.preds[o][k]))));
    board.push({ id: 'ensemble', ...TS_MODEL_INFO.ensemble, ...score(preds, members[0].acts) });
    board.sort((a, b) => a.mase - b.mase);
  }

  let chosen: TsModelId = requested ?? board[0]?.id ?? (periods.length ? 'holt_winters' : 'holt');
  if (requested === 'ensemble' && top3.length < 2) chosen = board[0]?.id ?? 'holt';
  const members: Exclude<TsModelId, 'ensemble'>[] = chosen === 'ensemble' ? (requested ? board.filter((b) => b.id !== 'ensemble').slice(0, 3).map((b) => b.id as Exclude<TsModelId, 'ensemble'>) : top3) : [chosen as Exclude<TsModelId, 'ensemble'>];

  let fits = members.map((id) => safeFit(id, y, periods)).filter((f): f is Fit => !!f);
  if (!fits.length) {
    chosen = 'drift';
    fits = [drift(y, periods)!];
  }
  const fitted = y.map((_v, i) => mean(fits.map((f) => f.fitted[i])));
  const memberFc = fits.map((f) => f.forecast(horizon));
  const fc = Array.from({ length: horizon }, (_v, k) => mean(memberFc.map((f) => f[k])));

  // σ from in-sample one-step residuals, then calibrated against backtest errors
  const warm = Math.max(2, periods.length ? m : 2);
  const resid = y.map((v, i) => v - fitted[i]).filter((e, i) => i >= warm && Number.isFinite(e));
  const sigma = resid.length > 2 ? std(resid) : std(y) * 0.1;
  const varMult = (h: number) => mean(fits.map((f) => f.varMult(h)));
  const bt = board.find((b) => b.id === chosen);
  let calib = 1;
  if (bt && sigma > 0) {
    const implied = Math.sqrt(mean(Array.from({ length: H }, (_v, k) => varMult(k + 1)))) * sigma;
    calib = Math.min(3, Math.max(1, bt.rmse / implied));
  }
  const z = normInv(0.5 + conf / 2);
  const forecast = fc.map((yhat, k) => {
    const w = z * sigma * calib * Math.sqrt(varMult(k + 1));
    return { yhat, lower: yhat - w, upper: yhat + w };
  });

  // Robust anomaly detection on one-step residuals
  let anomalies: number[] = [];
  if (opts.anomalies) {
    const thr = { low: 4, medium: 3, high: 2.25 }[opts.sensitivity ?? 'medium'];
    const all = y.map((v, i) => (i >= warm ? v - fitted[i] : NaN));
    const finite = all.filter(Number.isFinite);
    const med = median(finite);
    const s = mad(finite, med) || std(finite) || 1;
    anomalies = all.map((e, i) => (Number.isFinite(e) && Math.abs(e - med) / s > thr ? i : -1)).filter((i) => i >= 0);
  }

  const lastMean = mean(y.slice(-Math.min(horizon, n)));
  const fcMean = mean(fc);
  const alternatives: Partial<Record<TsModelId, number[]>> | undefined = withAlternatives
    ? Object.fromEntries(
        board
          .filter((b) => b.id !== 'ensemble')
          .slice(0, 6)
          .map((b) => [b.id, safeFit(b.id as Exclude<TsModelId, 'ensemble'>, y, periods)?.forecast(horizon) ?? []]),
      )
    : undefined;

  const chosenScore = board.find((b) => b.id === chosen);
  return {
    model: chosen,
    label: TS_MODEL_INFO[chosen].label,
    period: periods[0] ?? null,
    seasonalStrength: periods[0] ? (strength[periods[0]] ?? null) : null,
    leaderboard: board,
    backtest: { horizon: H, origins },
    fitted,
    forecast,
    anomalies,
    alternatives,
    metrics: chosenScore ? { mase: chosenScore.mase, smape: chosenScore.smape, rmse: chosenScore.rmse } : { mase: NaN, smape: NaN, rmse: NaN },
    confidence: conf,
    trendPct: lastMean ? (100 * (fcMean - lastMean)) / Math.abs(lastMean) : null,
  };
}

function safeFit(id: Exclude<TsModelId, 'ensemble'>, y: number[], periods: number[]): Fit | null {
  try {
    const f = FITTERS[id](y, periods);
    if (!f) return null;
    const probe = f.forecast(1)[0];
    return Number.isFinite(probe) ? f : null;
  } catch {
    return null;
  }
}
