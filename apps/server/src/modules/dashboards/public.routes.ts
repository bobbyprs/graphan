import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { NotFound } from '../../lib/errors';
import { panelDataRequestSchema } from './dashboard.schema';
import { dashboardRepository } from './dashboards.repository';
import { dashboardsService } from './dashboards.service';

/**
 * Anonymous, read-only access to dashboards with an active share link.
 * Only saved panel queries can run; fresh=true is ignored so the cache absorbs load.
 */
export const publicRouter = Router();
publicRouter.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

async function byToken(token: string) {
  if (!/^[\w-]{20,64}$/.test(token)) throw NotFound('Dashboard');
  const d = await dashboardRepository.findByShareToken(token);
  if (!d) throw NotFound('Dashboard');
  return d;
}

publicRouter.get(
  '/dashboards/:token',
  asyncHandler(async (req, res) => {
    const d = await byToken(req.params.token);
    res.json({ id: d.id, title: d.title, description: d.description, definition: d.definition, refreshInterval: d.refreshInterval, version: d.version, access: 'VIEW' });
  }),
);

publicRouter.post(
  '/dashboards/:token/panels/:panelId/data',
  validate(panelDataRequestSchema),
  asyncHandler(async (req, res) => {
    const d = await byToken(req.params.token);
    res.json(await dashboardsService.panelData(d, req.params.panelId, { ...req.body, fresh: false }));
  }),
);

publicRouter.get(
  '/dashboards/:token/variables/:name/options',
  asyncHandler(async (req, res) => {
    const d = await byToken(req.params.token);
    res.json(await dashboardsService.variableOptions(d, req.params.name));
  }),
);
