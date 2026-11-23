import { z } from 'zod';
import type { AlertRule, AlertState } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { parseTimeRange } from '../../lib/time';
import { emit, Events, Rooms } from '../../realtime/socket';
import { executeQuery } from '../queries/query.service';
import { notifyChannel } from './notifiers';

export const conditionSchema = z.object({
  field: z.string().min(1),
  reducer: z.enum(['last', 'avg', 'min', 'max', 'sum', 'count']).default('last'),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: z.number(),
  /** Time window passed to $__timeFrom/$__timeTo, e.g. "now-15m" */
  lookback: z.string().regex(/^now-\d+[smhd]$/).default('now-15m'),
  /** State when the query returns no rows */
  noDataState: z.enum(['OK', 'NO_DATA', 'FIRING']).default('NO_DATA'),
});
export type AlertCondition = z.infer<typeof conditionSchema>;

export function reduce(values: number[], reducer: AlertCondition['reducer']): number | null {
  if (!values.length) return null;
  switch (reducer) {
    case 'last':
      return values[values.length - 1];
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'count':
      return values.length;
  }
}

export function compare(v: number, op: AlertCondition['operator'], t: number): boolean {
  return { gt: v > t, gte: v >= t, lt: v < t, lte: v <= t, eq: v === t, neq: v !== t }[op];
}

const OP_TEXT = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

export interface EvaluationResult {
  state: AlertState;
  value: number | null;
  message: string;
}

export async function evaluateOnce(rule: AlertRule): Promise<EvaluationResult> {
  const cond = conditionSchema.parse(rule.condition);
  const ds = await prisma.dataSource.findUnique({ where: { id: rule.dataSourceId } });
  if (!ds) return { state: 'ERROR', value: null, message: 'Data source no longer exists' };
  try {
    const result = await executeQuery(ds, rule.query, {
      user: null,
      maxRows: 10_000,
      ctx: { timeRange: parseTimeRange({ from: cond.lookback, to: 'now' }) },
    });
    const values = result.rows.map((r) => Number(r[cond.field])).filter((n) => Number.isFinite(n));
    const value = reduce(values, cond.reducer);
    if (value === null) {
      return { state: cond.noDataState === 'OK' ? 'OK' : cond.noDataState, value: null, message: 'Query returned no numeric data' };
    }
    const breached = compare(value, cond.operator, cond.threshold);
    return {
      state: breached ? 'FIRING' : 'OK',
      value,
      message: `${cond.reducer}(${cond.field}) = ${Number(value.toFixed(4))} ${breached ? '' : 'not '}${OP_TEXT[cond.operator]} ${cond.threshold}`,
    };
  } catch (e) {
    return { state: 'ERROR', value: null, message: (e as Error).message.slice(0, 500) };
  }
}

/**
 * Evaluates a rule and applies the state machine:
 *   OK ──breach──▶ PENDING ──(held for forSeconds)──▶ FIRING ──recover──▶ OK
 * Notifications are sent on transitions into FIRING / ERROR and on resolution.
 */
export async function evaluateRule(rule: AlertRule) {
  const r = await evaluateOnce(rule);
  const now = new Date();
  let next: AlertState = r.state;
  let pendingSince = rule.pendingSince;

  if (r.state === 'FIRING') {
    if (rule.forSeconds > 0 && rule.state !== 'FIRING') {
      pendingSince ??= now;
      next = now.getTime() - pendingSince.getTime() >= rule.forSeconds * 1000 ? 'FIRING' : 'PENDING';
    }
  } else {
    pendingSince = null;
  }
  if (next === 'FIRING') pendingSince = null;

  await prisma.alertRule.update({
    where: { id: rule.id },
    data: { state: next, pendingSince, lastEvaluatedAt: now, lastValue: r.value },
  });

  if (next !== rule.state) {
    await prisma.alertEvent.create({ data: { ruleId: rule.id, fromState: rule.state, toState: next, value: r.value, message: r.message } });
    emit(Rooms.workspace(rule.workspaceId), Events.ALERT_STATE, { ruleId: rule.id, name: rule.name, from: rule.state, to: next, value: r.value, message: r.message });
    const shouldNotify = next === 'FIRING' || next === 'ERROR' || (next === 'OK' && (rule.state === 'FIRING' || rule.state === 'ERROR'));
    if (shouldNotify) await dispatch(rule, next, r);
  }
  return { ...r, state: next };
}

async function dispatch(rule: AlertRule, state: AlertState, r: EvaluationResult) {
  const links = await prisma.alertRuleChannel.findMany({ where: { ruleId: rule.id }, include: { channel: true } });
  if (!links.length) return;
  const ws = await prisma.workspace.findUnique({ where: { id: rule.workspaceId }, select: { name: true } });
  const payload = {
    ruleId: rule.id,
    ruleName: rule.name,
    state: state as 'FIRING' | 'OK' | 'ERROR' | 'NO_DATA',
    severity: rule.severity,
    value: r.value,
    message: state === 'OK' ? `Resolved: ${r.message}` : r.message,
    workspaceName: ws?.name ?? '',
  };
  await Promise.allSettled(links.map((l) => notifyChannel(l.channel, payload)));
}

/** Picks rules that are due and evaluates them with bounded concurrency. */
export async function evaluateDueRules() {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
  const now = Date.now();
  const due = rules.filter((r) => !r.lastEvaluatedAt || now - r.lastEvaluatedAt.getTime() >= r.intervalSeconds * 1000 - 500);
  const queue = [...due];
  await Promise.all(
    Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length) {
        const rule = queue.shift()!;
        await evaluateRule(rule).catch((err) => logger.error({ err, rule: rule.id }, 'Alert evaluation failed'));
      }
    }),
  );
  return due.length;
}
