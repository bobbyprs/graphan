import { leastSquares, mean, pearson, rng, shuffle } from './stats';
import { fitScaler, scale, type Scaler } from './preprocess';

/**
 * Regression model zoo. Every model trains on a numeric matrix and serialises to plain JSON,
 * so a trained model can be returned to the browser and sent back for what-if predictions
 * without server-side state (works behind any number of API replicas).
 */

export const MODEL_IDS = [
  'baseline',
  'linear',
  'ridge',
  'lasso',
  'elastic_net',
  'polynomial',
  'knn',
  'decision_tree',
  'random_forest',
  'gradient_boosting',
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const MODEL_INFO: Record<ModelId, { label: string; family: string; description: string }> = {
  baseline: { label: 'Mean baseline', family: 'Baseline', description: 'Always predicts the training mean — the bar every model must beat.' },
  linear: { label: 'Linear regression', family: 'Linear', description: 'Ordinary least squares on standardised features. Fast and fully interpretable.' },
  ridge: { label: 'Ridge', family: 'Linear', description: 'L2-regularised least squares; penalty tuned on a validation split. Robust to collinearity.' },
  lasso: { label: 'Lasso', family: 'Linear', description: 'L1-regularised regression (coordinate descent) that drives irrelevant coefficients to zero.' },
  elastic_net: { label: 'Elastic Net', family: 'Linear', description: 'Blend of L1 + L2 penalties: sparse like Lasso, stable like Ridge.' },
  polynomial: { label: 'Polynomial (deg 2)', family: 'Linear', description: 'Squares and pairwise interactions of the strongest features, fitted with Ridge.' },
  knn: { label: 'k-Nearest neighbours', family: 'Instance', description: 'Distance-weighted average of the k most similar rows; k tuned on validation.' },
  decision_tree: { label: 'Decision tree', family: 'Tree', description: 'Single CART regression tree with tuned depth. Captures thresholds and interactions.' },
  random_forest: { label: 'Random forest', family: 'Ensemble', description: 'Bagged, feature-subsampled trees averaged together. Strong default, hard to overfit.' },
  gradient_boosting: { label: 'Gradient boosting', family: 'Ensemble', description: 'Histogram-based boosted trees with shrinkage, subsampling and early stopping.' },
};

export interface Tree {
  /** split feature (−1 = leaf) */
  f: number[];
  /** split threshold: go left when x[f] <= t */
  t: number[];
  l: number[];
  r: number[];
  v: number[];
}

export type SerializedModel =
  | { kind: 'constant'; value: number }
  | { kind: 'linear'; scaler: Scaler; pairs?: [number, number][]; scaler2?: Scaler; coef: number[]; intercept: number; params?: Record<string, number> }
  | { kind: 'knn'; scaler: Scaler; X: number[][]; y: number[]; k: number }
  | { kind: 'trees'; trees: Tree[]; base: number; rate: number; mode: 'mean' | 'sum'; params?: Record<string, number> };

// ───────────── Prediction ─────────────

export function predict(m: SerializedModel, X: number[][]): number[] {
  switch (m.kind) {
    case 'constant':
      return X.map(() => m.value);
    case 'linear': {
      let Z = scale(m.scaler, X);
      if (m.pairs) Z = scale(m.scaler2!, expand(Z, m.pairs));
      return Z.map((r) => r.reduce((s, v, j) => s + v * m.coef[j], m.intercept));
    }
    case 'knn':
      return knnPredict(m, scale(m.scaler, X));
    case 'trees':
      return X.map((x) => {
        let s = 0;
        for (const t of m.trees) s += treePredict(t, x);
        return m.mode === 'mean' ? s / m.trees.length : m.base + m.rate * s;
      });
  }
}

function treePredict(t: Tree, x: number[]): number {
  let n = 0;
  while (t.f[n] >= 0) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
  return t.v[n];
}

// ───────────── Training ─────────────

export function fitModel(id: ModelId, X: number[][], y: number[], seed = 7): SerializedModel {
  switch (id) {
    case 'baseline':
      return { kind: 'constant', value: mean(y) };
    case 'linear':
      return fitLinear(X, y, 1e-8);
    case 'ridge':
      return tune(X, y, seed, [1e-3, 1e-2, 0.1, 1, 10], (Xt, yt, a) => fitLinear(Xt, yt, a), 'alpha');
    case 'lasso':
      return fitPenalised(X, y, 1, seed);
    case 'elastic_net':
      return fitPenalised(X, y, 0.5, seed);
    case 'polynomial':
      return fitPolynomial(X, y, seed);
    case 'knn':
      return fitKnn(X, y, seed);
    case 'decision_tree':
      return tune(X, y, seed, [3, 5, 8, 12], (Xt, yt, depth) => fitForest(Xt, yt, { trees: 1, depth, minLeaf: 5, featureFrac: 1, bootstrap: false, seed }), 'depth');
    case 'random_forest':
      return fitForest(X, y, { trees: X.length * (X[0]?.length ?? 1) > 400_000 ? 40 : 60, depth: 12, minLeaf: 3, featureFrac: 0.5, bootstrap: true, seed });
    case 'gradient_boosting':
      return fitBoosting(X, y, seed);
  }
}

/** Holdout split helper (80/20, seeded) */
function split(n: number, seed: number, frac = 0.2) {
  const idx = shuffle(
    Array.from({ length: n }, (_v, i) => i),
    rng(seed),
  );
  const cut = Math.max(1, Math.floor(n * frac));
  return { val: idx.slice(0, cut), train: idx.slice(cut) };
}

const pick = <T>(a: T[], idx: number[]) => idx.map((i) => a[i]);

function mse(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s / a.length;
}

/** Grid-searches one hyper-parameter on a validation split, then refits on all rows. */
function tune(X: number[][], y: number[], seed: number, grid: number[], fit: (X: number[][], y: number[], p: number) => SerializedModel, param: string): SerializedModel {
  let best = grid[0];
  if (X.length >= 30) {
    const { train, val } = split(X.length, seed);
    const Xt = pick(X, train);
    const yt = pick(y, train);
    const Xv = pick(X, val);
    const yv = pick(y, val);
    let bestErr = Infinity;
    for (const p of grid) {
      const err = mse(predict(fit(Xt, yt, p), Xv), yv);
      if (err < bestErr) [bestErr, best] = [err, p];
    }
  }
  const m = fit(X, y, best);
  (m as { params?: Record<string, number> }).params = { [param]: best };
  return m;
}

// ── Linear family ──

function fitLinear(X: number[][], y: number[], alpha: number): SerializedModel {
  const scaler = fitScaler(X);
  const { coef, intercept } = leastSquares(scale(scaler, X), y, alpha);
  return { kind: 'linear', scaler, coef, intercept };
}

/**
 * Elastic-net coordinate descent on standardised features with a warm-started alpha path;
 * alpha is chosen on a validation split. l1Ratio = 1 → Lasso.
 */
function fitPenalised(X: number[][], y: number[], l1Ratio: number, seed: number): SerializedModel {
  const scaler = fitScaler(X);
  const Z = scale(scaler, X);
  const d = Z[0]?.length ?? 0;
  const ym = mean(y);
  const maxCorr = Math.max(1e-12, ...Array.from({ length: d }, (_v, j) => Math.abs(Z.reduce((s, r, i) => s + r[j] * (y[i] - ym), 0)) / Z.length));
  const alphaMax = maxCorr / Math.max(l1Ratio, 1e-3);
  const path = Array.from({ length: 10 }, (_v, i) => alphaMax * 10 ** (-3 * (i / 9)));

  const run = (Zt: number[][], yt: number[], alphas: number[]) => {
    const n = Zt.length;
    const ymt = mean(yt);
    const cols = Array.from({ length: d }, (_v, j) => Float64Array.from(Zt, (r) => r[j]));
    const sq = cols.map((c) => c.reduce((s, v) => s + v * v, 0) / n);
    const b = new Float64Array(d);
    const resid = Float64Array.from(yt, (v) => v - ymt);
    const out: number[][] = [];
    for (const a of alphas) {
      for (let it = 0; it < 200; it++) {
        let maxDelta = 0;
        for (let j = 0; j < d; j++) {
          const c = cols[j];
          let rho = 0;
          for (let i = 0; i < n; i++) rho += c[i] * resid[i];
          rho = rho / n + sq[j] * b[j];
          const thr = a * l1Ratio;
          const nb = (Math.sign(rho) * Math.max(0, Math.abs(rho) - thr)) / (sq[j] + a * (1 - l1Ratio) || 1);
          const delta = nb - b[j];
          if (delta !== 0) {
            for (let i = 0; i < n; i++) resid[i] -= delta * c[i];
            b[j] = nb;
            maxDelta = Math.max(maxDelta, Math.abs(delta));
          }
        }
        if (maxDelta < 1e-6) break;
      }
      out.push(Array.from(b));
    }
    return { coefs: out, intercept: ymt };
  };

  let bestAlpha = path[path.length - 1];
  if (Z.length >= 30) {
    const { train, val } = split(Z.length, seed);
    const r = run(pick(Z, train), pick(y, train), path);
    const Zv = pick(Z, val);
    const yv = pick(y, val);
    let bestErr = Infinity;
    r.coefs.forEach((c, i) => {
      const err = mse(
        Zv.map((row) => row.reduce((s, v, j) => s + v * c[j], r.intercept)),
        yv,
      );
      if (err < bestErr) [bestErr, bestAlpha] = [err, path[i]];
    });
  }
  const full = run(Z, y, path.filter((a) => a >= bestAlpha));
  return { kind: 'linear', scaler, coef: full.coefs[full.coefs.length - 1], intercept: full.intercept, params: { alpha: bestAlpha, l1Ratio } };
}

function expand(Z: number[][], pairs: [number, number][]) {
  return Z.map((r) => [...r, ...pairs.map(([i, j]) => r[i] * r[j])]);
}

function fitPolynomial(X: number[][], y: number[], seed: number): SerializedModel {
  const scaler = fitScaler(X);
  const Z = scale(scaler, X);
  const d = Z[0]?.length ?? 0;
  // Interactions only among the 12 features most correlated with the target (keeps p manageable)
  const top = Array.from({ length: d }, (_v, j) => ({ j, c: Math.abs(pearson(Z.map((r) => r[j]), y)) || 0 }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 12)
    .map((x) => x.j);
  const pairs: [number, number][] = [];
  for (let a = 0; a < top.length; a++) for (let b = a; b < top.length; b++) pairs.push([top[a], top[b]]);
  const E = expand(Z, pairs);
  const scaler2 = fitScaler(E);
  const width = E[0]?.length ?? 0;
  const identity: Scaler = { mean: new Array(width).fill(0), scale: new Array(width).fill(1) };
  const inner = tune(scale(scaler2, E), y, seed, [1e-2, 0.1, 1, 10, 100], (Xt, yt, a) => {
    const { coef, intercept } = leastSquares(Xt, yt, a);
    return { kind: 'linear', scaler: identity, coef, intercept };
  }, 'alpha') as Extract<SerializedModel, { kind: 'linear' }>;
  return { kind: 'linear', scaler, pairs, scaler2, coef: inner.coef, intercept: inner.intercept, params: inner.params };
}

// ── k-NN ──

const KNN_MAX_STORED = 4000;

function fitKnn(X: number[][], y: number[], seed: number): SerializedModel {
  const scaler = fitScaler(X);
  let Z = scale(scaler, X);
  let yy = y;
  if (Z.length > KNN_MAX_STORED) {
    const idx = shuffle(
      Array.from({ length: Z.length }, (_v, i) => i),
      rng(seed),
    ).slice(0, KNN_MAX_STORED);
    Z = pick(Z, idx);
    yy = pick(y, idx);
  }
  let k = Math.max(3, Math.min(15, Math.round(Math.sqrt(Z.length) / 2)));
  if (Z.length >= 40) {
    const { train, val } = split(Z.length, seed);
    let bestErr = Infinity;
    for (const kk of [3, 5, 10, 20, 35].filter((v) => v < train.length)) {
      const m = { kind: 'knn' as const, scaler, X: pick(Z, train), y: pick(yy, train), k: kk };
      const err = mse(knnPredict(m, pick(Z, val)), pick(yy, val));
      if (err < bestErr) [bestErr, k] = [err, kk];
    }
  }
  return { kind: 'knn', scaler, X: Z, y: yy, k };
}

function knnPredict(m: Extract<SerializedModel, { kind: 'knn' }>, Q: number[][]): number[] {
  const k = Math.min(m.k, m.X.length);
  return Q.map((q) => {
    const bestD = new Float64Array(k).fill(Infinity);
    const bestY = new Float64Array(k);
    for (let i = 0; i < m.X.length; i++) {
      const x = m.X[i];
      let dist = 0;
      for (let j = 0; j < q.length && dist < bestD[k - 1]; j++) dist += (x[j] - q[j]) ** 2;
      if (dist >= bestD[k - 1]) continue;
      let p = k - 1;
      while (p > 0 && bestD[p - 1] > dist) {
        bestD[p] = bestD[p - 1];
        bestY[p] = bestY[p - 1];
        p--;
      }
      bestD[p] = dist;
      bestY[p] = m.y[i];
    }
    let w = 0;
    let s = 0;
    for (let i = 0; i < k; i++) {
      const wi = 1 / (Math.sqrt(bestD[i]) + 1e-6);
      w += wi;
      s += wi * bestY[i];
    }
    return s / w;
  });
}

// ── Histogram trees (shared by CART, random forest and gradient boosting) ──

interface Binned {
  n: number;
  d: number;
  /** column-major bin indices */
  bins: Uint8Array[];
  /** upper edge of each bin, per feature (last is +Infinity) */
  edges: number[][];
}

const MAX_BINS = 64;

function binData(X: number[][]): Binned {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const bins: Uint8Array[] = [];
  const edges: number[][] = [];
  for (let j = 0; j < d; j++) {
    const col = Float64Array.from(X, (r) => r[j]);
    const sorted = Float64Array.from(col).sort();
    const e: number[] = [];
    for (let b = 1; b < MAX_BINS; b++) {
      const v = sorted[Math.min(n - 1, Math.floor((b * n) / MAX_BINS))];
      if (!e.length || v > e[e.length - 1]) e.push(v);
    }
    // edges[b] is the max value in bin b: use midpoint to next distinct value as the split threshold
    const uniq = [...new Set(sorted)];
    const th = e
      .map((v) => {
        const k = uniq.indexOf(v);
        return k >= 0 && k < uniq.length - 1 ? (v + uniq[k + 1]) / 2 : Infinity;
      })
      .filter((v, i, a) => Number.isFinite(v) && (i === 0 || v > a[i - 1]));
    th.push(Infinity);
    const bj = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 0;
      let hi = th.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (col[i] <= th[mid]) hi = mid;
        else lo = mid + 1;
      }
      bj[i] = lo;
    }
    bins.push(bj);
    edges.push(th);
  }
  return { n, d, bins, edges };
}

interface TreeParams {
  depth: number;
  minLeaf: number;
  featureFrac: number;
  lambda: number;
  rand: () => number;
}

function buildTree(B: Binned, g: Float64Array, sample: Uint32Array, p: TreeParams): Tree {
  const t: Tree = { f: [], t: [], l: [], r: [], v: [] };
  const idx = Uint32Array.from(sample);
  const sums = new Float64Array(MAX_BINS);
  const cnts = new Uint32Array(MAX_BINS);
  const nFeat = Math.max(1, Math.round(B.d * p.featureFrac));
  const feats = Array.from({ length: B.d }, (_v, j) => j);

  const grow = (start: number, end: number, depth: number): number => {
    const id = t.f.length;
    t.f.push(-1);
    t.t.push(0);
    t.l.push(-1);
    t.r.push(-1);
    let sum = 0;
    for (let i = start; i < end; i++) sum += g[idx[i]];
    const n = end - start;
    t.v.push(sum / (n + p.lambda));
    if (depth >= p.depth || n < 2 * p.minLeaf) return id;

    const parentScore = (sum * sum) / (n + p.lambda);
    let bestGain = 1e-12;
    let bestF = -1;
    let bestB = -1;
    const cand = nFeat < B.d ? shuffle(feats.slice(), p.rand).slice(0, nFeat) : feats;
    for (const f of cand) {
      const nb = B.edges[f].length;
      if (nb < 2) continue;
      sums.fill(0, 0, nb);
      cnts.fill(0, 0, nb);
      const col = B.bins[f];
      for (let i = start; i < end; i++) {
        const b = col[idx[i]];
        sums[b] += g[idx[i]];
        cnts[b]++;
      }
      let sl = 0;
      let cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        sl += sums[b];
        cl += cnts[b];
        const cr = n - cl;
        if (cl < p.minLeaf) continue;
        if (cr < p.minLeaf) break;
        const sr = sum - sl;
        const gain = (sl * sl) / (cl + p.lambda) + (sr * sr) / (cr + p.lambda) - parentScore;
        if (gain > bestGain) [bestGain, bestF, bestB] = [gain, f, b];
      }
    }
    if (bestF < 0) return id;

    // partition idx[start:end) in place: left = bin <= bestB
    const col = B.bins[bestF];
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (col[idx[i]] <= bestB) i++;
      else {
        const tmp = idx[i];
        idx[i] = idx[j];
        idx[j] = tmp;
        j--;
      }
    }
    t.f[id] = bestF;
    t.t[id] = B.edges[bestF][bestB];
    t.l[id] = grow(start, i, depth + 1);
    t.r[id] = grow(i, end, depth + 1);
    return id;
  };
  grow(0, idx.length, 0);
  return t;
}

function fitForest(X: number[][], y: number[], o: { trees: number; depth: number; minLeaf: number; featureFrac: number; bootstrap: boolean; seed: number }): SerializedModel {
  const B = binData(X);
  const g = Float64Array.from(y);
  const rand = rng(o.seed);
  const trees: Tree[] = [];
  for (let k = 0; k < o.trees; k++) {
    const sample = o.bootstrap ? Uint32Array.from({ length: B.n }, () => Math.floor(rand() * B.n)) : Uint32Array.from({ length: B.n }, (_v, i) => i);
    trees.push(buildTree(B, g, sample, { depth: o.depth, minLeaf: o.minLeaf, featureFrac: o.featureFrac, lambda: 0, rand }));
  }
  return { kind: 'trees', trees, base: 0, rate: 1, mode: 'mean', params: { trees: o.trees, depth: o.depth } };
}

function fitBoosting(X: number[][], y: number[], seed: number): SerializedModel {
  const rate = 0.08;
  const depth = 4;
  const maxRounds = 400;
  const n = X.length;
  const minLeaf = Math.max(3, Math.floor(n / 300));
  const rand = rng(seed);

  const boost = (Xt: number[][], yt: number[], rounds: number, Xv?: number[][], yv?: number[]) => {
    const B = binData(Xt);
    const base = mean(yt);
    const F = new Float64Array(Xt.length).fill(base);
    const Fv = Xv ? new Float64Array(Xv.length).fill(base) : null;
    const trees: Tree[] = [];
    let bestErr = Infinity;
    let bestRound = rounds;
    const g = new Float64Array(Xt.length);
    for (let m = 0; m < rounds; m++) {
      for (let i = 0; i < Xt.length; i++) g[i] = yt[i] - F[i];
      const sample = Uint32Array.from({ length: Math.floor(Xt.length * 0.8) }, () => Math.floor(rand() * Xt.length));
      const tree = buildTree(B, g, sample, { depth, minLeaf, featureFrac: 0.8, lambda: 1, rand });
      trees.push(tree);
      for (let i = 0; i < Xt.length; i++) F[i] += rate * treePredict(tree, Xt[i]);
      if (Xv && Fv && yv) {
        let err = 0;
        for (let i = 0; i < Xv.length; i++) {
          Fv[i] += rate * treePredict(tree, Xv[i]);
          err += (yv[i] - Fv[i]) ** 2;
        }
        if (err < bestErr - 1e-12) [bestErr, bestRound] = [err, m + 1];
        else if (m + 1 - bestRound >= 30) break;
      }
    }
    return { trees: trees.slice(0, bestRound), base, bestRound };
  };

  let rounds = 150;
  if (n >= 50) {
    const { train, val } = split(n, seed, 0.15);
    rounds = boost(pick(X, train), pick(y, train), maxRounds, pick(X, val), pick(y, val)).bestRound;
  }
  const final = boost(X, y, Math.max(10, Math.round(rounds * 1.1)));
  return { kind: 'trees', trees: final.trees, base: final.base, rate, mode: 'sum', params: { rounds: final.trees.length, depth, learningRate: rate } };
}

/** Linear coefficients mapped to encoded column names (for the "explain" view). */
export function linearCoefficients(m: SerializedModel, columns: string[]): { name: string; coef: number }[] | null {
  if (m.kind !== 'linear' || m.pairs) return null;
  // coefficients are per standard deviation of the input: comparable across features
  return m.coef.map((c, j) => ({ name: columns[j], coef: c })).sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));
}
