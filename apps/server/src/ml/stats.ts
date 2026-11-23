/**
 * Numerical primitives shared by the ML engine: descriptive statistics, error metrics,
 * a seeded RNG (reproducible models), the normal quantile function and a small
 * symmetric-positive-definite solver for normal equations.
 */

export function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : NaN;
}

export function variance(a: ArrayLike<number>, m = mean(a)): number {
  if (a.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return s / (a.length - 1);
}

export const std = (a: ArrayLike<number>) => Math.sqrt(variance(a));

export function quantile(a: ArrayLike<number>, q: number): number {
  const s = Float64Array.from(a).sort();
  if (!s.length) return NaN;
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (a: ArrayLike<number>) => quantile(a, 0.5);

/** Median absolute deviation, scaled to be a consistent estimator of σ for normal data. */
export function mad(a: ArrayLike<number>, m = median(a)): number {
  const dev = Array.from(a, (x) => Math.abs(x - m));
  return 1.4826 * median(dev);
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// ───────────── Metrics ─────────────

export interface RegressionMetrics {
  r2: number;
  rmse: number;
  mae: number;
  /** Mean absolute percentage error over non-zero actuals, in % (null when every actual is 0). */
  mape: number | null;
}

export function regressionMetrics(actual: ArrayLike<number>, pred: ArrayLike<number>): RegressionMetrics {
  const n = actual.length;
  const m = mean(actual);
  let sse = 0;
  let sst = 0;
  let sae = 0;
  let ape = 0;
  let apeN = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - pred[i];
    sse += e * e;
    sst += (actual[i] - m) ** 2;
    sae += Math.abs(e);
    if (Math.abs(actual[i]) > 1e-12) {
      ape += Math.abs(e / actual[i]);
      apeN++;
    }
  }
  return {
    r2: sst > 0 ? 1 - sse / sst : 0,
    rmse: Math.sqrt(sse / n),
    mae: sae / n,
    mape: apeN ? (100 * ape) / apeN : null,
  };
}

/** Symmetric MAPE in % (bounded 0–200, robust to zeros). */
export function smape(actual: ArrayLike<number>, pred: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i]) + Math.abs(pred[i]);
    s += d === 0 ? 0 : (2 * Math.abs(actual[i] - pred[i])) / d;
  }
  return (100 * s) / actual.length;
}

// ───────────── RNG ─────────────

/** mulberry32: tiny, fast, seedable PRNG so models are reproducible run-to-run. */
export function rng(seed = 42): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(a: T[], rand: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ───────────── Distributions ─────────────

/** Inverse standard-normal CDF (Acklam's rational approximation, |ε| < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ───────────── Linear algebra ─────────────

/**
 * Solves A·x = b for symmetric positive (semi-)definite A via Cholesky.
 * Adds escalating diagonal jitter when A is near-singular (collinear features).
 */
export function solveSPD(A: number[][], b: number[]): number[] {
  const n = b.length;
  let jitter = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const L = cholesky(A, jitter);
    if (L) {
      const z = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
        z[i] = s / L[i][i];
      }
      const x = new Array<number>(n);
      for (let i = n - 1; i >= 0; i--) {
        let s = z[i];
        for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
        x[i] = s / L[i][i];
      }
      return x;
    }
    const scale = Math.max(1e-12, ...A.map((r, i) => Math.abs(r[i])));
    jitter = jitter ? jitter * 10 : scale * 1e-10;
  }
  return new Array(n).fill(0);
}

function cholesky(A: number[][], jitter: number): number[][] | null {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j] + (i === j ? jitter : 0);
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

/** Ordinary / ridge least squares with an unpenalised intercept. X is row-major. */
export function leastSquares(X: number[][], y: number[], alpha = 0): { coef: number[]; intercept: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const xm = new Array<number>(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) xm[j] += r[j] / n;
  const ym = mean(y);
  const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) {
    const r = X[i];
    const yc = y[i] - ym;
    for (let j = 0; j < d; j++) {
      const xj = r[j] - xm[j];
      b[j] += xj * yc;
      const Aj = A[j];
      for (let k = 0; k <= j; k++) Aj[k] += xj * (r[k] - xm[k]);
    }
  }
  for (let j = 0; j < d; j++) {
    for (let k = 0; k < j; k++) A[k][j] = A[j][k];
    A[j][j] += alpha * n;
  }
  const coef = d ? solveSPD(A, b) : [];
  const intercept = ym - coef.reduce((s, c, j) => s + c * xm[j], 0);
  return { coef, intercept };
}

/** Nelder–Mead simplex minimiser for small, smooth, bounded-by-transform problems. */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { maxIter?: number; step?: number; tol?: number } = {}): number[] {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 200 * n;
  const step = opts.step ?? 0.5;
  const tol = opts.tol ?? 1e-7;
  let simplex = [x0, ...x0.map((_v, i) => x0.map((x, j) => (i === j ? x + step : x)))];
  let values = simplex.map(f);
  for (let it = 0; it < maxIter; it++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + tol)) break;
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const along = (t: number) => centroid.map((c, j) => c + t * (simplex[n][j] - c));
    const xr = along(-1);
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = along(-2);
      const fe = f(xe);
      [simplex[n], values[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [xr, fr];
    } else {
      const xc = fr < values[n] ? along(-0.5) : along(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, values[n])) [simplex[n], values[n]] = [xc, fc];
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  return simplex[values.indexOf(Math.min(...values))];
}

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => Math.log(p / (1 - p));
