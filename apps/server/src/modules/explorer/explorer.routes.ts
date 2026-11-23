import { Router } from 'express';
import { z } from 'zod';
import { LRUCache } from 'lru-cache';
import { asyncHandler } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { Permissions } from '../../lib/rbac';
import { env } from '../../config/env';
import { poolManager } from '../../connectors/pool-manager';
import { objectDdl } from '../../connectors/ddl';
import { dataSourcesService } from '../datasources/datasources.service';

/** Metadata changes rarely; cache explorer responses briefly to keep the UI snappy. */
const cache = new LRUCache<string, object>({ max: 2000, ttl: 60_000 });

async function cached<T extends object>(key: string, fresh: boolean, fn: () => Promise<T>): Promise<T> {
  if (!fresh) {
    const hit = cache.get(key);
    if (hit) return hit as T;
  }
  const v = await fn();
  cache.set(key, v);
  return v;
}

export const explorerRouter = Router({ mergeParams: true });
explorerRouter.use(requirePermission(Permissions.EXPLORER_READ));

const conn = async (workspaceId: string, id: string) => poolManager.get(await dataSourcesService.get(workspaceId, id));

explorerRouter.get(
  '/:dsId/schemas',
  asyncHandler(async (req, res) => {
    const c = await conn(req.workspace!.id, req.params.dsId);
    res.json(await cached(`${req.params.dsId}:schemas`, req.query.fresh === '1', async () => ({ schemas: await c.listSchemas() })));
  }),
);

explorerRouter.get(
  '/:dsId/schemas/:schema/objects',
  asyncHandler(async (req, res) => {
    const { dsId, schema } = req.params;
    const c = await conn(req.workspace!.id, dsId);
    res.json(await cached(`${dsId}:objects:${schema}`, req.query.fresh === '1', async () => ({ objects: await c.listObjects(schema) })));
  }),
);

explorerRouter.get(
  '/:dsId/schemas/:schema/tables/:table',
  asyncHandler(async (req, res) => {
    const { dsId, schema, table } = req.params;
    const c = await conn(req.workspace!.id, dsId);
    res.json(await cached(`${dsId}:describe:${schema}.${table}`, req.query.fresh === '1', () => c.describeTable(schema, table)));
  }),
);

const previewSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

explorerRouter.get(
  '/:dsId/schemas/:schema/tables/:table/preview',
  validate(previewSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { dsId, schema, table } = req.params;
    const { limit, offset } = req.query as unknown as z.infer<typeof previewSchema>;
    const c = await conn(req.workspace!.id, dsId);
    res.json(await c.previewTable(schema, table, limit, offset, { maxRows: limit, timeoutMs: env.QUERY_TIMEOUT_MS }));
  }),
);

explorerRouter.get(
  '/:dsId/completion',
  asyncHandler(async (req, res) => {
    const { dsId } = req.params;
    const schema = typeof req.query.schema === 'string' ? req.query.schema : undefined;
    const c = await conn(req.workspace!.id, dsId);
    res.json(await cached(`${dsId}:completion:${schema ?? ''}`, false, async () => ({ tables: await c.completionCatalog(schema) })));
  }),
);

const ddlSchema = z.object({
  name: z.string().min(1).max(256),
  kind: z.enum(['table', 'view', 'materialized_view', 'procedure', 'function', 'sequence', 'collection']).default('table'),
});

/** CREATE script for an object (pgAdmin "SQL" pane / Scripts → CREATE). */
explorerRouter.get(
  '/:dsId/schemas/:schema/ddl',
  validate(ddlSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { name, kind } = req.query as unknown as z.infer<typeof ddlSchema>;
    const c = await conn(req.workspace!.id, req.params.dsId);
    res.json({ ddl: await objectDdl(c, req.params.schema, name, kind) });
  }),
);

/** Searches table and column names across one schema (uses the completion catalog). */
explorerRouter.get(
  '/:dsId/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase().trim();
    if (q.length < 2) return res.json({ results: [] });
    const schema = typeof req.query.schema === 'string' ? req.query.schema : undefined;
    const c = await conn(req.workspace!.id, req.params.dsId);
    const catalog = await cached(`${req.params.dsId}:completion:${schema ?? ''}`, false, async () => ({ tables: await c.completionCatalog(schema) }));
    const results: { kind: 'table' | 'column'; schema: string; table: string; column?: string }[] = [];
    for (const t of catalog.tables) {
      if (t.table.toLowerCase().includes(q)) results.push({ kind: 'table', schema: t.schema, table: t.table });
      for (const col of t.columns) if (col.toLowerCase().includes(q)) results.push({ kind: 'column', schema: t.schema, table: t.table, column: col });
      if (results.length >= 200) break;
    }
    res.json({ results });
  }),
);
