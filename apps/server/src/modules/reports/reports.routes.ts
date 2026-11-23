import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ReportFormat } from '@prisma/client';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { can, Permissions } from '../../lib/rbac';
import { Forbidden } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { reportInputSchema, reportUpdateSchema, renderRequestSchema, subscriptionInputSchema, paramValue, reportDefinitionSchema } from './report.schema';
import { exportRendered, fileName, FORMATS, reportsService as svc, type Actor } from './reports.service';
import type { RenderedReport } from './rendered';

const actor = (req: Request): Actor => ({ id: req.user!.id, role: req.workspace!.role, name: req.user!.name });
const formatSchema = z.enum(['PDF', 'EXCEL', 'WORD', 'CSV', 'HTML', 'JSON']);

function abortOnDisconnect(req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => !res.writableFinished && ac.abort());
  req.on('aborted', () => ac.abort());
  return ac.signal;
}

/** SSRS-style URL parameters: ?p.region=North&p.region=South */
export function paramsFromQuery(q: Request['query']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('p.')) continue;
    out[k.slice(2)] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

function sendFile(res: Response, buf: Buffer, title: string, format: ReportFormat, at?: Date) {
  const f = FORMATS[format];
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(title, f.ext, at)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

export const reportsRouter = Router();
reportsRouter.use(requirePermission(Permissions.DASHBOARD_READ));

reportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const a = actor(req);
    const list = await svc.list(req.workspace!.id, typeof req.query.search === 'string' ? req.query.search : undefined);
    res.json(list.map((r) => ({ ...r, canEdit: svc.canEdit(r, a) })));
  }),
);

reportsRouter.get('/templates', (_req, res) => res.json(svc.listTemplates()));

reportsRouter.post(
  '/from-template',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(z.object({ templateId: z.string().min(1).max(100), dataSourceId: z.string().uuid(), folder: reportInputSchema.shape.folder })),
  asyncHandler(async (req, res) => {
    const created = await svc.createFromTemplate(req.workspace!.id, actor(req), req.body.templateId, req.body.dataSourceId, req.body.folder);
    audit(req, { action: 'report.create_from_template', entityType: 'report', entityId: created[created.length - 1]?.id, metadata: { templateId: req.body.templateId } });
    res.status(201).json(created);
  }),
);

reportsRouter.post(
  '/',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(reportInputSchema),
  asyncHandler(async (req, res) => {
    const r = await svc.create(req.workspace!.id, actor(req), req.body);
    audit(req, { action: 'report.create', entityType: 'report', entityId: r.id });
    res.status(201).json(r);
  }),
);

/** Validates a definition without saving (designer "Check" / import preview). */
reportsRouter.post(
  '/validate',
  asyncHandler(async (req, res) => {
    const r = reportDefinitionSchema.safeParse(req.body?.definition);
    res.json(r.success ? { ok: true } : { ok: false, issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }),
);

reportsRouter.get(
  '/executions',
  requirePermission(Permissions.DASHBOARD_MANAGE_ALL),
  asyncHandler(async (req, res) => {
    res.json(await svc.listExecutions(req.workspace!.id, { reportId: typeof req.query.reportId === 'string' ? req.query.reportId : undefined, take: Number(req.query.take) || undefined }));
  }),
);

// ───────────── Subscriptions (by id) ─────────────
reportsRouter.get(
  '/subscriptions',
  asyncHandler(async (req, res) => {
    const a = actor(req);
    const all = req.query.all === '1' && can(a.role, Permissions.DASHBOARD_MANAGE_ALL);
    res.json(await svc.listSubscriptions(req.workspace!.id, { ownerId: all ? undefined : a.id }));
  }),
);

reportsRouter.put(
  '/subscriptions/:sid',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(subscriptionInputSchema),
  asyncHandler(async (req, res) => {
    const s = await svc.updateSubscription(req.workspace!.id, req.params.sid, actor(req), req.body);
    audit(req, { action: 'report.subscription_update', entityType: 'report_subscription', entityId: s.id });
    res.json(s);
  }),
);

reportsRouter.delete(
  '/subscriptions/:sid',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    await svc.removeSubscription(req.workspace!.id, req.params.sid, actor(req));
    audit(req, { action: 'report.subscription_delete', entityType: 'report_subscription', entityId: req.params.sid });
    res.status(204).end();
  }),
);

reportsRouter.post(
  '/subscriptions/:sid/run',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    const a = actor(req);
    const s = await svc.getSubscription(req.workspace!.id, req.params.sid);
    if (s.ownerId !== a.id && !can(a.role, Permissions.DASHBOARD_MANAGE_ALL)) throw Forbidden('Only the owner can run this subscription');
    audit(req, { action: 'report.subscription_run', entityType: 'report_subscription', entityId: s.id });
    res.json(await svc.runSubscription(s.id));
  }),
);

reportsRouter.get(
  '/subscriptions/:sid/deliveries',
  asyncHandler(async (req, res) => {
    const s = await svc.getSubscription(req.workspace!.id, req.params.sid);
    res.json(await svc.deliveries(s.id));
  }),
);

// ───────────── Report by id ─────────────
reportsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    res.json({ ...r, canEdit: svc.canEdit(r, actor(req)) });
  }),
);

reportsRouter.put(
  '/:id',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(reportUpdateSchema),
  asyncHandler(async (req, res) => {
    const r = await svc.update(req.workspace!.id, req.params.id, actor(req), req.body);
    audit(req, { action: 'report.update', entityType: 'report', entityId: r.id, metadata: { version: r.version } });
    res.json(r);
  }),
);

reportsRouter.delete(
  '/:id',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    await svc.remove(req.workspace!.id, req.params.id, actor(req));
    audit(req, { action: 'report.delete', entityType: 'report', entityId: req.params.id });
    res.status(204).end();
  }),
);

reportsRouter.post(
  '/:id/duplicate',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    const r = await svc.duplicate(req.workspace!.id, req.params.id, actor(req));
    audit(req, { action: 'report.duplicate', entityType: 'report', entityId: r.id });
    res.status(201).json(r);
  }),
);

reportsRouter.post(
  '/:id/embed',
  validate(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const r = await svc.setEmbedding(req.workspace!.id, req.params.id, actor(req), req.body.enabled);
    audit(req, { action: req.body.enabled ? 'report.embed_enable' : 'report.embed_disable', entityType: 'report', entityId: r.id });
    res.json({ embedEnabled: r.embedEnabled });
  }),
);

/** Interactive viewer: returns the rendered report model. */
reportsRouter.post(
  '/:id/render',
  validate(renderRequestSchema),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    const out = await svc.render(r, req.body.parameters, { userId: a.id, userName: a.name, source: 'viewer', fresh: req.body.fresh, signal: abortOnDisconnect(req, res) });
    res.json({ model: out.model, cached: out.cached });
  }),
);

/** Designer preview of an unsaved definition (never cached or logged). */
reportsRouter.post(
  '/:id/preview',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(z.object({ definition: reportDefinitionSchema, parameters: z.record(paramValue).default({}) })),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    const out = await svc.render(r, req.body.parameters, { userId: a.id, userName: a.name, source: 'preview', definition: req.body.definition, signal: abortOnDisconnect(req, res) });
    res.json({ model: out.model, datasets: Object.fromEntries(Object.entries(out.data).map(([k, d]) => [k, { columns: d.columns, rows: d.rows.slice(0, 50), rowCount: d.rowCount }])) });
  }),
);

reportsRouter.post(
  '/:id/parameters',
  validate(z.object({ parameters: z.record(paramValue).default({}), definition: reportDefinitionSchema.optional() })),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    res.json({ values: await svc.resolveDefaults(r, req.body.parameters, req.body.definition) });
  }),
);

reportsRouter.post(
  '/:id/parameters/:name/options',
  validate(z.object({ parameters: z.record(paramValue).default({}), definition: reportDefinitionSchema.optional() })),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    res.json(await svc.parameterOptions(r, req.params.name, req.body.parameters, req.body.definition));
  }),
);

reportsRouter.post(
  '/:id/export',
  validate(renderRequestSchema.extend({ format: formatSchema })),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    const out = await svc.render(r, req.body.parameters, { userId: a.id, userName: a.name, source: 'export', format: req.body.format, fresh: req.body.fresh, signal: abortOnDisconnect(req, res) });
    audit(req, { action: 'report.export', entityType: 'report', entityId: r.id, metadata: { format: req.body.format } });
    sendFile(res, await exportRendered(out.model, req.body.format, out.data), r.title, req.body.format);
  }),
);

/** URL access (like SSRS rs:Format): GET /reports/:id/export?format=PDF&p.region=North */
reportsRouter.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const format = formatSchema.parse(String(req.query.format ?? 'PDF').toUpperCase());
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    const out = await svc.render(r, paramsFromQuery(req.query), { userId: a.id, userName: a.name, source: 'url', format, signal: abortOnDisconnect(req, res) });
    sendFile(res, await exportRendered(out.model, format, out.data), r.title, format);
  }),
);

// ───────────── Snapshots / history ─────────────
reportsRouter.get(
  '/:id/snapshots',
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    res.json(await svc.listSnapshots(r.id));
  }),
);

reportsRouter.post(
  '/:id/snapshots',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(renderRequestSchema.extend({ label: z.string().max(200).optional() })),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    const s = await svc.createSnapshot(r, req.body.parameters, { id: a.id, name: a.name }, req.body.label);
    audit(req, { action: 'report.snapshot', entityType: 'report', entityId: r.id });
    res.status(201).json(s);
  }),
);

reportsRouter.get(
  '/:id/snapshots/:sid',
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const s = await svc.getSnapshot(r.id, req.params.sid);
    res.json({ id: s.id, label: s.label, createdAt: s.createdAt, model: s.rendered });
  }),
);

reportsRouter.get(
  '/:id/snapshots/:sid/export',
  asyncHandler(async (req, res) => {
    const format = formatSchema.parse(String(req.query.format ?? 'PDF').toUpperCase());
    const r = await svc.get(req.workspace!.id, req.params.id);
    const s = await svc.getSnapshot(r.id, req.params.sid);
    sendFile(res, await exportRendered(s.rendered as unknown as RenderedReport, format), `${r.title} snapshot`, format, s.createdAt);
  }),
);

reportsRouter.delete(
  '/:id/snapshots/:sid',
  requirePermission(Permissions.DASHBOARD_CREATE),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    if (!svc.canEdit(r, actor(req))) throw Forbidden();
    await svc.getSnapshot(r.id, req.params.sid);
    const { prisma } = await import('../../lib/prisma');
    await prisma.reportSnapshot.delete({ where: { id: req.params.sid } });
    res.status(204).end();
  }),
);

// ───────────── Subscriptions (per report) ─────────────
reportsRouter.get(
  '/:id/subscriptions',
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const a = actor(req);
    res.json(await svc.listSubscriptions(req.workspace!.id, { reportId: r.id, ownerId: can(a.role, Permissions.DASHBOARD_MANAGE_ALL) ? undefined : a.id }));
  }),
);

reportsRouter.post(
  '/:id/subscriptions',
  requirePermission(Permissions.DASHBOARD_CREATE),
  validate(subscriptionInputSchema),
  asyncHandler(async (req, res) => {
    const r = await svc.get(req.workspace!.id, req.params.id);
    const s = await svc.createSubscription(r, actor(req), req.body);
    audit(req, { action: 'report.subscription_create', entityType: 'report_subscription', entityId: s.id, metadata: { reportId: r.id, dataDriven: !!req.body.dataDriven } });
    res.status(201).json(s);
  }),
);
