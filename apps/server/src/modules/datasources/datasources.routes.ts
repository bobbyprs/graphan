import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { Permissions } from '../../lib/rbac';
import { audit } from '../audit/audit.service';
import { dataSourceInputSchema, dataSourcesService as svc, toDto } from './datasources.service';

export const dataSourcesRouter = Router();

dataSourcesRouter.get(
  '/',
  requirePermission(Permissions.DATASOURCE_READ),
  asyncHandler(async (req, res) => res.json(await svc.list(req.workspace!.id))),
);

dataSourcesRouter.get(
  '/:id',
  requirePermission(Permissions.DATASOURCE_READ),
  asyncHandler(async (req, res) => res.json(toDto(await svc.get(req.workspace!.id, req.params.id)))),
);

dataSourcesRouter.post(
  '/',
  requirePermission(Permissions.DATASOURCE_MANAGE),
  validate(dataSourceInputSchema),
  asyncHandler(async (req, res) => {
    const ds = await svc.create(req.workspace!.id, req.user!.id, req.body);
    audit(req, { action: 'datasource.create', entityType: 'datasource', entityId: ds.id, metadata: { name: ds.name, type: ds.type } });
    res.status(201).json(ds);
  }),
);

dataSourcesRouter.post(
  '/test',
  requirePermission(Permissions.DATASOURCE_MANAGE),
  validate(dataSourceInputSchema.extend({ id: z.string().uuid().optional() })),
  asyncHandler(async (req, res) => {
    const existing = req.body.id ? await svc.get(req.workspace!.id, req.body.id) : undefined;
    res.json(await svc.testConfig(req.body, existing));
  }),
);

dataSourcesRouter.put(
  '/:id',
  requirePermission(Permissions.DATASOURCE_MANAGE),
  validate(dataSourceInputSchema.partial()),
  asyncHandler(async (req, res) => {
    const ds = await svc.update(req.workspace!.id, req.params.id, req.body);
    audit(req, { action: 'datasource.update', entityType: 'datasource', entityId: ds.id, metadata: { fields: Object.keys(req.body).filter((k) => k !== 'password' && k !== 'connectionString') } });
    res.json(ds);
  }),
);

dataSourcesRouter.post(
  '/:id/health',
  requirePermission(Permissions.DATASOURCE_READ),
  asyncHandler(async (req, res) => res.json(await svc.checkHealth(await svc.get(req.workspace!.id, req.params.id)))),
);

dataSourcesRouter.delete(
  '/:id',
  requirePermission(Permissions.DATASOURCE_MANAGE),
  asyncHandler(async (req, res) => {
    await svc.remove(req.workspace!.id, req.params.id);
    audit(req, { action: 'datasource.delete', entityType: 'datasource', entityId: req.params.id });
    res.status(204).end();
  }),
);
