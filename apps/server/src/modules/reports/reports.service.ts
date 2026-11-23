import { LRUCache } from 'lru-cache';
import type { Prisma, Report, ReportFormat, Role } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { can, Permissions } from '../../lib/rbac';
import { sha256 } from '../../lib/crypto';
import { executeQuery } from '../queries/query.service';
import { dataSourceRepository } from '../datasources/datasources.repository';
import { sendMail, smtpConfigured } from '../alerts/notifiers';
import { renderReport, parseReportDefinition, parameterOptions, resolveParameters, type ParamInput, type RenderOutput } from './engine';
import { reportInputSchema, reportUpdateSchema, subscriptionInputSchema } from './report.schema';
import type { RenderedReport } from './rendered';
import { renderPdf } from './renderers/pdf';
import { renderExcel } from './renderers/excel';
import { renderWord } from './renderers/word';
import { renderCsv, renderHtml, renderJson } from './renderers/html';
import { REPORT_TEMPLATES } from './templates';

export interface Actor {
  id: string;
  role: Role;
  name: string;
}

export const FORMATS: Record<ReportFormat, { mime: string; ext: string }> = {
  PDF: { mime: 'application/pdf', ext: 'pdf' },
  EXCEL: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  WORD: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  CSV: { mime: 'text/csv; charset=utf-8', ext: 'csv' },
  HTML: { mime: 'text/html; charset=utf-8', ext: 'html' },
  JSON: { mime: 'application/json', ext: 'json' },
};

export async function exportRendered(model: RenderedReport, format: ReportFormat, data?: RenderOutput['data']): Promise<Buffer> {
  switch (format) {
    case 'PDF': return renderPdf(model);
    case 'EXCEL': return renderExcel(model);
    case 'WORD': return renderWord(model);
    case 'CSV': return renderCsv(model);
    case 'HTML': return Buffer.from(renderHtml(model, { charts: 'svg' }).html, 'utf8');
    case 'JSON': return renderJson(model, data);
  }
}

export const fileName = (title: string, ext: string, at = new Date()) => `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'report'}_${at.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;

const cache = new LRUCache<string, RenderOutput>({ max: 200, maxSize: 200 * 1024 * 1024, sizeCalculation: (v) => Math.max(1, JSON.stringify(v.model).length), ttlAutopurge: true });

const listSelect = {
  id: true,
  title: true,
  description: true,
  folder: true,
  version: true,
  ownerId: true,
  cacheMinutes: true,
  embedEnabled: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true } },
  _count: { select: { subscriptions: true, snapshots: true } },
} satisfies Prisma.ReportSelect;

function canEdit(r: Pick<Report, 'ownerId'>, a: Actor) {
  return r.ownerId === a.id || can(a.role, Permissions.DASHBOARD_MANAGE_ALL);
}

async function assertDataSources(workspaceId: string, def: z.infer<typeof reportInputSchema>['definition']) {
  const ids = new Set<string>([...def.datasets.map((d) => d.dataSourceId), ...def.parameters.flatMap((p) => (p.options.kind === 'query' ? [p.options.dataSourceId] : []))]);
  for (const id of ids) {
    const ds = await dataSourceRepository.findByIdUnscoped(id);
    if (!ds || ds.workspaceId !== workspaceId) throw BadRequest(`Data source ${id} is not in this workspace`);
  }
  const names = def.datasets.map((d) => d.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw BadRequest(`Dataset name "${dupe}" is used twice`);
  const pnames = def.parameters.map((p) => p.name);
  const pdupe = pnames.find((n, i) => pnames.indexOf(n) !== i);
  if (pdupe) throw BadRequest(`Parameter name "${pdupe}" is used twice`);
}

function logExecution(e: { report: Pick<Report, 'id' | 'workspaceId'>; userId?: string | null; source: string; format: string; parameters: unknown; started: number; rowCount?: number; cached?: boolean; error?: unknown }) {
  prisma.reportExecution
    .create({
      data: {
        reportId: e.report.id,
        workspaceId: e.report.workspaceId,
        userId: e.userId ?? null,
        source: e.source,
        format: e.format,
        parameters: (e.parameters ?? {}) as Prisma.InputJsonValue,
        durationMs: Date.now() - e.started,
        rowCount: e.rowCount ?? 0,
        cached: !!e.cached,
        status: e.error ? 'error' : 'success',
        error: e.error ? String((e.error as Error).message ?? e.error).slice(0, 2000) : null,
      },
    })
    .catch((err) => logger.warn({ err }, 'report execution log failed'));
}

export const reportsService = {
  canEdit,

  list(workspaceId: string, search?: string) {
    return prisma.report.findMany({
      where: { workspaceId, ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { folder: { contains: search, mode: 'insensitive' } }] } : {}) },
      select: listSelect,
      orderBy: [{ folder: 'asc' }, { title: 'asc' }],
    });
  },

  async get(workspaceId: string, id: string) {
    const r = await prisma.report.findFirst({ where: { id, workspaceId }, include: { owner: { select: { id: true, name: true } } } });
    if (!r) throw NotFound('Report');
    return r;
  },

  async create(workspaceId: string, a: Actor, input: z.infer<typeof reportInputSchema>) {
    await assertDataSources(workspaceId, input.definition);
    return prisma.report.create({ data: { ...input, definition: input.definition as Prisma.InputJsonValue, workspaceId, ownerId: a.id } });
  },

  async update(workspaceId: string, id: string, a: Actor, input: z.infer<typeof reportUpdateSchema>) {
    const r = await this.get(workspaceId, id);
    if (!canEdit(r, a)) throw Forbidden('Only the owner or a developer/admin can edit this report');
    if (input.version !== r.version) throw Conflict(`Report was changed by someone else (version ${r.version}). Reload to get the latest version.`);
    if (input.definition) await assertDataSources(workspaceId, input.definition);
    const { version: _v, ...rest } = input;
    return prisma.report.update({ where: { id }, data: { ...rest, definition: rest.definition as Prisma.InputJsonValue | undefined, version: { increment: 1 } } });
  },

  async remove(workspaceId: string, id: string, a: Actor) {
    const r = await this.get(workspaceId, id);
    if (!canEdit(r, a)) throw Forbidden('Only the owner or a developer/admin can delete this report');
    await prisma.report.delete({ where: { id } });
  },

  async duplicate(workspaceId: string, id: string, a: Actor) {
    const r = await this.get(workspaceId, id);
    return prisma.report.create({
      data: { workspaceId, ownerId: a.id, title: `${r.title} (copy)`, description: r.description, folder: r.folder, definition: r.definition as Prisma.InputJsonValue, cacheMinutes: r.cacheMinutes },
    });
  },

  async setEmbedding(workspaceId: string, id: string, a: Actor, enabled: boolean) {
    const r = await this.get(workspaceId, id);
    if (!canEdit(r, a)) throw Forbidden();
    return prisma.report.update({ where: { id }, data: { embedEnabled: enabled } });
  },

  /** Renders the report (with cache + execution log). */
  async render(report: Report, input: ParamInput, opts: { userId?: string | null; userName: string; source: string; format?: string; fresh?: boolean; signal?: AbortSignal; definition?: unknown }): Promise<RenderOutput & { cached: boolean }> {
    const started = Date.now();
    const def = opts.definition ?? report.definition;
    const key = `${report.id}:${report.version}:${sha256(JSON.stringify(input))}`;
    const useCache = !opts.definition && report.cacheMinutes > 0;
    if (useCache && !opts.fresh) {
      const hit = cache.get(key);
      if (hit) {
        logExecution({ report, userId: opts.userId, source: opts.source, format: opts.format ?? 'HTML', parameters: input, started, rowCount: hit.model.rowCount, cached: true });
        return { ...hit, cached: true };
      }
    }
    try {
      const out = await renderReport(def, input, { reportId: report.id, title: report.title, description: report.description, workspaceId: report.workspaceId, userName: opts.userName, signal: opts.signal });
      if (useCache) cache.set(key, out, { ttl: report.cacheMinutes * 60_000 });
      if (!opts.definition) logExecution({ report, userId: opts.userId, source: opts.source, format: opts.format ?? 'HTML', parameters: input, started, rowCount: out.model.rowCount });
      return { ...out, cached: false };
    } catch (e) {
      if (!opts.definition && !(e instanceof AppError && e.code === 'PARAMETERS_REQUIRED')) logExecution({ report, userId: opts.userId, source: opts.source, format: opts.format ?? 'HTML', parameters: input, started, error: e });
      throw e;
    }
  },

  async parameterOptions(report: Report, name: string, current: ParamInput, definition?: unknown) {
    const def = parseReportDefinition(definition ?? report.definition);
    // Resolve earlier parameters (cascading) without failing on missing later ones
    const idx = def.parameters.findIndex((p) => p.name === name);
    if (idx < 0) throw NotFound('Parameter');
    const earlier = { ...def, parameters: def.parameters.slice(0, idx).map((p) => ({ ...p, required: false })) };
    const { values } = await resolveParameters(earlier, current, report.workspaceId);
    return parameterOptions(def, name, values, report.workspaceId);
  },

  /** Parameter values with defaults applied (no "required" errors) — fills the viewer's parameter pane. */
  async resolveDefaults(report: Report, current: ParamInput, definition?: unknown) {
    const def = parseReportDefinition(definition ?? report.definition);
    const relaxed = { ...def, parameters: def.parameters.map((p) => ({ ...p, required: false })) };
    const { values } = await resolveParameters(relaxed, current, report.workspaceId);
    return values;
  },

  // ───────────── Snapshots (report history) ─────────────
  async createSnapshot(report: Report, input: ParamInput, a: { id?: string | null; name: string }, label?: string, subscriptionId?: string, existing?: RenderOutput) {
    const out = existing ?? (await this.render(report, input, { userId: a.id, userName: a.name, source: 'snapshot', fresh: true }));
    const json = JSON.stringify(out.model);
    if (json.length > 25 * 1024 * 1024) throw BadRequest('Report output is too large to store as a snapshot (25 MB)');
    const snap = await prisma.reportSnapshot.create({
      data: { reportId: report.id, createdById: a.id ?? null, subscriptionId: subscriptionId ?? null, label: label ?? null, parameters: input as Prisma.InputJsonValue, rendered: out.model as unknown as Prisma.InputJsonValue, rowCount: out.model.rowCount, sizeBytes: json.length },
      select: { id: true, label: true, createdAt: true, rowCount: true, sizeBytes: true },
    });
    // Retention: keep the newest N
    const old = await prisma.reportSnapshot.findMany({ where: { reportId: report.id }, orderBy: { createdAt: 'desc' }, skip: report.snapshotRetention, select: { id: true } });
    if (old.length) await prisma.reportSnapshot.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return snap;
  },

  listSnapshots(reportId: string) {
    return prisma.reportSnapshot.findMany({ where: { reportId }, orderBy: { createdAt: 'desc' }, select: { id: true, label: true, createdAt: true, rowCount: true, sizeBytes: true, parameters: true, subscriptionId: true, createdById: true } });
  },

  async getSnapshot(reportId: string, id: string) {
    const s = await prisma.reportSnapshot.findFirst({ where: { id, reportId } });
    if (!s) throw NotFound('Snapshot');
    return s;
  },

  // ───────────── Subscriptions ─────────────
  listSubscriptions(workspaceId: string, filter: { reportId?: string; ownerId?: string }) {
    return prisma.reportSubscription.findMany({
      where: { report: { workspaceId }, reportId: filter.reportId, ownerId: filter.ownerId },
      orderBy: { createdAt: 'desc' },
      include: { report: { select: { id: true, title: true } } },
    });
  },

  async getSubscription(workspaceId: string, id: string) {
    const s = await prisma.reportSubscription.findFirst({ where: { id, report: { workspaceId } }, include: { report: true } });
    if (!s) throw NotFound('Subscription');
    return s;
  },

  async validateSubscription(report: Report, a: Actor, input: z.infer<typeof subscriptionInputSchema>) {
    const { validate } = await import('node-cron');
    if (!validate(input.cron)) throw BadRequest('Invalid schedule (cron expression)');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw BadRequest(`Unknown time zone "${input.timezone}"`);
    }
    if (input.delivery === 'email' && !input.dataDriven && !input.recipients.length) throw BadRequest('Add at least one recipient');
    if (input.dataDriven) {
      if (!can(a.role, Permissions.DASHBOARD_MANAGE_ALL)) throw Forbidden('Data-driven subscriptions require the Developer or Admin role');
      const ds = await dataSourceRepository.findByIdUnscoped(input.dataDriven.dataSourceId);
      if (!ds || ds.workspaceId !== report.workspaceId) throw BadRequest('Subscriber data source not found');
    }
    // Parameters must resolve now (fail fast instead of at 6am)
    if (!input.dataDriven) await resolveParameters(parseReportDefinition(report.definition), input.parameters, report.workspaceId);
  },

  async createSubscription(report: Report, a: Actor, input: z.infer<typeof subscriptionInputSchema>) {
    await this.validateSubscription(report, a, input);
    return prisma.reportSubscription.create({
      data: { ...input, parameters: input.parameters as Prisma.InputJsonValue, dataDriven: (input.dataDriven ?? undefined) as Prisma.InputJsonValue | undefined, reportId: report.id, ownerId: a.id },
    });
  },

  async updateSubscription(workspaceId: string, id: string, a: Actor, input: z.infer<typeof subscriptionInputSchema>) {
    const s = await this.getSubscription(workspaceId, id);
    if (s.ownerId !== a.id && !can(a.role, Permissions.DASHBOARD_MANAGE_ALL)) throw Forbidden('Only the owner can change this subscription');
    await this.validateSubscription(s.report, a, input);
    return prisma.reportSubscription.update({
      where: { id },
      data: { ...input, parameters: input.parameters as Prisma.InputJsonValue, dataDriven: (input.dataDriven ?? null) as Prisma.InputJsonValue },
    });
  },

  async removeSubscription(workspaceId: string, id: string, a: Actor) {
    const s = await this.getSubscription(workspaceId, id);
    if (s.ownerId !== a.id && !can(a.role, Permissions.DASHBOARD_MANAGE_ALL)) throw Forbidden('Only the owner can delete this subscription');
    await prisma.reportSubscription.delete({ where: { id } });
  },

  deliveries(subscriptionId: string) {
    return prisma.reportDelivery.findMany({ where: { subscriptionId }, orderBy: { startedAt: 'desc' }, take: 100 });
  },

  /** Executes a subscription now (scheduler or "Run now"). */
  async runSubscription(id: string): Promise<{ status: string; delivered: number; failed: number; error?: string }> {
    const sub = await prisma.reportSubscription.findUnique({ where: { id }, include: { report: true } });
    if (!sub) throw NotFound('Subscription');
    const delivery = await prisma.reportDelivery.create({ data: { subscriptionId: id, status: 'running' } });
    const owner = await prisma.user.findUnique({ where: { id: sub.ownerId }, select: { name: true } });
    const userName = owner?.name ?? 'Subscription';
    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];

    type Job = { to: string[]; cc: string[]; params: ParamInput; format: ReportFormat };
    let jobs: Job[] = [];
    try {
      if (sub.dataDriven) {
        const dd = sub.dataDriven as { dataSourceId: string; query: string; emailColumn: string; ccColumn?: string; formatColumn?: string; paramColumns: Record<string, string> };
        const ds = await dataSourceRepository.findByIdUnscoped(dd.dataSourceId);
        if (!ds || ds.workspaceId !== sub.report.workspaceId) throw new Error('Subscriber data source not found');
        const r = await executeQuery(ds, dd.query, { maxRows: 500, user: null });
        jobs = r.rows.map((row) => {
          const params: ParamInput = { ...(sub.parameters as ParamInput) };
          for (const [p, col] of Object.entries(dd.paramColumns)) params[p] = row[col] instanceof Date ? (row[col] as Date).toISOString().slice(0, 10) : row[col];
          const fmt = String(dd.formatColumn ? (row[dd.formatColumn] ?? '') : '').toUpperCase();
          const split = (v: unknown) => String(v ?? '').split(/[;,]/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));
          return { to: split(row[dd.emailColumn]), cc: dd.ccColumn ? split(row[dd.ccColumn]) : [], params, format: (fmt in FORMATS ? fmt : sub.format) as ReportFormat };
        });
        jobs = jobs.filter((j) => j.to.length || sub.delivery === 'snapshot');
      } else {
        jobs = [{ to: sub.recipients, cc: sub.cc, params: sub.parameters as ParamInput, format: sub.format }];
      }
      if (sub.delivery === 'email' && !smtpConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST) — e-mail subscriptions cannot be delivered');

      for (const job of jobs) {
        try {
          const out = await this.render(sub.report, job.params, { userId: sub.ownerId, userName, source: 'subscription', format: job.format, fresh: true });
          if (sub.onlyIfData && out.model.rowCount === 0) {
            skipped++;
            continue;
          }
          if (sub.delivery === 'snapshot') {
            await this.createSnapshot(sub.report, job.params, { id: sub.ownerId, name: userName }, sub.name, sub.id, out);
          } else {
            await deliverEmail(sub, out, job);
          }
          delivered++;
        } catch (e) {
          failed++;
          errors.push(`${job.to.join(', ') || 'snapshot'}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      failed = Math.max(failed, 1);
      errors.push((e as Error).message);
    }

    const status = failed === 0 ? (delivered === 0 && skipped ? 'skipped' : 'success') : delivered ? 'partial' : 'failed';
    const error = errors.slice(0, 20).join('\n') || undefined;
    await prisma.reportDelivery.update({ where: { id: delivery.id }, data: { finishedAt: new Date(), status, delivered, failed, error, details: { jobs: jobs.length, skipped } } });
    await prisma.reportSubscription.update({ where: { id }, data: { lastRunAt: new Date(), lastStatus: status, lastError: error ?? null } });
    if (failed) logger.warn({ subscription: id, errors: errors.slice(0, 5) }, 'Report subscription had failures');
    return { status, delivered, failed, error };
  },

  listExecutions(workspaceId: string, opts: { reportId?: string; take?: number }) {
    return prisma.reportExecution.findMany({ where: { workspaceId, reportId: opts.reportId }, orderBy: { createdAt: 'desc' }, take: Math.min(opts.take ?? 200, 1000) });
  },

  listTemplates() {
    return REPORT_TEMPLATES.map((t) => ({ id: t.id, title: t.title, description: t.description, reports: t.reports.length }));
  },

  async createFromTemplate(workspaceId: string, a: Actor, templateId: string, dataSourceId: string, folder: string) {
    const t = REPORT_TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw NotFound('Template');
    const ds = await dataSourceRepository.findByIdUnscoped(dataSourceId);
    if (!ds || ds.workspaceId !== workspaceId) throw NotFound('Data source');
    const missing: string[] = [];
    for (const table of t.requiredTables) {
      try {
        await executeQuery(ds, `SELECT 1 FROM ${table} WHERE 1 = 0`, { user: null, maxRows: 1 });
      } catch {
        missing.push(table);
      }
    }
    if (missing.length) throw BadRequest(`"${ds.name}" doesn't have the table(s) this template uses: ${missing.join(', ')}. Pick the sample data source (e.g. "Sample Sales DB"), or start from a blank report.`);
    const ids: Record<string, string> = {};
    const created = [];
    // Templates reference each other (drill-through/subreports) by key; create in order and substitute ids
    for (const r of t.reports) {
      const json = JSON.stringify(r.definition).replace(/__DS__/g, dataSourceId).replace(/__REPORT_(\w+)__/g, (_m, k: string) => ids[k] ?? _m);
      const rep = await prisma.report.create({ data: { workspaceId, ownerId: a.id, title: r.title, description: r.description, folder, definition: parseReportDefinition(JSON.parse(json)) as Prisma.InputJsonValue } });
      ids[r.key] = rep.id;
      created.push({ id: rep.id, title: rep.title });
    }
    return created;
  },
};

function subjectFor(template: string | null, m: RenderedReport) {
  const t = template || '{{Globals.ReportName}} — {{Globals.ExecutionTime}}';
  const params = Object.fromEntries(m.parameters.map((p) => [p.name.toLowerCase(), p.display]));
  return t.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_w, e: string) => {
    const x = e.toLowerCase();
    if (x === 'globals.reportname') return m.title;
    if (x === 'globals.executiontime') return new Date(m.executedAt).toLocaleString('en-GB', { timeZone: m.fmt.timezone, dateStyle: 'medium', timeStyle: 'short' });
    if (x.startsWith('parameters.')) return params[x.slice(11)] ?? '';
    return '';
  });
}

async function deliverEmail(sub: { name: string; subject: string | null; comment: string | null; includeLink: boolean; reportId: string }, out: RenderOutput, job: { to: string[]; cc: string[]; params: ParamInput; format: ReportFormat }) {
  const m = out.model;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(job.params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(`p.${k}`, String(x ?? '')));
  const link = `${env.APP_PUBLIC_URL}/reports/${sub.reportId}?${q}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const intro = `${sub.comment ? `<p style="white-space:pre-wrap">${esc(sub.comment)}</p>` : ''}${sub.includeLink ? `<p><a href="${esc(link)}">Open the report in Graphan</a></p>` : ''}`;
  const subject = subjectFor(sub.subject, m);
  if (job.format === 'HTML') {
    // Report rendered in the message body (like SSRS MHTML); charts as inline CID images
    const { html, attachments } = renderHtml(m, { charts: 'cid', bodyOnly: true });
    await sendMail({ to: job.to, cc: job.cc.length ? job.cc : undefined, subject, html: `${intro}${html}`, attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, cid: a.cid })) });
    return;
  }
  const f = FORMATS[job.format];
  const file = await exportRendered(m, job.format, out.data);
  await sendMail({
    to: job.to,
    cc: job.cc.length ? job.cc : undefined,
    subject,
    text: `${sub.comment ?? ''}\n\n${m.title} is attached (${f.ext.toUpperCase()}).${sub.includeLink ? `\n\nOpen in Graphan: ${link}` : ''}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif">${intro}<p>The report <b>${esc(m.title)}</b> is attached as ${f.ext.toUpperCase()}.</p><p style="color:#6B7280;font-size:12px">${m.parameters
      .filter((p) => !p.hidden)
      .map((p) => `${esc(p.label)}: ${esc(p.display)}`)
      .join(' · ')}</p></div>`,
    attachments: [{ filename: fileName(m.title, f.ext, new Date(m.executedAt)), content: file, contentType: f.mime }],
  });
}
