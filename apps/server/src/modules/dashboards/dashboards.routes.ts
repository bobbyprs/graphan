import { Router, type Request } from 'express';
import { z } from 'zod';
import { PermissionLevel } from '@prisma/client';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { Permissions } from '../../lib/rbac';
import { prisma } from '../../lib/prisma';
import { audit } from '../audit/audit.service';
import { dashboardInputSchema, dashboardUpdateSchema, panelDataRequestSchema } from './dashboard.schema';
import { dashboardsService as svc } from './dashboards.service';
import { dashboardRepository } from './dashboards.repository';

const actor = (req: Request) => ({ id: req.user!.id, role: req.workspace!.role });

export const dashboardsRouter = Router();
dashboardsRouter.use(requirePermission(Permissions.DASHBOARD_READ));

dashboardsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json(await svc.list(req.workspace!.id, actor(req), search));
  }),
);

dashboardsRouter.get('/templates', (_req, res) => res.json(svc.listTemplates()));

dashboardsRouter.post(
  '/from-template',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(z.object({ templateId: z.string().min(1).max(100), dataSourceId: z.string().uuid().nullable().default(null), title: z.string().max(200).optional() })),
  asyncHandler(async (req, res) => {
    const d = await svc.createFromTemplate(req.workspace!.id, actor(req), req.body.templateId, req.body.dataSourceId, req.body.title);
    audit(req, { action: 'dashboard.create_from_template', entityType: 'dashboard', entityId: d.id, metadata: { templateId: req.body.templateId } });
    res.status(201).json(d);
  }),
);

dashboardsRouter.get(
  '/folders',
  asyncHandler(async (req, res) => res.json(await prisma.folder.findMany({ where: { workspaceId: req.workspace!.id }, orderBy: { name: 'asc' } }))),
);

dashboardsRouter.post(
  '/folders',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(z.object({ name: z.string().min(1).max(100) })),
  asyncHandler(async (req, res) => res.status(201).json(await prisma.folder.create({ data: { workspaceId: req.workspace!.id, name: req.body.name } }))),
);

dashboardsRouter.post(
  '/',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(dashboardInputSchema),
  asyncHandler(async (req, res) => {
    const d = await svc.create(req.workspace!.id, actor(req), req.body);
    audit(req, { action: 'dashboard.create', entityType: 'dashboard', entityId: d.id, metadata: { title: d.title } });
    res.status(201).json(d);
  }),
);

dashboardsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { dashboard, level } = await svc.getWithAccess(req.workspace!.id, req.params.id, actor(req));
    const { permissions, ...rest } = dashboard;
    res.json({ ...rest, permissions: level === 'ADMIN' ? permissions : undefined, access: level });
  }),
);

dashboardsRouter.put(
  '/:id',
  validate(dashboardUpdateSchema),
  asyncHandler(async (req, res) => {
    const d = await svc.update(req.workspace!.id, req.params.id, actor(req), req.body);
    audit(req, { action: 'dashboard.update', entityType: 'dashboard', entityId: d.id, metadata: { version: d.version } });
    res.json(d);
  }),
);

dashboardsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await svc.remove(req.workspace!.id, req.params.id, actor(req));
    audit(req, { action: 'dashboard.delete', entityType: 'dashboard', entityId: req.params.id });
    res.status(204).end();
  }),
);

dashboardsRouter.post(
  '/:id/duplicate',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => res.status(201).json(await svc.duplicate(req.workspace!.id, req.params.id, actor(req), req.body?.title))),
);

dashboardsRouter.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    await svc.getWithAccess(req.workspace!.id, req.params.id, actor(req));
    res.json(await dashboardRepository.listVersions(req.params.id));
  }),
);

dashboardsRouter.post(
  '/:id/versions/:version/restore',
  asyncHandler(async (req, res) => {
    const d = await svc.restoreVersion(req.workspace!.id, req.params.id, actor(req), Number(req.params.version));
    audit(req, { action: 'dashboard.restore', entityType: 'dashboard', entityId: d.id, metadata: { from: Number(req.params.version) } });
    res.json(d);
  }),
);

dashboardsRouter.put(
  '/:id/permissions',
  validate(
    z.object({
      grants: z
        .array(
          z
            .object({ userId: z.string().uuid().optional(), teamId: z.string().uuid().optional(), level: z.nativeEnum(PermissionLevel) })
            .refine((g) => !!g.userId !== !!g.teamId, 'Specify exactly one of userId / teamId'),
        )
        .max(500),
    }),
  ),
  asyncHandler(async (req, res) => {
    await svc.setPermissions(req.workspace!.id, req.params.id, actor(req), req.body.grants);
    audit(req, { action: 'dashboard.permissions', entityType: 'dashboard', entityId: req.params.id, metadata: { grants: req.body.grants.length } });
    res.status(204).end();
  }),
);

dashboardsRouter.post(
  '/:id/share',
  validate(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const d = await svc.setSharing(req.workspace!.id, req.params.id, actor(req), req.body.enabled);
    audit(req, { action: req.body.enabled ? 'dashboard.share_enable' : 'dashboard.share_disable', entityType: 'dashboard', entityId: d.id });
    res.json({ shareToken: d.shareToken });
  }),
);

dashboardsRouter.post(
  '/:id/embed',
  validate(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const d = await svc.setEmbedding(req.workspace!.id, req.params.id, actor(req), req.body.enabled);
    audit(req, { action: req.body.enabled ? 'dashboard.embed_enable' : 'dashboard.embed_disable', entityType: 'dashboard', entityId: d.id });
    res.json({ embedEnabled: d.embedEnabled });
  }),
);

dashboardsRouter.post(
  '/:id/panels/:panelId/data',
  validate(panelDataRequestSchema),
  asyncHandler(async (req, res) => {
    const { dashboard } = await svc.getWithAccess(req.workspace!.id, req.params.id, actor(req));
    res.json(await svc.panelData(dashboard, req.params.panelId, req.body));
  }),
);

dashboardsRouter.get(
  '/:id/variables/:name/options',
  asyncHandler(async (req, res) => {
    const { dashboard } = await svc.getWithAccess(req.workspace!.id, req.params.id, actor(req));
    res.json(await svc.variableOptions(dashboard, req.params.name));
  }),
);
