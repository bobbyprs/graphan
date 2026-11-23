import { Router } from 'express';
import { z } from 'zod';
import { ChannelType, type Prisma } from '@prisma/client';
import { asyncHandler, parsePagination } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/auth';
import { Permissions } from '../../lib/rbac';
import { prisma } from '../../lib/prisma';
import { encrypt } from '../../lib/crypto';
import { BadRequest, NotFound } from '../../lib/errors';
import { audit } from '../audit/audit.service';
import { dataSourcesService } from '../datasources/datasources.service';
import { conditionSchema, evaluateOnce, evaluateRule } from './alert.evaluator';
import { isAllowedTeamsWebhook, notifyChannel } from './notifiers';

const ruleSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  dataSourceId: z.string().uuid(),
  query: z.string().min(1).max(50_000),
  condition: conditionSchema,
  intervalSeconds: z.number().int().min(10).max(86_400).default(60),
  forSeconds: z.number().int().min(0).max(86_400).default(0),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  enabled: z.boolean().default(true),
  channelIds: z.array(z.string().uuid()).max(20).default([]),
});

const channelSchema = z.discriminatedUnion('type', [
  z.object({ name: z.string().min(1).max(100), type: z.literal(ChannelType.EMAIL), recipients: z.array(z.string().email()).min(1).max(50) }),
  z.object({
    name: z.string().min(1).max(100),
    type: z.literal(ChannelType.TEAMS),
    webhookUrl: z.string().url().refine(isAllowedTeamsWebhook, 'Must be an https Microsoft Teams / Power Automate webhook URL'),
  }),
]);

function channelConfig(b: z.infer<typeof channelSchema>): Prisma.InputJsonValue {
  return b.type === 'EMAIL' ? { recipients: b.recipients } : { webhookUrlEncrypted: encrypt(b.webhookUrl), webhookHost: new URL(b.webhookUrl).hostname };
}

function publicChannel<T extends { config: Prisma.JsonValue }>(c: T) {
  const cfg = { ...(c.config as Record<string, unknown>) };
  delete cfg.webhookUrlEncrypted;
  return { ...c, config: cfg };
}

export const alertsRouter = Router();
alertsRouter.use(requirePermission(Permissions.ALERT_READ));

// ── Channels ──
alertsRouter.get(
  '/channels',
  asyncHandler(async (req, res) => {
    const list = await prisma.notificationChannel.findMany({ where: { workspaceId: req.workspace!.id }, orderBy: { name: 'asc' } });
    res.json(list.map(publicChannel));
  }),
);

alertsRouter.post(
  '/channels',
  requirePermission(Permissions.ALERT_MANAGE),
  validate(channelSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof channelSchema>;
    const c = await prisma.notificationChannel.create({ data: { workspaceId: req.workspace!.id, name: b.name, type: b.type, config: channelConfig(b) } });
    audit(req, { action: 'alert.channel_create', entityType: 'channel', entityId: c.id });
    res.status(201).json(publicChannel(c));
  }),
);

alertsRouter.post(
  '/channels/:id/test',
  requirePermission(Permissions.ALERT_MANAGE),
  asyncHandler(async (req, res) => {
    const c = await prisma.notificationChannel.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!c) throw NotFound('Channel');
    try {
      await notifyChannel(c, { ruleId: 'test', ruleName: 'Test notification', state: 'OK', severity: 'info', value: 42, message: 'This is a test notification from Graphan.', workspaceName: '' });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  }),
);

alertsRouter.delete(
  '/channels/:id',
  requirePermission(Permissions.ALERT_MANAGE),
  asyncHandler(async (req, res) => {
    const { count } = await prisma.notificationChannel.deleteMany({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!count) throw NotFound('Channel');
    audit(req, { action: 'alert.channel_delete', entityType: 'channel', entityId: req.params.id });
    res.status(204).end();
  }),
);

// ── Rules ──
const ruleInclude = {
  dataSource: { select: { id: true, name: true, type: true } },
  channels: { select: { channel: { select: { id: true, name: true, type: true } } } },
} satisfies Prisma.AlertRuleInclude;

alertsRouter.get(
  '/rules',
  asyncHandler(async (req, res) => {
    res.json(await prisma.alertRule.findMany({ where: { workspaceId: req.workspace!.id }, include: ruleInclude, orderBy: [{ state: 'asc' }, { name: 'asc' }] }));
  }),
);

alertsRouter.get(
  '/rules/:id',
  asyncHandler(async (req, res) => {
    const r = await prisma.alertRule.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id }, include: ruleInclude });
    if (!r) throw NotFound('Alert rule');
    res.json(r);
  }),
);

async function validateRefs(workspaceId: string, dataSourceId: string | undefined, channelIds: string[] | undefined) {
  if (dataSourceId) await dataSourcesService.get(workspaceId, dataSourceId);
  if (channelIds?.length) {
    const n = await prisma.notificationChannel.count({ where: { workspaceId, id: { in: channelIds } } });
    if (n !== new Set(channelIds).size) throw BadRequest('Unknown notification channel');
  }
}

alertsRouter.post(
  '/rules',
  requirePermission(Permissions.ALERT_MANAGE),
  validate(ruleSchema),
  asyncHandler(async (req, res) => {
    const { channelIds, ...b } = req.body as z.infer<typeof ruleSchema>;
    await validateRefs(req.workspace!.id, b.dataSourceId, channelIds);
    const r = await prisma.alertRule.create({
      data: { ...b, workspaceId: req.workspace!.id, createdById: req.user!.id, channels: { create: channelIds.map((channelId) => ({ channelId })) } },
      include: ruleInclude,
    });
    audit(req, { action: 'alert.rule_create', entityType: 'alert', entityId: r.id, metadata: { name: r.name } });
    res.status(201).json(r);
  }),
);

alertsRouter.put(
  '/rules/:id',
  requirePermission(Permissions.ALERT_MANAGE),
  validate(ruleSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.alertRule.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!existing) throw NotFound('Alert rule');
    const { channelIds, ...b } = req.body as Partial<z.infer<typeof ruleSchema>>;
    await validateRefs(req.workspace!.id, b.dataSourceId, channelIds);
    const r = await prisma.alertRule.update({
      where: { id: existing.id },
      data: {
        ...b,
        ...(b.enabled === false ? { state: 'OK', pendingSince: null } : {}),
        channels: channelIds ? { deleteMany: {}, create: channelIds.map((channelId) => ({ channelId })) } : undefined,
      },
      include: ruleInclude,
    });
    audit(req, { action: 'alert.rule_update', entityType: 'alert', entityId: r.id });
    res.json(r);
  }),
);

alertsRouter.delete(
  '/rules/:id',
  requirePermission(Permissions.ALERT_MANAGE),
  asyncHandler(async (req, res) => {
    const { count } = await prisma.alertRule.deleteMany({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!count) throw NotFound('Alert rule');
    audit(req, { action: 'alert.rule_delete', entityType: 'alert', entityId: req.params.id });
    res.status(204).end();
  }),
);

/** Dry-run: evaluates the (unsaved) rule without changing state or notifying. */
alertsRouter.post(
  '/rules/test',
  requirePermission(Permissions.ALERT_MANAGE),
  validate(ruleSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof ruleSchema>;
    await dataSourcesService.get(req.workspace!.id, b.dataSourceId);
    const fake = { ...b, id: 'test', workspaceId: req.workspace!.id, state: 'OK', pendingSince: null } as unknown as Parameters<typeof evaluateOnce>[0];
    res.json(await evaluateOnce(fake));
  }),
);

alertsRouter.post(
  '/rules/:id/evaluate',
  requirePermission(Permissions.ALERT_MANAGE),
  asyncHandler(async (req, res) => {
    const r = await prisma.alertRule.findFirst({ where: { id: req.params.id, workspaceId: req.workspace!.id } });
    if (!r) throw NotFound('Alert rule');
    res.json(await evaluateRule(r));
  }),
);

// ── History & acknowledgement ──
alertsRouter.get(
  '/events',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 100, max: 500 });
    const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined;
    const unacked = req.query.unacknowledged === '1';
    const where: Prisma.AlertEventWhereInput = {
      rule: { workspaceId: req.workspace!.id },
      ruleId,
      ...(unacked ? { acknowledgedAt: null, toState: { in: ['FIRING', 'ERROR'] } } : {}),
    };
    const [items, total] = await prisma.$transaction([
      prisma.alertEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { rule: { select: { id: true, name: true, severity: true } }, ackUser: { select: { id: true, name: true } } },
      }),
      prisma.alertEvent.count({ where }),
    ]);
    res.json({ items, total });
  }),
);

alertsRouter.post(
  '/events/:id/ack',
  requirePermission(Permissions.ALERT_ACK),
  asyncHandler(async (req, res) => {
    const ev = await prisma.alertEvent.findFirst({ where: { id: req.params.id, rule: { workspaceId: req.workspace!.id } } });
    if (!ev) throw NotFound('Alert event');
    const updated = await prisma.alertEvent.update({ where: { id: ev.id }, data: { acknowledgedAt: new Date(), acknowledgedBy: req.user!.id } });
    audit(req, { action: 'alert.ack', entityType: 'alert_event', entityId: ev.id });
    res.json(updated);
  }),
);
