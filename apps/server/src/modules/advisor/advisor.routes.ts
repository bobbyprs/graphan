import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Permissions } from '../../lib/rbac';
import { audit } from '../audit/audit.service';
import { advisorService } from './advisor.service';

const analyzeSchema = z.object({
  dataSourceId: z.string().uuid(),
  schemas: z.array(z.string().min(1).max(200)).max(50).optional(),
  tables: z.array(z.string().min(1).max(400)).max(200).optional(),
  fresh: z.boolean().optional(),
});

const composeSchema = z.object({
  suggestionIds: z.array(z.string().max(32)).min(1).max(40),
  target: z.enum(['dashboard', 'report']),
  title: z.string().max(200).optional(),
  filter: z.string().max(600).nullable().optional(),
});

const ident = z.string().min(1).max(400);
const side = z.object({ schema: z.string().max(200), table: ident, column: ident });
const ROLES = ['primaryKey', 'foreignKey', 'time', 'auditTime', 'measure', 'dimension', 'flag', 'label', 'identifier', 'text', 'empty'] as const;
const words = z.array(z.string().trim().min(1).max(80)).max(20);
const modelSchema = z.object({
  overrides: z.object({
    tables: z
      .record(
        ident,
        z.object({ label: z.string().max(120).optional(), synonyms: words.optional(), timeColumn: ident.nullable().optional(), labelColumn: ident.nullable().optional(), hidden: z.boolean().optional() }),
      )
      .optional(),
    columns: z.record(z.string().min(1).max(820), z.object({ role: z.enum(ROLES).optional(), label: z.string().max(120).optional(), synonyms: words.optional() })).optional(),
    joins: z.object({ add: z.array(z.object({ left: side, right: side })).max(200).optional(), remove: z.array(z.string().max(900)).max(500).optional() }).optional(),
    kpis: z.record(z.string().max(900), z.object({ name: z.string().max(120).optional(), hidden: z.boolean().optional() })).optional(),
  }),
});

const askSchema = z.object({ question: z.string().trim().min(2).max(300), table: z.string().max(400).optional() });

/** Database analyzer: profiles a whole schema, finds joins and KPIs, and proposes dashboard/report content. */
export const advisorRouter = Router({ mergeParams: true });
advisorRouter.use(requirePermission(Permissions.EXPLORER_READ));

advisorRouter.post(
  '/analyze',
  validate(analyzeSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof analyzeSchema>;
    const a = await advisorService.analyze(req.workspace!.id, b);
    audit(req, { action: 'advisor.analyze', entityType: 'datasource', entityId: b.dataSourceId, metadata: { schemas: a.schemas, tables: a.summary.analysed, ms: a.durationMs } });
    res.json(a);
  }),
);

// Data model (corrections) per data source. Everyone who can analyse can read it; changing it needs Analyst+.
advisorRouter.get(
  '/model/:dataSourceId',
  asyncHandler(async (req, res) => {
    res.json(await advisorService.getModel(req.workspace!.id, req.params.dataSourceId));
  }),
);

advisorRouter.put(
  '/model/:dataSourceId',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(modelSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof modelSchema>;
    const out = await advisorService.saveModel(req.workspace!.id, req.params.dataSourceId, b.overrides, req.user!.id);
    audit(req, { action: 'advisor.model.update', entityType: 'datasource', entityId: req.params.dataSourceId, metadata: { corrections: out.corrections } });
    res.json(out);
  }),
);

advisorRouter.post(
  '/:id/ask',
  validate(askSchema),
  asyncHandler(async (req, res) => {
    res.json(await advisorService.ask(req.workspace!.id, req.params.id, req.body as z.infer<typeof askSchema>));
  }),
);

advisorRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(advisorService.get(req.workspace!.id, req.params.id));
  }),
);

advisorRouter.post(
  '/:id/compose',
  validate(composeSchema),
  asyncHandler(async (req, res) => {
    res.json(await advisorService.compose(req.workspace!.id, req.params.id, req.body as z.infer<typeof composeSchema>));
  }),
);
