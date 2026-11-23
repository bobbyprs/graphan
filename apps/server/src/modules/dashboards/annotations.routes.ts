import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { Permissions } from '../../lib/rbac';
import { prisma } from '../../lib/prisma';
import { NotFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';

export const annotationsRouter = Router();
annotationsRouter.use(requirePermission(Permissions.DASHBOARD_READ));

const createSchema = z.object({
  dashboardId: z.string().uuid().nullable().default(null),
  time: z.coerce.date(),
  timeEnd: z.coerce.date().nullable().optional(),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().max(60)).max(20).default([]),
});

const select = {
  id: true,
  dashboardId: true,
  time: true,
  timeEnd: true,
  text: true,
  tags: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

// List annotations for the workspace, optionally scoped to one dashboard and/or a time window.
// A dashboard query also returns workspace-global annotations (dashboardId = null).
annotationsRouter.get(
  '/',
  validate(
    z.object({
      dashboardId: z.string().uuid().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const { dashboardId, from, to } = req.query as unknown as { dashboardId?: string; from?: Date; to?: Date };
    const time = from || to ? { gte: from, lte: to } : undefined;
    const list = await prisma.annotation.findMany({
      where: {
        workspaceId: req.workspace!.id,
        ...(dashboardId ? { OR: [{ dashboardId }, { dashboardId: null }] } : {}),
        ...(time ? { time } : {}),
      },
      select,
      orderBy: { time: 'asc' },
      take: 1000,
    });
    res.json(list);
  }),
);

annotationsRouter.post(
  '/',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof createSchema>;
    if (b.dashboardId) {
      const owned = await prisma.dashboard.count({ where: { id: b.dashboardId, workspaceId: req.workspace!.id } });
      if (!owned) throw NotFound('Dashboard');
    }
    const a = await prisma.annotation.create({
      data: {
        workspaceId: req.workspace!.id,
        dashboardId: b.dashboardId,
        time: b.time,
        timeEnd: b.timeEnd ?? null,
        text: b.text,
        tags: b.tags,
        createdById: req.user!.id,
      },
      select,
    });
    audit(req, { action: 'annotation.create', entityType: 'annotation', entityId: a.id });
    res.status(201).json(a);
  }),
);

annotationsRouter.delete(
  '/:id',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    const { count } = await prisma.annotation.deleteMany({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!count) throw NotFound('Annotation');
    audit(req, { action: 'annotation.delete', entityType: 'annotation', entityId: req.params.id });
    res.status(204).end();
  }),
);
