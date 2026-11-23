import cron, { type ScheduledTask } from 'node-cron';
import type { Client as PgClient } from 'pg';
import { env } from '../config/env';
import { loadDriver } from '../connectors/util';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { parseDuration } from '../lib/http';
import { roomSize, Rooms, emit, Events } from '../realtime/socket';
import { dataSourcesService } from '../modules/datasources/datasources.service';
import { evaluateDueRules } from '../modules/alerts/alert.evaluator';
import { dashboardsService } from '../modules/dashboards/dashboards.service';
import { dashboardRepository } from '../modules/dashboards/dashboards.repository';
import { purgeExpiredTokens } from '../modules/auth/auth.service';
import { purgeOldHistory } from '../modules/queries/query.service';
import { reportsService } from '../modules/reports/reports.service';

/** Arbitrary constant identifying Graphan's scheduler lock in pg_advisory_lock space. */
const LEADER_LOCK_KEY = 727_431_001;

/**
 * Background jobs run on exactly one replica at a time. Leadership is acquired with a
 * session-level Postgres advisory lock held on a dedicated connection.
 */
class Scheduler {
  private tasks: ScheduledTask[] = [];
  private dashboardTasks = new Map<string, ScheduledTask>();
  private subscriptionTasks = new Map<string, ScheduledTask>();
  private lastLiveTick = new Map<string, number>();
  private leader = false;
  private electionTimer?: NodeJS.Timeout;
  private running = new Set<string>();

  async start() {
    await this.tryBecomeLeader();
    this.electionTimer = setInterval(() => void this.tryBecomeLeader(), 30_000);
    this.electionTimer.unref();

    // Live refresh fan-out runs on every replica (it only signals local sockets)
    this.tasks.push(cron.schedule('*/5 * * * * *', () => void this.guard('live', () => this.liveRefreshTick())));
  }

  private lockClient?: PgClient;
  private leaderTasks: ScheduledTask[] = [];

  private async tryBecomeLeader() {
    if (this.leader) {
      // Verify the lock connection is still alive; losing it means losing the lock
      try {
        await this.lockClient!.query('SELECT 1');
      } catch {
        this.stepDown('lock connection lost');
      }
      return;
    }
    try {
      if (!this.lockClient) {
        const { Client } = loadDriver<typeof import('pg')>('pg');
        // Strip Prisma-specific query params (e.g. ?schema=public)
        this.lockClient = new Client({ connectionString: env.DATABASE_URL.split('?')[0], application_name: 'graphan-scheduler' });
        this.lockClient.on('error', () => this.stepDown('lock connection error'));
        await this.lockClient.connect();
      }
      const r = await this.lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LEADER_LOCK_KEY]);
      if (r.rows[0]?.locked) {
        this.leader = true;
        logger.info('Scheduler leadership acquired');
        this.startLeaderJobs();
      }
    } catch (err) {
      logger.warn({ err }, 'Leader election failed');
      this.lockClient?.end().catch(() => undefined);
      this.lockClient = undefined;
    }
  }

  private stepDown(reason: string) {
    if (!this.leader) return;
    logger.warn({ reason }, 'Scheduler leadership lost');
    this.leader = false;
    this.leaderTasks.forEach((t) => t.stop());
    this.leaderTasks = [];
    this.dashboardTasks.forEach((t) => t.stop());
    this.dashboardTasks.clear();
    this.subscriptionTasks.forEach((t) => t.stop());
    this.subscriptionTasks.clear();
    this.lockClient?.end().catch(() => undefined);
    this.lockClient = undefined;
  }

  private startLeaderJobs() {
    this.leaderTasks.push(
      cron.schedule('*/30 * * * * *', () => void this.guard('health', () => dataSourcesService.checkAll())),
      cron.schedule('*/10 * * * * *', () => void this.guard('alerts', () => evaluateDueRules())),
      cron.schedule('0 * * * *', () => void this.guard('cleanup', () => this.cleanup())),
      cron.schedule('*/1 * * * *', () => void this.guard('schedules', () => this.syncDashboardSchedules())),
      cron.schedule('*/1 * * * *', () => void this.guard('subscriptions', () => this.syncSubscriptions())),
    );
    void this.syncDashboardSchedules();
    void this.syncSubscriptions();
  }

  /** Prevents overlapping runs of the same job. */
  private async guard(name: string, fn: () => Promise<unknown>) {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      logger.error({ err, job: name }, 'Scheduled job failed');
    } finally {
      this.running.delete(name);
    }
  }

  /**
   * For dashboards with an auto-refresh interval and at least one live viewer, tell the
   * viewers to refetch. Clients also poll as a fallback, so this only tightens latency.
   */
  private async liveRefreshTick() {
    const dashboards = await prisma.dashboard.findMany({ where: { refreshInterval: { not: null } }, select: { id: true, refreshInterval: true } });
    const now = Date.now();
    for (const d of dashboards) {
      if (!roomSize(Rooms.dashboard(d.id))) continue;
      let every: number;
      try {
        every = parseDuration(d.refreshInterval!);
      } catch {
        continue;
      }
      if (now - (this.lastLiveTick.get(d.id) ?? 0) >= every) {
        this.lastLiveTick.set(d.id, now);
        emit(Rooms.dashboard(d.id), Events.DASHBOARD_REFRESH, { id: d.id, at: new Date(now).toISOString() });
      }
    }
  }

  /** Reconciles per-dashboard cron jobs (cache pre-warming) with the database. */
  private async syncDashboardSchedules() {
    const list = (await dashboardRepository.listScheduled()).filter((d) => d.scheduleCron && cron.validate(d.scheduleCron));
    const wanted = new Map(list.map((d) => [d.id, d.scheduleCron!]));
    for (const [id, task] of this.dashboardTasks) {
      if (!wanted.has(id)) {
        task.stop();
        this.dashboardTasks.delete(id);
      }
    }
    for (const [id, expr] of wanted) {
      const key = `${id}|${expr}`;
      if ([...this.dashboardTasks.keys()].includes(key)) continue;
      for (const k of [...this.dashboardTasks.keys()].filter((k) => k.startsWith(`${id}|`))) {
        this.dashboardTasks.get(k)!.stop();
        this.dashboardTasks.delete(k);
      }
      this.dashboardTasks.set(key, cron.schedule(expr, () => void this.guard(`warm:${id}`, () => dashboardsService.warm(id))));
    }
  }

  /** Reconciles report subscription schedules (cron + time zone) with the database. */
  private async syncSubscriptions() {
    const subs = await prisma.reportSubscription.findMany({ where: { enabled: true }, select: { id: true, cron: true, timezone: true } });
    const wanted = new Map(subs.filter((s) => cron.validate(s.cron)).map((s) => [`${s.id}|${s.cron}|${s.timezone}`, s.id]));
    for (const [key, task] of this.subscriptionTasks) {
      if (!wanted.has(key)) {
        task.stop();
        this.subscriptionTasks.delete(key);
      }
    }
    for (const [key, id] of wanted) {
      if (this.subscriptionTasks.has(key)) continue;
      const tz = key.split('|')[2];
      this.subscriptionTasks.set(
        key,
        cron.schedule(key.split('|')[1], () => void this.guard(`sub:${id}`, () => reportsService.runSubscription(id)), { timezone: tz }),
      );
    }
  }

  private async cleanup() {
    const tokens = await purgeExpiredTokens();
    const history = await purgeOldHistory(90);
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const executions = (await prisma.reportExecution.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
    const deliveries = (await prisma.reportDelivery.deleteMany({ where: { startedAt: { lt: cutoff } } })).count;
    logger.info({ tokens, history, executions, deliveries }, 'Cleanup complete');
  }

  async stop() {
    if (this.electionTimer) clearInterval(this.electionTimer);
    this.tasks.forEach((t) => t.stop());
    this.leaderTasks.forEach((t) => t.stop());
    this.dashboardTasks.forEach((t) => t.stop());
    this.subscriptionTasks.forEach((t) => t.stop());
    // Closing the session releases the advisory lock
    await this.lockClient?.end().catch(() => undefined);
  }
}

export const scheduler = new Scheduler();
