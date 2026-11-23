import { MODEL_IDS, MODEL_INFO, fitModel, linearCoefficients, predict, type ModelId, type SerializedModel } from './models';
import { encode, fitEncoder, profileColumns, round, toNumber, toTime, type ColumnKind, type ColumnProfile, type Encoder } from './preprocess';
import { median, pearson, quantile, regressionMetrics, rng, shuffle, type RegressionMetrics } from './stats';

type Row = Record<string, unknown>;

export interface TrainOptions {
  target: string;
  /** Defaults to every usable column except the target */
  features?: string[];
  models?: ModelId[];
  folds?: number;
  seed?: number;
}

export interface LeaderboardEntry extends RegressionMetrics {
  id: ModelId;
  label: string;
  family: string;
  description: string;
  trainMs: number;
  params?: Record<string, number>;
  /** Improvement in RMSE over the mean baseline, % */
  liftPct: number | null;
}

export interface ModelBundle {
  version: 1;
  modelId: ModelId;
  label: string;
  target: string;
  encoder: Encoder;
  model: SerializedModel;
  /** Split-conformal absolute residual quantiles from out-of-fold predictions */
  conformal: { q80: number; q90: number; q95: number };
  trainedAt: string;
}

export interface FeatureInput {
  name: string;
  kind: ColumnKind;
  default: string | number | null;
  min?: number;
  max?: number;
  options?: string[];
}

export interface TrainResult {
  target: string;
  rows: { total: number; used: number; cv: number };
  folds: number;
  features: FeatureInput[];
  excluded: { name: string; reason: string }[];
  warnings: string[];
  leaderboard: LeaderboardEntry[];
  best: ModelId;
  importance: { feature: string; importance: number; rmseIncrease: number }[];
  partialDependence: { feature: string; kind: 'numeric' | 'categorical'; points: { x: string | number; y: number }[] }[];
  coefficients: { name: string; coef: number }[] | null;
  diagnostics: {
    /** [actual, predicted] out-of-fold pairs for the best model (sampled) */
    actualVsPredicted: [number, number][];
    residualHistogram: { x0: number; x1: number; count: number }[];
  };
  targetStats: { mean: number; median: number; min: number; max: number };
  bundle: ModelBundle;
  durationMs: number;
}

const CV_MAX_ROWS = 4000;
const FIT_MAX_ROWS = 20_000;
const USABLE: ColumnKind[] = ['numeric', 'categorical', 'boolean', 'datetime'];

export class MlError extends Error {}

/** Trains and cross-validates every candidate model, then refits the winner on all data. */
export function trainRegression(allRows: Row[], columns: string[], opts: TrainOptions): TrainResult {
  const started = Date.now();
  const { target } = opts;
  if (!columns.includes(target)) throw new MlError(`Target column "${target}" is not in the result`);
  const rows = allRows.filter((r) => toNumber(r[target]) !== null);
  if (rows.length < 20) throw new MlError(`Need at least 20 rows with a numeric "${target}" (found ${rows.length}). Use a numeric target — booleans are treated as 0/1.`);

  const profiles = profileColumns(rows.slice(0, 5000), columns);
  const byName = new Map(profiles.map((p) => [p.name, p]));
  if (!['numeric', 'boolean'].includes(byName.get(target)!.kind)) throw new MlError(`Target "${target}" must be numeric (detected ${byName.get(target)!.kind})`);

  const excluded: { name: string; reason: string }[] = [];
  const warnings: string[] = [];
  const requested = opts.features?.length ? opts.features : columns.filter((c) => c !== target);
  const chosen: ColumnProfile[] = [];
  for (const name of requested) {
    if (name === target) continue;
    const p = byName.get(name);
    if (!p) excluded.push({ name, reason: 'not in result' });
    else if (!USABLE.includes(p.kind)) excluded.push({ name, reason: p.note ?? p.kind });
    else if (p.distinct <= 1) excluded.push({ name, reason: 'constant' });
    else if (p.completeness < 0.2) excluded.push({ name, reason: `${Math.round((1 - p.completeness) * 100)}% missing` });
    else chosen.push(p);
  }
  if (!chosen.length) throw new MlError('No usable feature columns. Add numeric, categorical, boolean or date columns to the query.');

  // Leakage heuristic: a feature that (almost) perfectly predicts the target is usually derived from it
  const yAll = rows.map((r) => toNumber(r[target])!);
  for (const p of chosen.filter((c) => c.kind === 'numeric')) {
    const x = rows.map((r) => toNumber(r[p.name]) ?? NaN);
    const ok = x.map((v, i) => [v, yAll[i]]).filter(([v]) => Number.isFinite(v));
    if (ok.length > 10 && Math.abs(pearson(ok.map((o) => o[0]), ok.map((o) => o[1]))) > 0.995)
      warnings.push(`"${p.name}" is almost perfectly correlated with "${target}" — check it isn't derived from the target (data leakage).`);
  }

  const seed = opts.seed ?? 42;
  const rand = rng(seed);
  const order = shuffle(
    Array.from({ length: rows.length }, (_v, i) => i),
    rand,
  );
  const fitRows = order.slice(0, FIT_MAX_ROWS).map((i) => rows[i]);
  const cvRows = fitRows.slice(0, CV_MAX_ROWS);
  if (rows.length > FIT_MAX_ROWS) warnings.push(`Trained on a random sample of ${FIT_MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} rows.`);

  const encoder = fitEncoder(fitRows, chosen.map((c) => ({ name: c.name, kind: c.kind })));
  const Xcv = encode(encoder, cvRows);
  const ycv = cvRows.map((r) => toNumber(r[target])!);
  const folds = Math.max(2, Math.min(opts.folds ?? 5, Math.floor(cvRows.length / 10)));
  const foldOf = cvRows.map((_r, i) => i % folds);

  const candidates = (opts.models?.length ? opts.models : [...MODEL_IDS]).filter((m) => MODEL_IDS.includes(m));
  if (!candidates.includes('baseline')) candidates.unshift('baseline');

  const oof = new Map<ModelId, number[]>();
  const board: LeaderboardEntry[] = [];
  for (const id of candidates) {
    const t0 = Date.now();
    const pred = new Array<number>(cvRows.length);
    let params: Record<string, number> | undefined;
    for (let k = 0; k < folds; k++) {
      const tr: number[] = [];
      const te: number[] = [];
      foldOf.forEach((f, i) => (f === k ? te : tr).push(i));
      const m = fitModel(id, tr.map((i) => Xcv[i]), tr.map((i) => ycv[i]), seed + k);
      params = (m as { params?: Record<string, number> }).params;
      const p = predict(m, te.map((i) => Xcv[i]));
      te.forEach((i, j) => (pred[i] = Number.isFinite(p[j]) ? p[j] : median(ycv)));
    }
    oof.set(id, pred);
    board.push({ id, ...MODEL_INFO[id], ...regressionMetrics(ycv, pred), trainMs: Date.now() - t0, params, liftPct: null });
  }
  const baseRmse = board.find((b) => b.id === 'baseline')!.rmse;
  for (const b of board) b.liftPct = baseRmse > 0 ? round((100 * (baseRmse - b.rmse)) / baseRmse, 1) : null;
  board.sort((a, b) => a.rmse - b.rmse);
  const best = board[0].id;
  if (best === 'baseline' || (board[0].r2 ?? 0) < 0.05)
    warnings.push('No model clearly beats the mean baseline — the features may not explain the target. Try adding more informative columns.');

  // Split-conformal intervals from the winner's out-of-fold residuals
  const bestOof = oof.get(best)!;
  const absRes = ycv.map((y, i) => Math.abs(y - bestOof[i]));
  const conformal = { q80: quantile(absRes, 0.8), q90: quantile(absRes, 0.9), q95: quantile(absRes, 0.95) };

  // Permutation importance on a holdout (model-agnostic, groups one-hot columns per source feature)
  const Xfit = encode(encoder, fitRows);
  const yfit = fitRows.map((r) => toNumber(r[target])!);
  const cut = Math.max(10, Math.floor(Xfit.length * 0.2));
  const hold = { X: Xfit.slice(0, cut), y: yfit.slice(0, cut) };
  const imModel = fitModel(best, Xfit.slice(cut), yfit.slice(cut), seed);
  const evalX = hold.X.slice(0, 1500);
  const evalY = hold.y.slice(0, 1500);
  const baseErr = regressionMetrics(evalY, predict(imModel, evalX)).rmse;
  const importance = encoder.specs.map((s, fi) => {
    const cols = encoder.source.map((src, j) => (src === fi ? j : -1)).filter((j) => j >= 0);
    let inc = 0;
    for (let rep = 0; rep < 2; rep++) {
      const perm = shuffle(
        evalX.map((_r, i) => i),
        rng(seed + 100 * fi + rep),
      );
      const Xp = evalX.map((r, i) => {
        const c = r.slice();
        for (const j of cols) c[j] = evalX[perm[i]][j];
        return c;
      });
      inc += regressionMetrics(evalY, predict(imModel, Xp)).rmse - baseErr;
    }
    return { feature: s.name, rmseIncrease: Math.max(0, inc / 2) };
  });
  const totalInc = importance.reduce((s, x) => s + x.rmseIncrease, 0) || 1;
  const importanceOut = importance
    .map((x) => ({ ...x, importance: round((100 * x.rmseIncrease) / totalInc, 1), rmseIncrease: round(x.rmseIncrease) }))
    .sort((a, b) => b.importance - a.importance);

  // Final model on all (sampled) rows
  const model = fitModel(best, Xfit, yfit, seed);

  // Partial dependence for the most important features
  const pdRows = fitRows.slice(0, 300);
  const partialDependence = importanceOut.slice(0, 4).flatMap((imp): TrainResult['partialDependence'] => {
    const spec = encoder.specs.find((s) => s.name === imp.feature)!;
    if (spec.kind === 'categorical') {
      const points = spec.levels.slice(0, 12).map((lvl) => ({ x: lvl, y: round(mean(predict(model, encode(encoder, pdRows.map((r) => ({ ...r, [spec.name]: lvl })))))) }));
      return [{ feature: spec.name, kind: 'categorical' as const, points }];
    }
    if (spec.kind === 'datetime') return [];
    const vals = fitRows.map((r) => toNumber(r[spec.name])).filter((v): v is number => v !== null);
    const grid = [...new Set(Array.from({ length: 20 }, (_v, i) => quantile(vals, 0.02 + (0.96 * i) / 19)))];
    const points = grid.map((g) => ({ x: round(g), y: round(mean(predict(model, encode(encoder, pdRows.map((r) => ({ ...r, [spec.name]: g }))))) ) }));
    return [{ feature: spec.name, kind: 'numeric' as const, points }];
  });

  // Diagnostics
  const residuals = ycv.map((y, i) => y - bestOof[i]);
  const avp: [number, number][] = ycv.slice(0, 600).map((y, i) => [round(y), round(bestOof[i])]);

  const features: FeatureInput[] = chosen.map((p) => {
    if (p.kind === 'numeric') return { name: p.name, kind: p.kind, default: round(p.stats!.median), min: p.stats!.min, max: p.stats!.max };
    if (p.kind === 'categorical' || p.kind === 'boolean') {
      const spec = encoder.specs.find((s) => s.name === p.name);
      const options = spec?.kind === 'categorical' ? spec.levels : (p.top ?? []).map((t) => t.value);
      return { name: p.name, kind: p.kind, default: options[0] ?? null, options };
    }
    return { name: p.name, kind: p.kind, default: p.range?.to ?? null };
  });

  const tsorted = Float64Array.from(yAll).sort();
  return {
    target,
    rows: { total: allRows.length, used: fitRows.length, cv: cvRows.length },
    folds,
    features,
    excluded,
    warnings,
    leaderboard: board.map((b) => ({ ...b, r2: round(b.r2), rmse: round(b.rmse), mae: round(b.mae), mape: b.mape === null ? null : round(b.mape, 2) })),
    best,
    importance: importanceOut,
    partialDependence,
    coefficients: linearCoefficients(model, encoder.columns)?.slice(0, 25).map((c) => ({ ...c, coef: round(c.coef) })) ?? null,
    diagnostics: { actualVsPredicted: avp, residualHistogram: histogram(residuals, 20) },
    targetStats: { mean: round(mean(yAll)), median: round(median(yAll)), min: tsorted[0], max: tsorted[tsorted.length - 1] },
    bundle: { version: 1, modelId: best, label: MODEL_INFO[best].label, target, encoder, model, conformal, trainedAt: new Date().toISOString() },
    durationMs: Date.now() - started,
  };
}

function mean(a: number[]) {
  return a.reduce((s, v) => s + v, 0) / (a.length || 1);
}

function histogram(values: number[], bins: number) {
  const lo = quantile(values, 0.01);
  const hi = quantile(values, 0.99);
  const w = (hi - lo) / bins || 1;
  const h = Array.from({ length: bins }, (_v, i) => ({ x0: round(lo + i * w), x1: round(lo + (i + 1) * w), count: 0 }));
  for (const v of values) h[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / w)))].count++;
  return h;
}

/** Predicts with a trained bundle; intervals are split-conformal (distribution-free). */
export function predictBundle(b: ModelBundle, inputs: Row[], confidence: 0.8 | 0.9 | 0.95 = 0.9) {
  const X = encode(b.encoder, inputs.map(coerceInput(b.encoder)));
  const preds = predict(b.model, X);
  const q = confidence === 0.8 ? b.conformal.q80 : confidence === 0.95 ? b.conformal.q95 : b.conformal.q90;
  return preds.map((p) => ({ prediction: round(p), lower: round(p - q), upper: round(p + q) }));
}

const coerceInput = (enc: Encoder) => (r: Row) => {
  const out: Row = { ...r };
  for (const s of enc.specs) {
    if (s.kind === 'datetime' && typeof out[s.name] === 'string' && toTime(out[s.name]) === null) out[s.name] = null;
  }
  return out;
};
