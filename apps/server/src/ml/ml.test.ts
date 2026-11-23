import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainRegression, predictBundle } from './automl';
import { fitModel, predict, type ModelId } from './models';
import { forecastSeries, detectPeriods } from './timeseries';
import { applyForecast, forecastConfigSchema, FC } from './forecast';
import { applyTransforms } from '../modules/queries/transforms';
import { regressionMetrics, rng } from './stats';

const rand = rng(1);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function linearData(n: number) {
  return Array.from({ length: n }, () => {
    const a = rand() * 10;
    const b = rand() * 5;
    const seg = ['A', 'B', 'C'][Math.floor(rand() * 3)];
    return { a, b, seg, id: 0, y: 3 * a - 2 * b + (seg === 'B' ? 10 : 0) + 5 + gauss() * 0.5 };
  }).map((r, i) => ({ ...r, id: i + 1 }));
}

test('ml: linear family recovers a linear signal with categorical effect', () => {
  const rows = linearData(800);
  const r = trainRegression(rows, ['id', 'a', 'b', 'seg', 'y'], { target: 'y', models: ['linear', 'ridge', 'lasso', 'random_forest'] });
  const lin = r.leaderboard.find((l) => l.id === 'linear')!;
  assert.ok(lin.r2 > 0.99, `linear r2 ${lin.r2}`);
  assert.ok(['linear', 'ridge', 'lasso'].includes(r.best), `best ${r.best}`);
  assert.ok(r.excluded.some((e) => e.name === 'id'), 'identifier excluded');
  assert.equal(r.importance[0].feature, 'a');
  const [p] = predictBundle(r.bundle, [{ a: 2, b: 1, seg: 'B' }]);
  assert.ok(Math.abs(p.prediction - (6 - 2 + 10 + 5)) < 0.6, `pred ${p.prediction}`);
  assert.ok(p.lower < p.prediction && p.upper > p.prediction);
});

test('ml: tree ensembles capture non-linear interactions', () => {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const a = rand() * 6 - 3;
    const b = rand() * 6 - 3;
    X.push([a, b, rand()]);
    y.push(Math.sin(2 * a) * 4 + (b > 0 ? b * b : -b) + gauss() * 0.3);
  }
  const Xt = X.slice(0, 1200);
  const yt = y.slice(0, 1200);
  const score = (id: ModelId) => regressionMetrics(y.slice(1200), predict(fitModel(id, Xt, yt), X.slice(1200))).r2;
  const lin = score('linear');
  const gbm = score('gradient_boosting');
  const rf = score('random_forest');
  const knn = score('knn');
  assert.ok(gbm > 0.9, `gbm r2 ${gbm}`);
  assert.ok(rf > 0.85, `rf r2 ${rf}`);
  assert.ok(knn > 0.8, `knn r2 ${knn}`);
  assert.ok(gbm > lin + 0.3, `gbm ${gbm} vs linear ${lin}`);
});

test('ml: models serialise to JSON and predict identically', () => {
  const rows = linearData(200);
  const X = rows.map((r) => [r.a, r.b]);
  const y = rows.map((r) => r.y);
  for (const id of ['ridge', 'polynomial', 'gradient_boosting', 'knn'] as ModelId[]) {
    const m = fitModel(id, X, y);
    const copy = JSON.parse(JSON.stringify(m));
    assert.deepEqual(predict(copy, X.slice(0, 5)), predict(m, X.slice(0, 5)), id);
  }
});

function seasonal(n: number, period: number, noise = 1) {
  return Array.from({ length: n }, (_v, i) => 50 + 0.05 * i + 10 * Math.sin((2 * Math.PI * i) / period) + gauss() * noise);
}

test('timeseries: detects seasonality and beats naive', () => {
  const y = seasonal(24 * 21, 24);
  assert.deepEqual(detectPeriods(y, [24, 168]).periods[0], 24);
  const r = forecastSeries(y, { horizon: 48, candidatesPeriods: [24, 168] });
  assert.equal(r.period, 24);
  assert.ok(r.metrics.mase < 1, `mase ${r.metrics.mase} (${r.model})`);
  assert.equal(r.forecast.length, 48);
  // prediction interval widens with horizon and brackets the point forecast
  assert.ok(r.forecast[47].upper - r.forecast[47].lower >= r.forecast[0].upper - r.forecast[0].lower);
  const truth = Array.from({ length: 48 }, (_v, k) => 50 + 0.05 * (y.length + k) + 10 * Math.sin((2 * Math.PI * (y.length + k)) / 24));
  const covered = truth.filter((t, k) => t >= r.forecast[k].lower && t <= r.forecast[k].upper).length;
  assert.ok(covered >= 40, `interval coverage ${covered}/48`);
});

test('timeseries: anomaly detection flags injected spikes only', () => {
  const y = seasonal(300, 12, 0.5);
  y[150] += 25;
  y[220] -= 25;
  const r = forecastSeries(y, { horizon: 5, candidatesPeriods: [12], anomalies: true, sensitivity: 'medium' });
  assert.ok(r.anomalies.includes(150) && r.anomalies.includes(220), JSON.stringify(r.anomalies));
  assert.ok(r.anomalies.length <= 8, `too many anomalies ${r.anomalies.length}`);
});

test('forecast transform: monthly calendar steps and output columns', () => {
  const rows = Array.from({ length: 36 }, (_v, i) => ({
    month: new Date(Date.UTC(2023, i, 1)).toISOString().slice(0, 10),
    revenue: 1000 + 20 * i + 150 * Math.sin((2 * Math.PI * i) / 12),
  }));
  const out = applyForecast(
    { columns: [{ name: 'month', type: 'date' }, { name: 'revenue', type: 'number' }], rows, rowCount: 36, truncated: false, durationMs: 1 },
    forecastConfigSchema.parse({ horizon: 6 }),
  );
  const future = out.rows.filter((r) => r[FC.future]);
  assert.equal(future.length, 6);
  assert.equal(future[0].month, '2026-01-01');
  assert.equal(future[5].month, '2026-06-01');
  assert.ok(typeof future[0][FC.forecast('revenue')] === 'number');
  assert.equal(out.meta?.forecast?.[0].period, 12);
  assert.equal(out.meta?.forecast?.[0].step, '1 month');
  // bridge point: last actual row starts the forecast line
  assert.equal(out.rows[35][FC.forecast('revenue')], rows[35].revenue);
});

test('forecast transform: runs via applyTransforms and survives bad input', () => {
  const r = applyTransforms(
    { columns: [{ name: 'x', type: 'text' }, { name: 'v', type: 'number' }], rows: [{ x: 'a', v: 1 }, { x: 'b', v: 2 }], rowCount: 2, truncated: false, durationMs: 1 },
    { forecast: forecastConfigSchema.parse({ horizon: 3 }) },
  );
  assert.equal(r.rows.length, 2, 'too-short series is returned unchanged');
  assert.ok(r.meta?.forecast?.[0].error);
});

test('ml: training 5k rows × 8 features finishes quickly', () => {
  const rows = Array.from({ length: 5000 }, () => {
    const f = Array.from({ length: 6 }, () => rand());
    return { f0: f[0], f1: f[1], f2: f[2], f3: f[3], f4: f[4], f5: f[5], cat: ['x', 'y', 'z', 'w'][Math.floor(rand() * 4)], ts: new Date(Date.UTC(2024, 0, 1) + rand() * 3e10).toISOString(), y: f[0] * 10 + f[1] * f[2] * 5 + gauss() };
  });
  const t0 = Date.now();
  const r = trainRegression(rows, Object.keys(rows[0]), { target: 'y' });
  const ms = Date.now() - t0;
  assert.ok(r.leaderboard.length === 10, 'all models evaluated');
  assert.ok(r.leaderboard[0].r2 > 0.85, `best r2 ${r.leaderboard[0].r2}`);
  assert.ok(ms < 45_000, `took ${ms} ms`);
  console.log(`  5k-row AutoML: ${ms} ms, best=${r.best} r2=${r.leaderboard[0].r2}`, r.leaderboard.map((l) => `${l.id}:${l.trainMs}ms`).join(' '));
});

test('forecast transform: an in-progress last bucket is held out and forecast', () => {
  const day = 864e5;
  const today = Math.floor(Date.now() / day) * day;
  const rows = Array.from({ length: 40 }, (_v, i) => ({ time: new Date(today - (39 - i) * day).toISOString(), revenue: 1000 + 5 * i }));
  rows[39].revenue = 40; // only a few hours of today so far
  const out = applyForecast(
    { columns: [{ name: 'time', type: 'timestamp' }, { name: 'revenue', type: 'number' }], rows, rowCount: 40, truncated: false, durationMs: 1 },
    forecastConfigSchema.parse({ horizon: 5, anomalies: true }),
  );
  const m = out.meta!.forecast![0];
  assert.equal(m.partial, true);
  assert.equal(m.last, 1000 + 5 * 38, 'last complete period');
  assert.ok(m.next!.yhat > 1150, `today should be forecast near trend, got ${m.next!.yhat}`);
  const todayRow = out.rows.find((r) => r.__partial)!;
  assert.ok((todayRow[FC.forecast('revenue')] as number) > 1150);
  assert.ok(todayRow[FC.anomaly('revenue')] == null, 'partial bucket is not an anomaly');
  assert.equal(out.rows.filter((r) => r[FC.future]).length, 5);
  assert.ok(out.rows.every((r) => r[FC.lower('revenue')] == null || (r[FC.lower('revenue')] as number) >= 0), 'non-negative series → non-negative interval');
});

test('forecast transform: truncated final bucket in historical data is detected; normal endings are not', () => {
  const mk = (lastValue: number) =>
    applyForecast(
      {
        columns: [{ name: 'time', type: 'timestamp' }, { name: 'v', type: 'number' }],
        rows: Array.from({ length: 30 }, (_v, i) => ({ time: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), v: i === 29 ? lastValue : 500 + (i % 7) * 10 })),
        rowCount: 30,
        truncated: false,
        durationMs: 1,
      },
      forecastConfigSchema.parse({ horizon: 3 }),
    ).meta!.forecast![0];
  assert.equal(mk(60).partial, true, 'collapse to 12% of normal → incomplete');
  assert.equal(mk(480).partial, false, 'ordinary last value is trained on');
});
