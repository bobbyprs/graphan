import { z } from 'zod';
import { DataSourceType, type DataSource, type Prisma } from '@prisma/client';
import { encryptJson, decryptJson } from '../../lib/crypto';
import { NotFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { createConnector, poolManager, toConnectionConfig, type DataSourceSecrets } from '../../connectors/pool-manager';
import { emit, Events, Rooms } from '../../realtime/socket';
import { dataSourceRepository as repo } from './datasources.repository';

const DEFAULT_PORTS: Partial<Record<DataSourceType, number>> = {
  POSTGRES: 5432,
  MYSQL: 3306,
  MSSQL: 1433,
  ORACLE: 1521,
  MONGODB: 27017,
};

export const dataSourceInputSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.nativeEnum(DataSourceType),
  host: z.string().max(255).optional().nullable(),
  port: z.number().int().min(1).max(65535).optional().nullable(),
  database: z.string().max(255).optional().nullable(),
  username: z.string().max(255).optional().nullable(),
  /** Omit on update to keep the stored password; send "" to clear it. */
  password: z.string().max(1024).optional(),
  connectionString: z.string().max(4096).optional(),
  readOnly: z.boolean().default(true),
  options: z
    .object({
      ssl: z.boolean().optional(),
      sslRejectUnauthorized: z.boolean().optional(),
      poolMin: z.number().int().min(0).max(50).optional(),
      poolMax: z.number().int().min(1).max(100).optional(),
      idleTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      filePath: z.string().max(1024).optional(),
      defaultSchema: z.string().max(128).optional(),
      serviceName: z.string().max(128).optional(),
      encrypt: z.boolean().optional(),
      trustServerCertificate: z.boolean().optional(),
      instanceName: z.string().max(128).optional(),
      authSource: z.string().max(128).optional(),
    })
    .strict()
    .default({}),
});
export type DataSourceInput = z.infer<typeof dataSourceInputSchema>;

/** Public representation: secrets are never returned. */
export function toDto(ds: DataSource) {
  const secrets = safeSecrets(ds);
  const { encryptedSecrets: _omit, ...rest } = ds;
  return { ...rest, hasPassword: !!secrets.password, hasConnectionString: !!secrets.connectionString };
}

function safeSecrets(ds: DataSource): DataSourceSecrets {
  try {
    return decryptJson<DataSourceSecrets>(ds.encryptedSecrets) ?? {};
  } catch {
    return {};
  }
}

function buildSecrets(input: Partial<DataSourceInput>, existing: DataSourceSecrets = {}): string | null {
  const s: DataSourceSecrets = { ...existing };
  if (input.password !== undefined) s.password = input.password || undefined;
  if (input.connectionString !== undefined) s.connectionString = input.connectionString || undefined;
  return s.password || s.connectionString ? encryptJson(s) : null;
}

/** Translates cryptic driver errors into actionable messages. */
export function friendlyConnectionError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/client password must be a string|password authentication is required|no password supplied/i.test(msg)) {
    return 'The database server requires a password, but none was provided. Enter a username and password.';
  }
  if (/password authentication failed|Login failed for user|Access denied for user|ORA-01017|Authentication failed/i.test(msg)) {
    return `Authentication failed — check the username and password. (${msg})`;
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused — is the database running and reachable on that host/port? (${msg})`;
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return `Host not found — check the host name. (${msg})`;
  if (/database ".*" does not exist|Unknown database/i.test(msg)) return `Database not found — check the database name. (${msg})`;
  return msg;
}

export const dataSourcesService = {
  async list(workspaceId: string) {
    return (await repo.list(workspaceId)).map(toDto);
  },

  async get(workspaceId: string, id: string) {
    const ds = await repo.findById(workspaceId, id);
    if (!ds) throw NotFound('Data source');
    return ds;
  },

  async create(workspaceId: string, userId: string, input: DataSourceInput) {
    const ds = await repo.create({
      workspaceId,
      createdById: userId,
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port ?? DEFAULT_PORTS[input.type] ?? null,
      database: input.database,
      username: input.username,
      readOnly: input.readOnly,
      options: input.options as Prisma.InputJsonValue,
      encryptedSecrets: buildSecrets(input),
    });
    void this.checkHealth(ds);
    return toDto(ds);
  },

  async update(workspaceId: string, id: string, input: Partial<DataSourceInput>) {
    const current = await this.get(workspaceId, id);
    const ds = await repo.update(id, {
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      readOnly: input.readOnly,
      options: input.options as Prisma.InputJsonValue | undefined,
      encryptedSecrets: buildSecrets(input, safeSecrets(current)),
    });
    await poolManager.invalidate(id);
    void this.checkHealth(ds);
    return toDto(ds);
  },

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await poolManager.invalidate(id);
    await repo.delete(id);
  },

  /** Tests an unsaved configuration using a throw-away connector (never pooled). */
  async testConfig(input: DataSourceInput, existing?: DataSource) {
    const secrets = buildSecrets(input, existing ? safeSecrets(existing) : {});
    const cfg = toConnectionConfig({
      type: input.type,
      host: input.host ?? null,
      port: input.port ?? DEFAULT_PORTS[input.type] ?? null,
      database: input.database ?? null,
      username: input.username ?? null,
      encryptedSecrets: secrets,
      options: input.options as Prisma.JsonValue,
      readOnly: input.readOnly,
    });
    const connector = createConnector(cfg);
    try {
      await connector.connect();
      const latencyMs = await connector.ping();
      return { ok: true as const, latencyMs };
    } catch (e) {
      return { ok: false as const, error: friendlyConnectionError(e) };
    } finally {
      await connector.close().catch(() => undefined);
    }
  },

  /** Pings a pooled connection, persists status and broadcasts it to the workspace. */
  async checkHealth(ds: DataSource) {
    let status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' = 'OFFLINE';
    let latency: number | null = null;
    let error: string | null = null;
    try {
      const c = await poolManager.get(ds);
      latency = await c.ping();
      status = latency > 2000 ? 'DEGRADED' : 'ONLINE';
    } catch (e) {
      error = friendlyConnectionError(e).slice(0, 1000);
      await poolManager.invalidate(ds.id);
    }
    const changed = ds.status !== status;
    const updated = await repo.setHealth(ds.id, status, latency, error).catch((err) => {
      logger.warn({ err, id: ds.id }, 'Failed to persist health');
      return null;
    });
    if (updated) {
      emit(Rooms.workspace(ds.workspaceId), Events.DATASOURCE_STATUS, {
        id: ds.id,
        status,
        latencyMs: latency,
        error,
        checkedAt: updated.lastCheckedAt,
      });
      if (changed) logger.info({ id: ds.id, name: ds.name, status }, 'Data source status changed');
    }
    return { status, latencyMs: latency, error };
  },

  async checkAll() {
    const all = await repo.listAll();
    // Bounded concurrency to avoid thundering-herd against many sources
    const queue = [...all];
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length) await this.checkHealth(queue.shift()!);
    });
    await Promise.all(workers);
  },
};
