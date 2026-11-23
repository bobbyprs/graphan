import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, parsePagination } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Permissions } from '../../lib/rbac';
import { prisma } from '../../lib/prisma';
import { NotFound } from '../../lib/errors';
import { dataSourcesService } from '../datasources/datasources.service';
import { audit } from '../audit/audit.service';
import { executeQuery, explainQuery } from './query.service';
import { applyTransforms, transformSchema } from './transforms';
import { sendExport } from './export';
import { parseTimeRange } from '../../lib/time';

/** Accepts relative expressions (now-24h, now/d) as well as ISO dates / epoch millis. */
const timeRangeSchema = z
  .object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) })
  .transform((r, ctx) => {
    try {
      return parseTimeRange(r);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  });

const executeSchema = z.object({
  dataSourceId: z.string().uuid(),
  sql: z.string().min(1).max(200_000),
  timeRange: timeRangeSchema.optional(),
  variables: z.record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))])).optional(),
  maxRows: z.number().int().positive().max(100_000).optional(),
  transforms: transformSchema.partial().optional(),
});

const exportSchema = executeSchema.extend({
  format: z.enum(['csv', 'json', 'xlsx']),
  fileName: z.string().max(100).optional(),
});

const savedSchema = z.object({
  dataSourceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  sql: z.string().min(1).max(200_000),
  isFavorite: z.boolean().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const queriesRouter = Router();

queriesRouter.post(
  '/execute',
  requirePermission(Permissions.QUERY_EXECUTE),
  validate(executeSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof executeSchema>;
    const ds = await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
    const result = await executeQuery(ds, b.sql, {
      ctx: { timeRange: b.timeRange, variables: b.variables },
      maxRows: b.maxRows,
      recordHistory: true,
      user: { id: req.user!.id, role: req.workspace!.role },
      signal: abortOnDisconnect(req, res),
    });
    res.json(applyTransforms(result, b.transforms));
  }),
);

/** Aborts when the client goes away (cancel button / closed tab) so the DB stops working too. */
function abortOnDisconnect(req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  req.on('aborted', () => ac.abort());
  return ac.signal;
}

const explainSchema = z.object({
  dataSourceId: z.string().uuid(),
  sql: z.string().min(1).max(200_000),
  analyze: z.boolean().default(false),
  timeRange: timeRangeSchema.optional(),
  variables: executeSchema.shape.variables,
});

queriesRouter.post(
  '/explain',
  requirePermission(Permissions.QUERY_EXECUTE),
  validate(explainSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof explainSchema>;
    const ds = await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
    res.json(
      await explainQuery(ds, b.sql, b.analyze, {
        ctx: { timeRange: b.timeRange, variables: b.variables },
        user: { id: req.user!.id, role: req.workspace!.role },
        signal: abortOnDisconnect(req, res),
      }),
    );
  }),
);

queriesRouter.post(
  '/export',
  requirePermission(Permissions.QUERY_EXECUTE),
  validate(exportSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof exportSchema>;
    const ds = await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
    const result = applyTransforms(
      await executeQuery(ds, b.sql, {
        ctx: { timeRange: b.timeRange, variables: b.variables },
        maxRows: b.maxRows ?? 100_000,
        user: { id: req.user!.id, role: req.workspace!.role },
      }),
      b.transforms,
    );
    audit(req, { action: 'query.export', entityType: 'datasource', entityId: ds.id, metadata: { format: b.format, rows: result.rowCount } });
    await sendExport(res, result, b.format, b.fileName);
  }),
);

queriesRouter.get(
  '/history',
  requirePermission(Permissions.QUERY_EXECUTE),
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 50, max: 200 });
    const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : undefined;
    const items = await prisma.queryHistory.findMany({
      where: { userId: req.user!.id, dataSource: { workspaceId: req.workspace!.id }, dataSourceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: { dataSource: { select: { id: true, name: true, type: true } } },
    });
    res.json({ items });
  }),
);

queriesRouter.delete(
  '/history',
  requirePermission(Permissions.QUERY_EXECUTE),
  asyncHandler(async (req, res) => {
    await prisma.queryHistory.deleteMany({ where: { userId: req.user!.id, dataSource: { workspaceId: req.workspace!.id } } });
    res.status(204).end();
  }),
);

// ── Saved queries ──

queriesRouter.get(
  '/saved',
  requirePermission(Permissions.QUERY_EXECUTE),
  asyncHandler(async (req, res) => {
    const favoritesOnly = req.query.favorites === '1';
    res.json(
      await prisma.savedQuery.findMany({
        where: { workspaceId: req.workspace!.id, ownerId: req.user!.id, isFavorite: favoritesOnly ? true : undefined },
        orderBy: [{ isFavorite: 'desc' }, { updatedAt: 'desc' }],
        include: { dataSource: { select: { id: true, name: true, type: true } } },
      }),
    );
  }),
);

queriesRouter.post(
  '/saved',
  requirePermission(Permissions.QUERY_EXECUTE),
  validate(savedSchema),
  asyncHandler(async (req, res) => {
    await dataSourcesService.get(req.workspace!.id, req.body.dataSourceId);
    res.status(201).json(await prisma.savedQuery.create({ data: { ...req.body, workspaceId: req.workspace!.id, ownerId: req.user!.id } }));
  }),
);

queriesRouter.put(
  '/saved/:id',
  requirePermission(Permissions.QUERY_EXECUTE),
  validate(savedSchema.partial()),
  asyncHandler(async (req, res) => {
    const q = await prisma.savedQuery.findFirst({ where: { id: req.params.id, ownerId: req.user!.id, workspaceId: req.workspace!.id } });
    if (!q) throw NotFound('Saved query');
    res.json(await prisma.savedQuery.update({ where: { id: q.id }, data: req.body }));
  }),
);

queriesRouter.delete(
  '/saved/:id',
  requirePermission(Permissions.QUERY_EXECUTE),
  asyncHandler(async (req, res) => {
    const { count } = await prisma.savedQuery.deleteMany({ where: { id: req.params.id, ownerId: req.user!.id, workspaceId: req.workspace!.id } });
    if (!count) throw NotFound('Saved query');
    res.status(204).end();
  }),
);
