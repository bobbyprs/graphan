import type { Dashboard, DashboardPermission, PermissionLevel, Prisma, Role } from '@prisma/client';
import { LRUCache } from 'lru-cache';
import { prisma } from '../../lib/prisma';
import { randomToken, sha256 } from '../../lib/crypto';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../lib/errors';
import { can, Permissions } from '../../lib/rbac';
import { parseTimeRange } from '../../lib/time';
import { emit, Events, Rooms } from '../../realtime/socket';
import type { QueryResult } from '../../connectors/types';
import type { VariableValue } from '../../connectors/query-builder';
import { dataSourceRepository } from '../datasources/datasources.repository';
import { executeQuery } from '../queries/query.service';
import { applyTransforms } from '../queries/transforms';
import { dashboardRepository as repo } from './dashboards.repository';
import {
  dashboardDefinitionSchema,
  type DashboardDefinition,
  type Panel,
  type dashboardInputSchema,
  type dashboardUpdateSchema,
  type panelDataRequestSchema,
} from './dashboard.schema';
import { BUILTIN_TEMPLATES, instantiateTemplate } from './templates';
import type { z } from 'zod';

type Actor = { id: string; role: Role };
const LEVEL_RANK: Record<PermissionLevel, number> = { VIEW: 1, EDIT: 2, ADMIN: 3 };

/** Panel result cache. Keyed by dashboard version + panel + resolved parameters. */
const panelCache = new LRUCache<string, QueryResult>({ max: 5000, maxSize: 200 * 1024 * 1024, sizeCalculation: (v) => Math.max(1, JSON.stringify(v.rows).length) });

async function teamIdsOf(userId: string) {
  return (await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } })).map((t) => t.teamId);
}

export async function effectiveLevel(
  d: Pick<Dashboard, 'ownerId' | 'isPrivate'> & { permissions: DashboardPermission[] },
  actor: Actor,
): Promise<PermissionLevel | null> {
  if (d.ownerId === actor.id || can(actor.role, Permissions.DASHBOARD_MANAGE_ALL)) return 'ADMIN';
  const teams = new Set(await teamIdsOf(actor.id));
  let best: PermissionLevel | null = d.isPrivate ? null : 'VIEW';
  for (const p of d.permissions) {
    if (p.userId === actor.id || (p.teamId && teams.has(p.teamId))) {
      if (!best || LEVEL_RANK[p.level] > LEVEL_RANK[best]) best = p.level;
    }
  }
  return best;
}

export function parseDefinition(raw: Prisma.JsonValue): DashboardDefinition {
  return dashboardDefinitionSchema.parse(raw);
}

/** Every data source referenced by the definition must belong to the workspace. */
async function assertDataSourcesInWorkspace(workspaceId: string, def: DashboardDefinition) {
  const ids = new Set<string>();
  def.panels.forEach((p) => p.dataSourceId && ids.add(p.dataSourceId));
  def.variables.forEach((v) => v.dataSourceId && ids.add(v.dataSourceId));
  if (!ids.size) return;
  const found = await prisma.dataSource.count({ where: { id: { in: [...ids] }, workspaceId } });
  if (found !== ids.size) throw BadRequest('Dashboard references data sources outside this workspace');
}

export const dashboardsService = {
  async list(workspaceId: string, actor: Actor, search?: string) {
    return repo.listVisible(workspaceId, actor.id, await teamIdsOf(actor.id), can(actor.role, Permissions.DASHBOARD_MANAGE_ALL), search);
  },

  async getWithAccess(workspaceId: string, id: string, actor: Actor, min: PermissionLevel = 'VIEW') {
    const d = await repo.findById(id);
    if (!d || d.workspaceId !== workspaceId) throw NotFound('Dashboard');
    const level = await effectiveLevel(d, actor);
    if (!level || LEVEL_RANK[level] < LEVEL_RANK[min]) throw Forbidden('Insufficient dashboard permission');
    return { dashboard: d, level };
  },

  async create(workspaceId: string, actor: Actor, input: z.infer<typeof dashboardInputSchema>) {
    await assertDataSourcesInWorkspace(workspaceId, input.definition);
    return repo.create({
      workspaceId,
      ownerId: actor.id,
      title: input.title,
      description: input.description,
      tags: input.tags,
      folderId: input.folderId,
      refreshInterval: input.refreshInterval,
      scheduleCron: input.scheduleCron,
      isPrivate: input.isPrivate,
      isTemplate: input.isTemplate,
      definition: input.definition as Prisma.InputJsonValue,
    });
  },

  async update(workspaceId: string, id: string, actor: Actor, input: z.infer<typeof dashboardUpdateSchema>) {
    await this.getWithAccess(workspaceId, id, actor, 'EDIT');
    if (input.definition) await assertDataSourcesInWorkspace(workspaceId, input.definition);
    const { version, message, definition, ...rest } = input;
    const updated = await repo.updateVersioned(
      id,
      version,
      { ...rest, definition: definition as Prisma.InputJsonValue | undefined },
      actor.id,
      message,
    );
    if (!updated) throw Conflict('Dashboard was modified by someone else. Reload to get the latest version.');
    emit(Rooms.dashboard(id), Events.DASHBOARD_UPDATED, { id, version: updated.version, by: actor.id });
    return updated;
  },

  async remove(workspaceId: string, id: string, actor: Actor) {
    await this.getWithAccess(workspaceId, id, actor, 'ADMIN');
    await repo.delete(id);
  },

  async duplicate(workspaceId: string, id: string, actor: Actor, title?: string) {
    const { dashboard } = await this.getWithAccess(workspaceId, id, actor, 'VIEW');
    return repo.create({
      workspaceId,
      ownerId: actor.id,
      title: title ?? `${dashboard.title} (copy)`,
      description: dashboard.description,
      tags: dashboard.tags,
      refreshInterval: dashboard.refreshInterval,
      definition: dashboard.definition as Prisma.InputJsonValue,
    });
  },

  async restoreVersion(workspaceId: string, id: string, actor: Actor, version: number) {
    const { dashboard } = await this.getWithAccess(workspaceId, id, actor, 'EDIT');
    const v = await repo.getVersion(id, version);
    if (!v) throw NotFound('Version');
    return this.update(workspaceId, id, actor, {
      version: dashboard.version,
      definition: parseDefinition(v.definition),
      message: `Restored version ${version}`,
    });
  },

  async setPermissions(workspaceId: string, id: string, actor: Actor, grants: { userId?: string; teamId?: string; level: PermissionLevel }[]) {
    await this.getWithAccess(workspaceId, id, actor, 'ADMIN');
    const userIds = grants.flatMap((g) => (g.userId ? [g.userId] : []));
    const teamIds = grants.flatMap((g) => (g.teamId ? [g.teamId] : []));
    const [u, t] = await Promise.all([
      prisma.workspaceMember.count({ where: { workspaceId, userId: { in: userIds } } }),
      prisma.team.count({ where: { workspaceId, id: { in: teamIds } } }),
    ]);
    if (u !== new Set(userIds).size || t !== new Set(teamIds).size) throw BadRequest('Grants must reference workspace members/teams');
    await repo.replacePermissions(id, grants);
  },

  async setSharing(workspaceId: string, id: string, actor: Actor, enabled: boolean) {
    await this.getWithAccess(workspaceId, id, actor, 'ADMIN');
    return repo.update(id, { shareToken: enabled ? randomToken(24) : null });
  },

  async setEmbedding(workspaceId: string, id: string, actor: Actor, enabled: boolean) {
    await this.getWithAccess(workspaceId, id, actor, 'ADMIN');
    return repo.update(id, { embedEnabled: enabled });
  },

  listTemplates() {
    return BUILTIN_TEMPLATES.map(({ definition, ...t }) => ({ ...t, panelCount: definition.panels.length }));
  },

  async createFromTemplate(workspaceId: string, actor: Actor, templateId: string, dataSourceId: string | null, title?: string) {
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === templateId);
    if (tpl) {
      // Fail fast with a clear message instead of creating a dashboard full of broken panels
      if (tpl.requiredTables?.length) {
        if (!dataSourceId) throw BadRequest(`The "${tpl.title}" template needs a data source`);
        const ds = await dataSourceRepository.findById(workspaceId, dataSourceId);
        if (!ds) throw NotFound('Data source');
        const missing: string[] = [];
        for (const t of tpl.requiredTables) {
          await executeQuery(ds, `SELECT 1 FROM ${t} WHERE 1 = 0`, { user: null }).catch(() => missing.push(t));
        }
        if (missing.length) {
          throw BadRequest(
            `"${ds.name}" doesn't have the table(s) this template uses: ${missing.join(', ')}. ` +
              `Pick a data source with the sample schema (e.g. "Sample Sales DB"), or start from a blank dashboard.`,
          );
        }
      }
      return this.create(workspaceId, actor, {
        title: title ?? tpl.title,
        description: tpl.description,
        tags: tpl.tags,
        refreshInterval: tpl.refreshInterval ?? null,
        isPrivate: false,
        isTemplate: false,
        definition: dashboardDefinitionSchema.parse(instantiateTemplate(tpl.definition, dataSourceId)),
      });
    }
    // Workspace dashboards flagged as templates
    const d = await repo.findById(templateId);
    if (!d || d.workspaceId !== workspaceId || !d.isTemplate) throw NotFound('Template');
    return this.duplicate(workspaceId, d.id, actor, title ?? d.title);
  },

  // ───────────── Panel data ─────────────

  /**
   * Executes a panel's *saved* query. Viewers never submit SQL — only parameters —
   * so dashboard access does not imply arbitrary query execution.
   */
  async panelData(dashboard: Dashboard, panelId: string, req: z.infer<typeof panelDataRequestSchema>) {
    const def = parseDefinition(dashboard.definition);
    const panel = def.panels.find((p) => p.id === panelId);
    if (!panel) throw NotFound('Panel');
    return this.runPanel(dashboard, def, panel, req);
  },

  async runPanel(dashboard: Dashboard, def: DashboardDefinition, panel: Panel, req: z.infer<typeof panelDataRequestSchema>) {
    if (!panel.dataSourceId || !panel.query) return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 } satisfies QueryResult;
    const ds = await dataSourceRepository.findByIdUnscoped(panel.dataSourceId);
    if (!ds || ds.workspaceId !== dashboard.workspaceId) throw NotFound('Data source');

    const range = req.timeRange ?? def.time;
    let timeRange;
    try {
      timeRange = parseTimeRange(range);
    } catch (e) {
      throw BadRequest((e as Error).message);
    }
    const variables = sanitizeVariables(def, req.variables);
    const key = sha256(JSON.stringify([dashboard.id, dashboard.version, panel.id, range, variables, req.filters ?? []]));
    if (!req.fresh) {
      const hit = panelCache.get(key);
      if (hit) return { ...hit, cached: true };
    }
    // System-level execution: always read-only regardless of the viewer's role
    const raw = await executeQuery(ds, panel.query, { ctx: { timeRange, variables }, user: null });
    const result = applyTransforms(raw, {
      ...panel.transforms,
      filters: [...(panel.transforms?.filters ?? []), ...(req.filters ?? [])],
    });
    const ttl = (panel.cacheTtlSeconds ?? defaultTtl(dashboard.refreshInterval)) * 1000;
    if (ttl > 0) panelCache.set(key, result, { ttl });
    return result;
  },

  async variableOptions(dashboard: Dashboard, name: string) {
    const def = parseDefinition(dashboard.definition);
    const v = def.variables.find((x) => x.name === name);
    if (!v) throw NotFound('Variable');
    if (v.type !== 'query') return { values: v.options ?? [] };
    if (!v.dataSourceId || !v.query) return { values: [] };
    const ds = await dataSourceRepository.findByIdUnscoped(v.dataSourceId);
    if (!ds || ds.workspaceId !== dashboard.workspaceId) throw NotFound('Data source');
    const r = await executeQuery(ds, v.query, { maxRows: 1000, user: null, ctx: { timeRange: parseTimeRange(def.time) } });
    const col = r.columns[0]?.name;
    const values = col ? [...new Set(r.rows.map((row) => String(row[col])))] : [];
    return { values };
  },

  /** Used by the scheduler to pre-warm caches for dashboards with a refresh schedule. */
  async warm(dashboardId: string) {
    const d = await prisma.dashboard.findUnique({ where: { id: dashboardId } });
    if (!d) return;
    const def = parseDefinition(d.definition);
    const defaults: Record<string, VariableValue> = {};
    for (const v of def.variables) {
      if (v.default === undefined) continue;
      const isAll = (Array.isArray(v.default) ? v.default : [v.default]).includes('$__all');
      defaults[v.name] = isAll ? (await this.variableOptions(d, v.name)).values : v.default;
    }
    await Promise.allSettled(def.panels.map((p) => this.runPanel(d, def, p, { variables: defaults, fresh: true })));
    emit(Rooms.dashboard(d.id), Events.DASHBOARD_REFRESH, { id: d.id, at: new Date().toISOString() });
  },
};

function defaultTtl(refresh: string | null): number {
  if (!refresh) return 30;
  const m = /^(\d+)(s|m|h)$/.exec(refresh);
  if (!m) return 30;
  const s = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's'];
  return Math.max(5, Math.floor(s / 2));
}

/** Only declared variables are forwarded to the query builder (bound as parameters). */
function sanitizeVariables(def: DashboardDefinition, input: Record<string, VariableValue>): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const v of def.variables) {
    if (!(v.name in input)) continue;
    const val = input[v.name];
    if (Array.isArray(val) && val.length > 1000) throw BadRequest(`Too many values for variable ${v.name}`);
    if (typeof val === 'string' && val.length > 2000) throw BadRequest(`Variable ${v.name} is too long`);
    if (v.type === 'interval' && typeof val === 'string' && !/^\d+(s|m|h|d)$/.test(val)) throw BadRequest(`Invalid interval for ${v.name}`);
    out[v.name] = val;
  }
  return out;
}
