import { Router, type Request } from 'express';
import { z } from 'zod';
import { LRUCache } from 'lru-cache';
import type { Prisma } from '@prisma/client';
import { asyncHandler } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Permissions } from '../../lib/rbac';
import { prisma } from '../../lib/prisma';
import { BadRequest, NotFound } from '../../lib/errors';
import { parseTimeRange } from '../../lib/time';
import { poolManager } from '../../connectors/pool-manager';
import { dataSourcesService } from '../datasources/datasources.service';
import { audit } from '../audit/audit.service';
import { executeQuery } from '../queries/query.service';
import { applyTransforms } from '../queries/transforms';
import { MlError, predictBundle, type ModelBundle, type TrainResult } from '../../ml/automl';
import { MODEL_IDS, MODEL_INFO } from '../../ml/models';
import { correlationMatrix, profileColumns } from '../../ml/preprocess';
import { forecastConfigSchema } from '../../ml/forecast';
import { TS_MODEL_INFO, TsError } from '../../ml/timeseries';
import { runTask } from '../../ml/runner';
import { suggestDashboard } from '../../ml/auto-dashboard';

const TRAIN_MAX_ROWS = 50_000;

const varValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]);
const sourceSchema = z.object({
  dataSourceId: z.string().uuid(),
  sql: z.string().min(1).max(200_000),
  timeRange: z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).optional(),
  variables: z.record(varValue).optional(),
});

const trainSchema = sourceSchema.extend({
  target: z.string().min(1).max(200),
  features: z.array(z.string().max(200)).max(200).optional(),
  models: z.array(z.enum(MODEL_IDS)).max(MODEL_IDS.length).optional(),
  folds: z.number().int().min(2).max(10).optional(),
  name: z.string().max(200).optional(),
});

const forecastSchema = sourceSchema.extend({ forecast: forecastConfigSchema });

const predictSchema = z.object({
  inputs: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(1000),
  confidence: z.union([z.literal(0.8), z.literal(0.9), z.literal(0.95)]).default(0.9),
});

const autoDashboardSchema = z.object({ dataSourceId: z.string().uuid(), schema: z.string().max(200), table: z.string().min(1).max(200) });

/** Bundles are read on every what-if call; keep recent ones in memory. */
const bundleCache = new LRUCache<string, ModelBundle>({ max: 50, ttl: 30 * 60_000 });

async function runSource(req: Request, b: z.infer<typeof sourceSchema>, maxRows: number) {
  const ds = await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
  let timeRange;
  try {
    timeRange = b.timeRange ? parseTimeRange(b.timeRange) : undefined;
  } catch (e) {
    throw BadRequest((e as Error).message);
  }
  const result = await executeQuery(ds, b.sql, { ctx: { timeRange, variables: b.variables }, maxRows, user: { id: req.user!.id, role: req.workspace!.role } });
  return { ds, result };
}

const toBadRequest = (e: unknown) => (e instanceof MlError || e instanceof TsError ? BadRequest(e.message) : e);

export const mlRouter = Router();
mlRouter.use(requirePermission(Permissions.QUERY_EXECUTE));

/** Algorithm catalogue for the UI */
mlRouter.get('/algorithms', (_req, res) => {
  res.json({
    regression: MODEL_IDS.map((id) => ({ id, ...MODEL_INFO[id] })),
    forecasting: Object.entries(TS_MODEL_INFO).map(([id, v]) => ({ id, ...v })),
  });
});

/** Column profiling: types, completeness, distributions, correlations and modelling suggestions. */
mlRouter.post(
  '/profile',
  validate(sourceSchema),
  asyncHandler(async (req, res) => {
    const { result } = await runSource(req, req.body, TRAIN_MAX_ROWS);
    const columns = result.columns.map((c) => c.name);
    const sample = result.rows.slice(0, 10_000);
    const profiles = profileColumns(sample, columns);
    const numeric = profiles.filter((p) => p.kind === 'numeric').map((p) => p.name).slice(0, 20);
    const timeField = profiles.find((p) => p.kind === 'datetime')?.name ?? null;
    // Suggest the numeric column that is best explained by the others as the default target
    const corr = correlationMatrix(sample, numeric);
    const targets = numeric
      .map((n, i) => ({ n, s: corr[i].reduce((a, v, j) => (i === j ? a : a + Math.abs(v)), 0) + (/(amount|revenue|price|total|sales|cost|value|score|latency)/i.test(n) ? 1 : 0) }))
      .sort((a, b) => b.s - a.s)
      .map((t) => t.n);
    res.json({
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: result.durationMs,
      columns: profiles,
      correlations: { fields: numeric, matrix: corr },
      suggestions: { targets, timeField, forecastFields: numeric.slice(0, 3) },
      preview: { columns: result.columns, rows: result.rows.slice(0, 50) },
    });
  }),
);

/** Trains every candidate regressor with k-fold CV and saves the winner to the model registry. */
mlRouter.post(
  '/train',
  validate(trainSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof trainSchema>;
    const { ds, result } = await runSource(req, b, TRAIN_MAX_ROWS);
    let report: TrainResult;
    try {
      report = await runTask('train', {
        rows: result.rows,
        columns: result.columns.map((c) => c.name),
        options: { target: b.target, features: b.features, models: b.models, folds: b.folds },
      });
    } catch (e) {
      throw toBadRequest(e);
    }
    if (result.truncated) report.warnings.unshift(`Query returned more than ${TRAIN_MAX_ROWS.toLocaleString()} rows; only the first ${TRAIN_MAX_ROWS.toLocaleString()} were used.`);
    const { bundle, ...summary } = report;
    const best = summary.leaderboard.find((l) => l.id === summary.best)!;
    const saved = await prisma.mlModel.create({
      data: {
        workspaceId: req.workspace!.id,
        ownerId: req.user!.id,
        dataSourceId: ds.id,
        name: b.name?.trim() || `Predict ${b.target} · ${best.label}`,
        target: b.target,
        algorithm: summary.best,
        sql: b.sql,
        metrics: { r2: best.r2, rmse: best.rmse, mae: best.mae, mape: best.mape } as Prisma.InputJsonValue,
        report: summary as unknown as Prisma.InputJsonValue,
        bundle: bundle as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, name: true, createdAt: true },
    });
    bundleCache.set(saved.id, bundle);
    audit(req, { action: 'ml.train', entityType: 'ml_model', entityId: saved.id, metadata: { target: b.target, algorithm: summary.best, rows: summary.rows.used } });
    res.json({ model: saved, ...summary });
  }),
);

/** Forecast preview for ML Studio — identical to the panel transform so "Add to dashboard" is WYSIWYG. */
mlRouter.post(
  '/forecast',
  validate(forecastSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof forecastSchema>;
    const { result } = await runSource(req, b, 100_000);
    res.json(applyTransforms(result, { forecast: { ...b.forecast, enabled: true } }));
  }),
);

mlRouter.post(
  '/auto-dashboard',
  requirePermission(Permissions.EXPLORER_READ),
  validate(autoDashboardSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof autoDashboardSchema>;
    const ds = await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
    if (ds.type === 'MONGODB') throw BadRequest('Auto-dashboards currently support SQL data sources');
    const connector = await poolManager.get(ds);
    const details = await connector.describeTable(b.schema, b.table);
    if (!details.columns.length) throw NotFound('Table');
    const sample = await connector.previewTable(b.schema, b.table, 2000, 0, { maxRows: 2000, timeoutMs: 30_000 });
    res.json(suggestDashboard(connector, ds.id, details, sample.rows));
  }),
);

// ───────────── Model registry ─────────────

const listSelect = {
  id: true,
  name: true,
  target: true,
  algorithm: true,
  metrics: true,
  createdAt: true,
  dataSource: { select: { id: true, name: true, type: true } },
  owner: { select: { id: true, name: true } },
} as const;

mlRouter.get(
  '/models',
  asyncHandler(async (req, res) => {
    res.json(await prisma.mlModel.findMany({ where: { workspaceId: req.workspace!.id }, orderBy: { createdAt: 'desc' }, take: 200, select: listSelect }));
  }),
);

async function findModel(req: Request) {
  const m = await prisma.mlModel.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
  if (!m) throw NotFound('Model');
  return m;
}

mlRouter.get(
  '/models/:id',
  asyncHandler(async (req, res) => {
    const m = await findModel(req);
    res.json({ id: m.id, name: m.name, target: m.target, algorithm: m.algorithm, sql: m.sql, dataSourceId: m.dataSourceId, createdAt: m.createdAt, model: { id: m.id, name: m.name, createdAt: m.createdAt }, ...(m.report as object) });
  }),
);

mlRouter.patch(
  '/models/:id',
  validate(z.object({ name: z.string().min(1).max(200) })),
  asyncHandler(async (req, res) => {
    await findModel(req);
    res.json(await prisma.mlModel.update({ where: { id: req.params.id }, data: { name: req.body.name }, select: listSelect }));
  }),
);

mlRouter.delete(
  '/models/:id',
  asyncHandler(async (req, res) => {
    await findModel(req);
    await prisma.mlModel.delete({ where: { id: req.params.id } });
    bundleCache.delete(req.params.id);
    audit(req, { action: 'ml.delete', entityType: 'ml_model', entityId: req.params.id });
    res.status(204).end();
  }),
);

/** What-if predictions with split-conformal prediction intervals. */
mlRouter.post(
  '/models/:id/predict',
  validate(predictSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof predictSchema>;
    let bundle = bundleCache.get(req.params.id);
    if (!bundle) {
      const m = await prisma.mlModel.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id }, select: { bundle: true } });
      if (!m) throw NotFound('Model');
      bundle = m.bundle as unknown as ModelBundle;
      bundleCache.set(req.params.id, bundle);
    } else {
      // cached bundles are workspace-agnostic; re-check ownership cheaply
      const exists = await prisma.mlModel.count({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
      if (!exists) throw NotFound('Model');
    }
    res.json({ target: bundle.target, confidence: b.confidence, predictions: predictBundle(bundle, b.inputs, b.confidence) });
  }),
);
