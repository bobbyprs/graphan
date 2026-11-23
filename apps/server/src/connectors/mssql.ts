import type { ConnectionPool, config as MssqlConfig, IRecordSet } from 'mssql';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now } from './util';

type MssqlModule = typeof import('mssql');

export class MsSqlConnector implements Connector {
  readonly dialect = 'mssql' as const;
  private pool?: ConnectionPool;
  private connecting?: Promise<ConnectionPool>;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.pool?.connected) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }
    const sql = loadDriver<MssqlModule>('mssql');
    const o = this.cfg.options;
    const conf: MssqlConfig = {
      server: this.cfg.host ?? 'localhost',
      port: this.cfg.port ?? 1433,
      database: this.cfg.database ?? undefined,
      user: this.cfg.username ?? undefined,
      password: this.cfg.password,
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
      pool: { min: o.poolMin ?? 0, max: o.poolMax ?? 10, idleTimeoutMillis: o.idleTimeoutMs ?? 30_000 },
      options: {
        encrypt: o.encrypt ?? true,
        trustServerCertificate: o.trustServerCertificate ?? false,
        instanceName: o.instanceName,
        readOnlyIntent: this.cfg.readOnly,
        appName: 'graphan',
      },
    };
    const pool = this.cfg.connectionString ? new sql.ConnectionPool(this.cfg.connectionString) : new sql.ConnectionPool(conf);
    this.connecting = pool.connect();
    try {
      this.pool = await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async close() {
    await this.pool?.close();
    this.pool = undefined;
  }

  async ping() {
    await this.connect();
    const t = now();
    await this.pool!.request().query('SELECT 1');
    return Math.round(performance.now() - t);
  }

  placeholder(i: number) {
    return `@p${i}`;
  }

  timeGroupExpr(col: string, s: number) {
    return `DATEADD(second, (DATEDIFF_BIG(second, '1970-01-01', ${col}) / ${s}) * ${s}, '1970-01-01')`;
  }

  quoteIdent(name: string) {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const start = now();
    const req = this.pool!.request();
    (req as unknown as { timeout: number }).timeout = opts.timeoutMs;
    params.forEach((v, i) => req.input(`p${i + 1}`, v));
    opts.signal?.addEventListener('abort', () => req.cancel(), { once: true });
    // SET ROWCOUNT caps rows returned without rewriting the user's statement (works with CTEs / ORDER BY)
    const wrapped = this.cfg.readOnly || opts.rollback
      ? `SET ROWCOUNT ${opts.maxRows + 1};\nBEGIN TRAN;\n${text}\n;ROLLBACK TRAN;`
      : `SET ROWCOUNT ${opts.maxRows + 1};\n${text}`;
    try {
      const res = await req.query(wrapped);
      const sets = res.recordsets as IRecordSet<Record<string, unknown>>[];
      const last = sets.length ? sets[sets.length - 1] : undefined;
      const columns = last ? Object.values(last.columns).map((c) => ({ name: c.name, type: String((c.type as { name?: string })?.name ?? 'unknown') })) : [];
      return buildResult(last ? [...last] : [], opts.maxRows, start, columns, last ? undefined : res.rowsAffected.reduce((a, b) => a + b, 0));
    } catch (e) {
      if (this.cfg.readOnly) await this.pool!.request().query('IF @@TRANCOUNT > 0 ROLLBACK TRAN').catch(() => undefined);
      throw e;
    }
  }

  private async rows<T = any>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    await this.connect();
    const r = this.pool!.request();
    Object.entries(params).forEach(([k, v]) => r.input(k, v));
    return (await r.query(sql)).recordset as T[];
  }

  async listSchemas() {
    const r = await this.rows<{ name: string }>(
      `SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db[_]%' ORDER BY name`,
    );
    return r.map((x) => x.name);
  }

  async listObjects(schema = this.cfg.options.defaultSchema ?? 'dbo'): Promise<DbObject[]> {
    const r = await this.rows<any>(
      `SELECT o.name, o.type, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=o.object_id AND p.index_id IN (0,1)) AS est
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
       WHERE s.name=@schema AND o.type IN ('U','V','P','FN','IF','TF') ORDER BY o.name`,
      { schema },
    );
    const kind = (t: string): DbObject['kind'] =>
      t.trim() === 'U' ? 'table' : t.trim() === 'V' ? 'view' : t.trim() === 'P' ? 'procedure' : 'function';
    return r.map((o) => ({ schema, name: o.name, kind: kind(o.type), rowEstimate: o.est != null ? Number(o.est) : null }));
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    const p = { schema, table };
    const [cols, idx, fks, refs, stats] = await Promise.all([
      this.rows<any>(
        `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS def,
                c.CHARACTER_MAXIMUM_LENGTH AS len, c.ORDINAL_POSITION AS ord,
                CASE WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                     ON k.CONSTRAINT_NAME=tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA=tc.TABLE_SCHEMA
                     WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY' AND tc.TABLE_SCHEMA=c.TABLE_SCHEMA AND tc.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME)
                THEN 1 ELSE 0 END AS pk
         FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA=@schema AND c.TABLE_NAME=@table ORDER BY c.ORDINAL_POSITION`,
        p,
      ),
      this.rows<any>(
        `SELECT i.name, i.is_unique AS uq, i.is_primary_key AS pk,
                STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS cols
         FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
         JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
         WHERE i.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table)) AND i.name IS NOT NULL
         GROUP BY i.name, i.is_unique, i.is_primary_key`,
        p,
      ),
      this.rows<any>(
        `SELECT fk.name, SCHEMA_NAME(rt.schema_id) AS rs, rt.name AS rt,
                STRING_AGG(pc.name, ',') AS cols, STRING_AGG(rc.name, ',') AS rcols
         FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
         JOIN sys.tables rt ON rt.object_id=fk.referenced_object_id
         JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id
         JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id
         WHERE fk.parent_object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))
         GROUP BY fk.name, rt.schema_id, rt.name`,
        p,
      ),
      this.rows<any>(
        `SELECT fk.name, SCHEMA_NAME(t.schema_id) AS s, t.name AS t FROM sys.foreign_keys fk
         JOIN sys.tables t ON t.object_id=fk.parent_object_id
         WHERE fk.referenced_object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))`,
        p,
      ),
      this.rows<any>(
        `SELECT SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS r, SUM(a.total_pages)*8192 AS b
         FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id=p.partition_id
         WHERE p.object_id=OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@table))`,
        p,
      ),
    ]);
    const st = stats[0] ?? {};
    return {
      schema,
      name: table,
      columns: cols.map((c) => ({
        name: c.name, dataType: c.type, nullable: c.nullable === 'YES', defaultValue: c.def,
        isPrimaryKey: c.pk === 1, maxLength: c.len, ordinal: c.ord,
      })),
      indexes: idx.map((i) => ({ name: i.name, columns: String(i.cols).split(','), unique: !!i.uq, primary: !!i.pk })),
      foreignKeys: fks.map((f) => ({ name: f.name, columns: String(f.cols).split(','), refSchema: f.rs, refTable: f.rt, refColumns: String(f.rcols).split(',') })),
      referencedBy: refs.map((r) => ({ schema: r.s, table: r.t, name: r.name })),
      stats: { rowCount: st.r != null ? Number(st.r) : null, totalBytes: st.b != null ? Number(st.b) : null },
    };
  }

  /** Views/procedures/functions only; tables use the generic generator (returns ''). */
  async getDdl(schema: string, name: string, kind: DbObject['kind']): Promise<string> {
    if (kind === 'table') return '';
    const r = await this.rows<{ def: string | null }>(`SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema)+'.'+QUOTENAME(@name))) AS def`, { schema, name });
    return r[0]?.def ?? `-- Definition not available for ${schema}.${name} (encrypted or insufficient permission)`;
  }

  previewTable(schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(
      `SELECT * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)} ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY`,
      [offset, limit],
      { ...opts, maxRows: limit },
    );
  }

  async completionCatalog(schema = this.cfg.options.defaultSchema ?? 'dbo') {
    const r = await this.rows<any>(
      `SELECT TABLE_NAME AS t, STRING_AGG(COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ORDINAL_POSITION) AS c
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema GROUP BY TABLE_NAME`,
      { schema },
    );
    return r.map((x) => ({ schema, table: x.t, columns: String(x.c).split(',') }));
  }
}
