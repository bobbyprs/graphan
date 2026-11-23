import type { DataSourceType } from '@prisma/client';

export interface ConnectionConfig {
  type: DataSourceType;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string;
  connectionString?: string;
  readOnly: boolean;
  options: ConnectionOptions;
}

export interface ConnectionOptions {
  ssl?: boolean;
  sslRejectUnauthorized?: boolean;
  poolMin?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
  /** SQLite file path */
  filePath?: string;
  /** Default schema for explorer (pg/mssql/oracle) */
  defaultSchema?: string;
  /** Oracle service name / SID */
  serviceName?: string;
  /** MSSQL */
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  instanceName?: string;
  /** MongoDB auth source */
  authSource?: string;
  [key: string]: unknown;
}

export interface ColumnMeta {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  affectedRows?: number;
  /** Analytics attached by transforms (forecast models, warnings) */
  meta?: ResultMeta;
}

export interface ResultMeta {
  forecast?: import('../ml/forecast').ForecastMeta[];
  warnings?: string[];
}

export interface QueryOptions {
  maxRows: number;
  timeoutMs: number;
  /** Aborting cancels the running statement on the server where the driver supports it. */
  signal?: AbortSignal;
  /** Always roll back (used by EXPLAIN ANALYZE so it never persists side effects). */
  rollback?: boolean;
}

export type DbObjectKind = 'table' | 'view' | 'materialized_view' | 'procedure' | 'function' | 'sequence' | 'collection';

export interface DbObject {
  schema: string;
  name: string;
  kind: DbObjectKind;
  rowEstimate?: number | null;
}

export interface ColumnDetail {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  maxLength?: number | null;
  ordinal: number;
}

export interface IndexDetail {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyDetail {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface TableDetails {
  schema: string;
  name: string;
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  foreignKeys: ForeignKeyDetail[];
  /** Tables that reference this one */
  referencedBy: { schema: string; table: string; name: string }[];
  stats: {
    rowCount: number | null;
    totalBytes?: number | null;
    lastAnalyzed?: string | null;
  };
}

export type Dialect = 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'sqlite' | 'mongodb';

export interface Connector {
  readonly dialect: Dialect;
  /** Establish the pool / client. Idempotent. */
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Returns round-trip latency in ms. */
  ping(): Promise<number>;
  query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult>;

  /** 1-based positional placeholder for this dialect. */
  placeholder(index: number): string;
  /** SQL expression that buckets a timestamp column into `seconds`-sized intervals. */
  timeGroupExpr(column: string, seconds: number): string;
  quoteIdent(name: string): string;

  listSchemas(): Promise<string[]>;
  listObjects(schema?: string): Promise<DbObject[]>;
  describeTable(schema: string, table: string): Promise<TableDetails>;
  previewTable(schema: string, table: string, limit: number, offset: number, opts: QueryOptions): Promise<QueryResult>;
  /** Columns for every table in a schema: used for editor auto-completion. */
  completionCatalog(schema?: string): Promise<{ table: string; schema: string; columns: string[] }[]>;
  /** Native DDL (CREATE script) for an object; falls back to a generic generator when absent. */
  getDdl?(schema: string, name: string, kind: DbObjectKind): Promise<string>;
}
