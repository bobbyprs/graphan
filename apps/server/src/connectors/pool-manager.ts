import type { DataSource } from '@prisma/client';
import { decryptJson, sha256 } from '../lib/crypto';
import { logger } from '../lib/logger';
import type { ConnectionConfig, ConnectionOptions, Connector } from './types';
import { PostgresConnector } from './postgres';
import { MySqlConnector } from './mysql';
import { MsSqlConnector } from './mssql';
import { OracleConnector } from './oracle';
import { SqliteConnector } from './sqlite';
import { MongoConnector } from './mongodb';

export interface DataSourceSecrets {
  password?: string;
  connectionString?: string;
}

export function createConnector(cfg: ConnectionConfig): Connector {
  switch (cfg.type) {
    case 'POSTGRES':
      return new PostgresConnector(cfg);
    case 'MYSQL':
      return new MySqlConnector(cfg);
    case 'MSSQL':
      return new MsSqlConnector(cfg);
    case 'ORACLE':
      return new OracleConnector(cfg);
    case 'SQLITE':
      return new SqliteConnector(cfg);
    case 'MONGODB':
      return new MongoConnector(cfg);
    default:
      throw new Error(`Unsupported data source type: ${String(cfg.type)}`);
  }
}

export function toConnectionConfig(ds: Pick<DataSource, 'type' | 'host' | 'port' | 'database' | 'username' | 'encryptedSecrets' | 'options' | 'readOnly'>): ConnectionConfig {
  const secrets = decryptJson<DataSourceSecrets>(ds.encryptedSecrets) ?? {};
  return {
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database: ds.database,
    username: ds.username,
    password: secrets.password,
    connectionString: secrets.connectionString,
    readOnly: ds.readOnly,
    options: (ds.options ?? {}) as ConnectionOptions,
  };
}

interface Entry {
  connector: Connector;
  fingerprint: string;
  lastUsed: number;
}

/**
 * Keeps one pooled connector per data source. Pools are recreated when the data source
 * configuration changes (detected by fingerprint) and evicted after a period of inactivity.
 */
class ConnectionPoolManager {
  private readonly entries = new Map<string, Entry>();
  private readonly idleEvictMs = 15 * 60_000;
  private sweeper?: NodeJS.Timeout;

  start() {
    this.sweeper = setInterval(() => void this.evictIdle(), 60_000);
    this.sweeper.unref();
  }

  async get(ds: DataSource): Promise<Connector> {
    const fingerprint = sha256(
      JSON.stringify([ds.type, ds.host, ds.port, ds.database, ds.username, ds.encryptedSecrets, ds.options, ds.readOnly]),
    );
    const existing = this.entries.get(ds.id);
    if (existing && existing.fingerprint === fingerprint) {
      existing.lastUsed = Date.now();
      return existing.connector;
    }
    if (existing) await this.invalidate(ds.id);
    const connector = createConnector(toConnectionConfig(ds));
    await connector.connect();
    this.entries.set(ds.id, { connector, fingerprint, lastUsed: Date.now() });
    return connector;
  }

  async invalidate(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    await e.connector.close().catch((err) => logger.warn({ err, id }, 'Error closing pool'));
  }

  private async evictIdle() {
    const cutoff = Date.now() - this.idleEvictMs;
    for (const [id, e] of this.entries) if (e.lastUsed < cutoff) await this.invalidate(id);
  }

  stats() {
    return { activePools: this.entries.size };
  }

  async closeAll() {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.entries.keys()].map((id) => this.invalidate(id)));
  }
}

export const poolManager = new ConnectionPoolManager();
