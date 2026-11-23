import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import type { Dashboard } from '@prisma/client';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/http';
import { AppError, BadRequest } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { validate } from '../../middleware/validate';
import { audit } from '../audit/audit.service';
import { panelDataRequestSchema } from './dashboard.schema';
import { dashboardsService, parseDefinition } from './dashboards.service';
import type { Report, ReportFormat } from '@prisma/client';
import { parseReportDefinition } from '../reports/engine';
import { exportRendered, fileName, FORMATS, reportsService } from '../reports/reports.service';
import { renderRequestSchema } from '../reports/report.schema';

/**
 * Signed embedding (for showing dashboards inside your other applications).
 *
 *  1. Your app's BACKEND signs a short-lived "launch" JWT with EMBED_SECRET (HS256):
 *       { resource: { dashboard: "<dashboard id>" }, params: { tenant_id: "42" }, user?: "who@app", exp }
 *  2. Your app renders <iframe src="https://graphan.example.com/embed/dashboard/<launch token>">.
 *  3. The embed page exchanges the launch token here for a Graphan "embed session" token (EMBED_SESSION_TTL),
 *     which it sends as the X-Embed-Session header on every request — never in URLs.
 *
 * `params` are LOCKED dashboard variables: the viewer cannot see or change them, so you can use them
 * for row-level security (e.g. `WHERE tenant_id = ${tenant_id}`). Values are always bound parameters.
 */
export const embedRouter = Router();
embedRouter.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

const AUDIENCE = 'graphan-embed';
const MAX_LAUNCH_LIFETIME_S = 60 * 60; // launch tokens must expire within an hour

const paramValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.union([z.string().max(2000), z.number()])).max(1000)]);
const launchSchema = z.object({
  resource: z.union([z.object({ dashboard: z.string().uuid() }), z.object({ report: z.string().uuid() })]),
  params: z.record(paramValue).default({}),
  user: z.string().max(200).optional(),
  exp: z.number(),
  iat: z.number().optional(),
});
type Locked = z.infer<typeof launchSchema>['params'];

interface SessionPayload {
  d?: string; // dashboard id
  r?: string; // report id
  p: Locked; // locked params
  u?: string; // external user (for audit/logs)
}

const forbidden = (msg: string, code = 'EMBED_FORBIDDEN') => new AppError(403, msg, code);

function requireSecret(): string {
  if (!env.EMBED_SECRET) throw new AppError(503, 'Embedding is not configured on this Graphan server (set EMBED_SECRET).', 'EMBED_DISABLED');
  return env.EMBED_SECRET;
}

async function loadEmbeddable(id: string | undefined): Promise<Dashboard> {
  if (!id) throw forbidden('This embed session is not for a dashboard.');
  const d = await prisma.dashboard.findUnique({ where: { id } });
  if (!d || !d.embedEnabled) throw forbidden('This dashboard is not enabled for embedding.');
  return d;
}

function session(req: Request): SessionPayload {
  const token = req.header('x-embed-session');
  if (!token) throw forbidden('Missing embed session.');
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: AUDIENCE, issuer: 'graphan', algorithms: ['HS256'] }) as SessionPayload;
  } catch (e) {
    throw forbidden(e instanceof jwt.TokenExpiredError ? 'Embed session expired — reload the page.' : 'Invalid embed session.', 'EMBED_SESSION_INVALID');
  }
}

function view(d: Dashboard, locked: Locked) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    tags: d.tags,
    definition: d.definition,
    refreshInterval: d.refreshInterval,
    version: d.version,
    access: 'VIEW' as const,
    lockedParams: Object.keys(locked),
  };
}

/** Exchange a launch token (signed by your app) for an embed session. */
embedRouter.post(
  '/session',
  validate(z.object({ token: z.string().min(10).max(8192) })),
  asyncHandler(async (req, res) => {
    const secret = requireSecret();
    let claims: z.infer<typeof launchSchema>;
    try {
      const raw = jwt.verify(req.body.token, secret, { algorithms: ['HS256'] });
      claims = launchSchema.parse(raw);
    } catch (e) {
      const msg =
        e instanceof jwt.TokenExpiredError
          ? 'Embed token expired.'
          : e instanceof z.ZodError
            ? `Embed token is missing required claims (${e.issues.map((i) => i.path.join('.')).join(', ')}).`
            : 'Embed token signature is invalid.';
      throw forbidden(msg, 'EMBED_TOKEN_INVALID');
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp - now > MAX_LAUNCH_LIFETIME_S) throw forbidden('Embed token lifetime is too long (exp must be within 1 hour).', 'EMBED_TOKEN_INVALID');

    if ('report' in claims.resource) {
      const r = await loadEmbeddableReport(claims.resource.report);
      const params = new Set(parseReportDefinition(r.definition).parameters.map((p) => p.name));
      const unknownP = Object.keys(claims.params).filter((k) => !params.has(k));
      if (unknownP.length) throw BadRequest(`Embed token params are not parameters of this report: ${unknownP.join(', ')}`);
      const sessionToken = jwt.sign({ r: r.id, p: claims.params, u: claims.user } satisfies SessionPayload, env.JWT_ACCESS_SECRET, {
        expiresIn: env.EMBED_SESSION_TTL as SignOptions['expiresIn'],
        audience: AUDIENCE,
        issuer: 'graphan',
        algorithm: 'HS256',
      });
      audit(req, { action: 'report.embed_view', entityType: 'report', entityId: r.id, workspaceId: r.workspaceId, metadata: { externalUser: claims.user ?? null, params: Object.keys(claims.params) } });
      return res.json({ sessionToken, report: reportView(r, claims.params) });
    }

    const d = await loadEmbeddable(claims.resource.dashboard);
    // Every locked param must be a real dashboard variable — otherwise a row-level filter would silently not apply.
    const vars = new Map(parseDefinition(d.definition).variables.map((v) => [v.name, v]));
    const unknown = Object.keys(claims.params).filter((k) => !vars.has(k));
    if (unknown.length) throw BadRequest(`Embed token params are not variables of this dashboard: ${unknown.join(', ')}`);
    // Multi-value variables (used as `IN ${var}`) always need a list, even when the app passes one value
    const locked: Locked = {};
    for (const [k, val] of Object.entries(claims.params)) {
      const values = Array.isArray(val) ? val : [val];
      if (values.some((x) => x === '$__all')) throw BadRequest(`Embed param ${k} cannot be "$__all" — omit it to let the viewer choose, or pass explicit values.`);
      locked[k] = vars.get(k)!.multi ? values.map((x) => (typeof x === 'boolean' ? String(x) : x)) : val;
    }

    const payload: SessionPayload = { d: d.id, p: locked, u: claims.user };
    const sessionToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.EMBED_SESSION_TTL as SignOptions['expiresIn'],
      audience: AUDIENCE,
      issuer: 'graphan',
      algorithm: 'HS256',
    });
    audit(req, {
      action: 'dashboard.embed_view',
      entityType: 'dashboard',
      entityId: d.id,
      workspaceId: d.workspaceId,
      metadata: { externalUser: claims.user ?? null, params: Object.keys(claims.params) },
    });
    logger.debug({ dashboard: d.id, user: claims.user }, 'embed session created');
    res.json({ sessionToken, dashboard: view(d, locked) });
  }),
);

embedRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const s = session(req);
    res.json(view(await loadEmbeddable(s.d), s.p));
  }),
);

embedRouter.post(
  '/dashboard/panels/:panelId/data',
  validate(panelDataRequestSchema),
  asyncHandler(async (req, res) => {
    const s = session(req);
    const d = await loadEmbeddable(s.d);
    // Locked params always win over anything the browser sends
    res.json(await dashboardsService.panelData(d, req.params.panelId, { ...req.body, variables: { ...req.body.variables, ...s.p }, fresh: false }));
  }),
);

embedRouter.get(
  '/dashboard/variables/:name/options',
  asyncHandler(async (req, res) => {
    const s = session(req);
    const d = await loadEmbeddable(s.d);
    if (req.params.name in s.p) {
      const v = s.p[req.params.name];
      return res.json({ values: (Array.isArray(v) ? v : [v]).map(String) });
    }
    res.json(await dashboardsService.variableOptions(d, req.params.name));
  }),
);

// ───────────────────────── Reports ─────────────────────────

async function loadEmbeddableReport(id: string | undefined): Promise<Report> {
  if (!id) throw forbidden('This embed session is not for a report.');
  const r = await prisma.report.findUnique({ where: { id } });
  if (!r || !r.embedEnabled) throw forbidden('This report is not enabled for embedding.');
  return r;
}

/** Report definition for the embedded viewer: locked parameters are hidden and fixed. */
function reportView(r: Report, locked: Locked) {
  const def = parseReportDefinition(r.definition);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    folder: r.folder,
    version: r.version,
    canEdit: false,
    snapshotRetention: 0,
    definition: { ...def, datasets: [], parameters: def.parameters.map((p) => (p.name in locked ? { ...p, hidden: true, options: { kind: 'none' as const } } : { ...p, options: p.options.kind === 'query' ? { kind: 'query' as const, dataSourceId: p.options.dataSourceId, query: '', defaultFirst: p.options.defaultFirst } : p.options })) },
    lockedParams: Object.keys(locked),
  };
}

const withLocked = (input: Record<string, unknown>, s: SessionPayload) => ({ ...input, ...s.p });

embedRouter.get(
  '/report',
  asyncHandler(async (req, res) => {
    const s = session(req);
    res.json(reportView(await loadEmbeddableReport(s.r), s.p));
  }),
);

embedRouter.post(
  '/report/parameters',
  validate(z.object({ parameters: z.record(z.unknown()).default({}) })),
  asyncHandler(async (req, res) => {
    const s = session(req);
    const r = await loadEmbeddableReport(s.r);
    res.json({ values: await reportsService.resolveDefaults(r, withLocked(req.body.parameters, s)) });
  }),
);

embedRouter.post(
  '/report/parameters/:name/options',
  validate(z.object({ parameters: z.record(z.unknown()).default({}) })),
  asyncHandler(async (req, res) => {
    const s = session(req);
    const r = await loadEmbeddableReport(s.r);
    if (req.params.name in s.p) {
      const v = s.p[req.params.name];
      return res.json((Array.isArray(v) ? v : [v]).map((x) => ({ value: x, label: String(x) })));
    }
    res.json(await reportsService.parameterOptions(r, req.params.name, withLocked(req.body.parameters, s)));
  }),
);

embedRouter.post(
  '/report/render',
  validate(renderRequestSchema),
  asyncHandler(async (req, res) => {
    const s = session(req);
    const r = await loadEmbeddableReport(s.r);
    const out = await reportsService.render(r, withLocked(req.body.parameters, s), { userId: null, userName: s.u ?? 'Embedded viewer', source: 'embed', fresh: req.body.fresh });
    res.json({ model: out.model, cached: out.cached });
  }),
);

embedRouter.post(
  '/report/export',
  validate(renderRequestSchema.extend({ format: z.enum(['PDF', 'EXCEL', 'WORD', 'CSV', 'HTML', 'JSON']) })),
  asyncHandler(async (req, res) => {
    const s = session(req);
    const r = await loadEmbeddableReport(s.r);
    const format = req.body.format as ReportFormat;
    const out = await reportsService.render(r, withLocked(req.body.parameters, s), { userId: null, userName: s.u ?? 'Embedded viewer', source: 'embed', format });
    const f = FORMATS[format];
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(r.title, f.ext)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await exportRendered(out.model, format, out.data));
  }),
);
