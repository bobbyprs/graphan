import type { Pool, FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now } from './util';
import { classify, trimStatement } from './sql-guard';

type MysqlModule = typeof import('mysql2/promise');

export class MySqlConnector implements Connector {
  readonly dialect = 'mysql' as const;
  private pool?: Pool;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.pool) return;
    const mysql = loadDriver<MysqlModule>('mysql2/promise');
    const o = this.cfg.options;
    this.pool = this.cfg.connectionString
      ? mysql.createPool({ uri: this.cfg.connectionString, connectionLimit: o.poolMax ?? 10 })
      : mysql.createPool({
          host: this.cfg.host ?? 'localhost',
          port: this.cfg.port ?? 3306,
          database: this.cfg.database ?? undefined,
          user: this.cfg.username ?? undefined,
          password: this.cfg.password,
          connectionLimit: o.poolMax ?? 10,
          maxIdle: o.poolMin ?? 0,
          idleTimeout: o.idleTimeoutMs ?? 30_000,
          connectTimeout: 10_000,
          ssl: o.ssl ? { rejectUnauthorized: o.sslRejectUnauthorized ?? true } : undefined,
          dateStrings: false,
          supportBigNumbers: true,
          decimalNumbers: true,
          multipleStatements: false,
        });
  }

  async close() {
    await this.pool?.end();
    this.pool = undefined;
  }

  async ping() {
    await this.connect();
    const t = now();
    await this.pool!.query('SELECT 1');
    return Math.round(performance.now() - t);
  }

  placeholder() {
    return '?';
  }

  timeGroupExpr(col: string, s: number) {
    return `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${col}) / ${s}) * ${s})`;
  }

  quoteIdent(name: string) {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const conn = await this.pool!.getConnection();
    const start = now();
    const tx = this.cfg.readOnly || opts.rollback;
    const threadId = conn.threadId;
    const onAbort = () => void this.pool?.query('KILL QUERY ?', [threadId]).catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (tx) await conn.query(this.cfg.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      const { isSelectLike } = classify(text);
      const run = (sql: string) => conn.query({ sql, values: params, timeout: opts.timeoutMs });
      let res: [unknown, FieldPacket[]];
      if (isSelectLike) {
        try {
          res = await run(`SELECT * FROM (\n${trimStatement(text)}\n) AS _g LIMIT ${opts.maxRows + 1}`);
        } catch {
          // e.g. duplicate column names in a derived table — fall back to the raw statement
          res = await run(text);
        }
      } else {
        res = await run(text);
      }
      if (tx) await conn.query('ROLLBACK');
      const [rows, fields] = res;
      if (!Array.isArray(rows)) {
        const h = rows as ResultSetHeader;
        return buildResult([], opts.maxRows, start, [], h.affectedRows);
      }
      const columns = (fields ?? []).map((f) => ({ name: f.name, type: String(f.type ?? 'unknown') }));
      return buildResult(rows as RowDataPacket[], opts.maxRows, start, columns);
    } catch (e) {
      if (tx) await conn.query('ROLLBACK').catch(() => undefined);
      if (opts.signal?.aborted) (e as Error).message = 'Query cancelled by user';
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      conn.release();
    }
  }

  async getDdl(schema: string, name: string, kind: DbObject['kind']): Promise<string> {
    const what = kind === 'view' ? 'VIEW' : kind === 'procedure' ? 'PROCEDURE' : kind === 'function' ? 'FUNCTION' : 'TABLE';
    const r = await this.rows<Record<string, string>>(`SHOW CREATE ${what} ${this.quoteIdent(schema)}.${this.quoteIdent(name)}`);
    const row = r[0] ?? {};
    const key = Object.keys(row).find((k) => /^Create (Table|View|Procedure|Function)$/i.test(k));
    return key ? `${row[key]};` : `-- Unable to generate DDL for ${schema}.${name}`;
  }

  private async rows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.connect();
    const [r] = await this.pool!.query(sql, params);
    return r as T[];
  }

  async listSchemas() {
    const r = await this.rows<{ name: string }>(
      `SELECT schema_name AS name FROM information_schema.schemata
       WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY 1`,
    );
    return r.map((x) => x.name);
  }

  async listObjects(schema = this.cfg.database ?? ''): Promise<DbObject[]> {
    const tables = await this.rows<any>(
      `SELECT table_name AS name, table_type AS type, table_rows AS est FROM information_schema.tables WHERE table_schema=? ORDER BY 1`,
      [schema],
    );
    const routines = await this.rows<any>(
      `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines WHERE routine_schema=? ORDER BY 1`,
      [schema],
    );
    return [
      ...tables.map((t) => ({
        schema,
        name: t.name,
        kind: (t.type === 'VIEW' ? 'view' : 'table') as DbObject['kind'],
        rowEstimate: t.est != null ? Number(t.est) : null,
      })),
      ...routines.map((r) => ({ schema, name: r.name, kind: (r.type === 'PROCEDURE' ? 'procedure' : 'function') as DbObject['kind'] })),
    ];
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    const [cols, idx, fks, refs, stats] = await Promise.all([
      this.rows<any>(
        `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def,
                character_maximum_length AS len, ordinal_position AS ord, column_key AS ckey
         FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT index_name AS name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
         FROM information_schema.statistics WHERE table_schema=? AND table_name=? GROUP BY index_name, non_unique`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT constraint_name AS name, referenced_table_schema AS rs, referenced_table_name AS rt,
                GROUP_CONCAT(column_name ORDER BY ordinal_position) AS cols, GROUP_CONCAT(referenced_column_name ORDER BY ordinal_position) AS rcols
         FROM information_schema.key_column_usage WHERE table_schema=? AND table_name=? AND referenced_table_name IS NOT NULL
         GROUP BY constraint_name, referenced_table_schema, referenced_table_name`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT DISTINCT constraint_name AS name, table_schema AS s, table_name AS t
         FROM information_schema.key_column_usage WHERE referenced_table_schema=? AND referenced_table_name=?`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT table_rows AS r, data_length + index_length AS b, update_time AS u FROM information_schema.tables WHERE table_schema=? AND table_name=?`,
        [schema, table],
      ),
    ]);
    const st = stats[0] ?? {};
    return {
      schema,
      name: table,
      columns: cols.map((c) => ({
        name: c.name,
        dataType: c.type,
        nullable: c.nullable === 'YES',
        defaultValue: c.def,
        isPrimaryKey: c.ckey === 'PRI',
        maxLength: c.len,
        ordinal: c.ord,
      })),
      indexes: idx.map((i) => ({ name: i.name, columns: String(i.cols).split(','), unique: Number(i.non_unique) === 0, primary: i.name === 'PRIMARY' })),
      foreignKeys: fks.map((f) => ({ name: f.name, columns: String(f.cols).split(','), refSchema: f.rs, refTable: f.rt, refColumns: String(f.rcols).split(',') })),
      referencedBy: refs.map((r) => ({ schema: r.s, table: r.t, name: r.name })),
      stats: {
        rowCount: st.r != null ? Number(st.r) : null,
        totalBytes: st.b != null ? Number(st.b) : null,
        lastAnalyzed: st.u ? new Date(st.u).toISOString() : null,
      },
    };
  }

  previewTable(schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(`SELECT * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)} LIMIT ? OFFSET ?`, [limit, offset], {
      ...opts,
      maxRows: limit,
    });
  }

  async completionCatalog(schema = this.cfg.database ?? '') {
    const r = await this.rows<any>(
      `SELECT table_name AS t, GROUP_CONCAT(column_name ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema=? GROUP BY table_name`,
      [schema],
    );
    return r.map((x) => ({ schema, table: x.t, columns: String(x.c).split(',') }));
  }
}
