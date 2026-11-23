import type { DataSource, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { AppError, BadRequest, Forbidden } from '../../lib/errors';
import { can, Permissions } from '../../lib/rbac';
import { poolManager } from '../../connectors/pool-manager';
import { assertReadOnly } from '../../connectors/sql-guard';
import { buildQuery, type BuildContext } from '../../connectors/query-builder';
import type { QueryResult } from '../../connectors/types';

export interface ExecuteOptions {
  ctx?: BuildContext;
  maxRows?: number;
  timeoutMs?: number;
  /** Record into the user's query history */
  recordHistory?: boolean;
  /** Who is executing; null = system (alerts / scheduler) */
  user?: { id: string; role: Role } | null;
  /** Cancels the running statement when aborted (client disconnect / cancel button) */
  signal?: AbortSignal;
  /** Always roll back (EXPLAIN ANALYZE) */
  rollback?: boolean;
}

/**
 * Executes a query against a data source with guard rails:
 * - read-only sources and users without write permission only run read statements
 * - macros/variables are bound as parameters
 * - row caps and statement timeouts are always enforced
 */
export async function executeQuery(ds: DataSource, sql: string, opts: ExecuteOptions = {}): Promise<QueryResult> {
  if (!sql.trim()) throw BadRequest('Query is empty');
  const mustBeReadOnly = ds.readOnly || !opts.user || !can(opts.user.role, Permissions.QUERY_WRITE_EXECUTE);
  if (mustBeReadOnly) {
    if (ds.type === 'MONGODB') {
      if (/"\$(out|merge)"/.test(sql)) throw Forbidden('$out/$merge stages require write permission');
    } else {
      const g = assertReadOnly(sql);
      if (!g.ok) throw Forbidden(g.reason);
    }
  }
  const connector = await poolManager.get(ds);
  const built = buildQuery(connector, sql, opts.ctx);
  const maxRows = Math.min(opts.maxRows ?? env.QUERY_MAX_ROWS, 200_000);
  const timeoutMs = Math.min(opts.timeoutMs ?? env.QUERY_TIMEOUT_MS, 300_000);
  const started = Date.now();
  try {
    const result = await connector.query(built.text, built.params, { maxRows, timeoutMs, signal: opts.signal, rollback: opts.rollback });
    if (opts.recordHistory && opts.user) {
      void recordHistory(ds.id, opts.user.id, sql, result.durationMs, result.rowCount, true);
    }
    return result;
  } catch (e) {
    if (opts.recordHistory && opts.user) {
      void recordHistory(ds.id, opts.user.id, sql, Date.now() - started, null, false, (e as Error).message);
    }
    // Surface driver diagnostics (pgAdmin-style): position is only meaningful if macros didn't rewrite the text
    const pe = e as { message: string; position?: string; hint?: string; detail?: string; code?: string; where?: string };
    throw new AppError(400, `Query failed: ${pe.message}`, 'QUERY_ERROR', {
      position: built.text === sql && pe.position ? Number(pe.position) : undefined,
      hint: pe.hint,
      detail: pe.detail,
      code: pe.code,
      where: pe.where,
    });
  }
}

export interface ExplainResult {
  format: 'postgres-json' | 'text';
  plan?: unknown;
  text?: string;
  durationMs: number;
}

/**
 * EXPLAIN / EXPLAIN ANALYZE for a single statement. ANALYZE always runs inside a rolled-back
 * transaction and only for statements that pass the read-only guard, so it never persists changes.
 */
export async function explainQuery(ds: DataSource, sql: string, analyze: boolean, opts: ExecuteOptions): Promise<ExplainResult> {
  const stmt = sql.trim().replace(/;\s*$/, '');
  if (analyze) {
    const g = assertReadOnly(stmt);
    if (!g.ok) throw Forbidden(`EXPLAIN ANALYZE executes the statement — ${g.reason}`);
  }
  const run = (text: string) => executeQuery(ds, text, { ...opts, recordHistory: false, rollback: true, maxRows: 100_000 });
  switch (ds.type) {
    case 'POSTGRES': {
      const r = await run(`EXPLAIN (FORMAT JSON, VERBOSE${analyze ? ', ANALYZE, BUFFERS' : ''}) ${stmt}`);
      const cell = Object.values(r.rows[0] ?? {})[0];
      return { format: 'postgres-json', plan: typeof cell === 'string' ? JSON.parse(cell) : cell, durationMs: r.durationMs };
    }
    case 'MYSQL': {
      const r = await run(analyze ? `EXPLAIN ANALYZE ${stmt}` : `EXPLAIN FORMAT=TREE ${stmt}`);
      return { format: 'text', text: r.rows.map((row) => String(Object.values(row)[0])).join('\n'), durationMs: r.durationMs };
    }
    case 'SQLITE': {
      const r = await run(`EXPLAIN QUERY PLAN ${stmt}`);
      const depth = new Map<number, number>();
      const lines = r.rows.map((row) => {
        const d = (depth.get(Number(row.parent)) ?? -1) + 1;
        depth.set(Number(row.id), d);
        return `${'  '.repeat(d)}${d ? '└─ ' : ''}${row.detail}`;
      });
      return { format: 'text', text: lines.join('\n'), durationMs: r.durationMs };
    }
    default:
      throw BadRequest(`EXPLAIN is not supported for ${ds.type} data sources yet`);
  }
}

async function recordHistory(dataSourceId: string, userId: string, sql: string, durationMs: number, rowCount: number | null, success: boolean, error?: string) {
  await prisma.queryHistory
    .create({ data: { dataSourceId, userId, sql: sql.slice(0, 50_000), durationMs, rowCount, success, error: error?.slice(0, 2000) } })
    .catch(() => undefined);
}

export async function purgeOldHistory(days = 90) {
  const { count } = await prisma.queryHistory.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - days * 864e5) } } });
  return count;
}
