import type { Pool, Result } from 'oracledb';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now, quoteDouble } from './util';

type OracleModule = typeof import('oracledb');

/** Uses node-oracledb "Thin" mode (pure JS; no Instant Client required). */
export class OracleConnector implements Connector {
  readonly dialect = 'oracle' as const;
  private pool?: Pool;
  private ora?: OracleModule;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.pool) return;
    this.ora = loadDriver<OracleModule>('oracledb');
    this.ora.fetchAsString = [this.ora.CLOB];
    const o = this.cfg.options;
    const connectString =
      this.cfg.connectionString ?? `${this.cfg.host ?? 'localhost'}:${this.cfg.port ?? 1521}/${o.serviceName ?? this.cfg.database ?? 'XEPDB1'}`;
    this.pool = await this.ora.createPool({
      user: this.cfg.username ?? undefined,
      password: this.cfg.password,
      connectString,
      poolMin: o.poolMin ?? 0,
      poolMax: o.poolMax ?? 10,
      poolTimeout: Math.round((o.idleTimeoutMs ?? 60_000) / 1000),
    });
  }

  async close() {
    await this.pool?.close(5);
    this.pool = undefined;
  }

  async ping() {
    await this.connect();
    const conn = await this.pool!.getConnection();
    const t = now();
    try {
      await conn.ping();
      return Math.round(performance.now() - t);
    } finally {
      await conn.close();
    }
  }

  placeholder(i: number) {
    return `:${i}`;
  }

  timeGroupExpr(col: string, s: number) {
    return `(DATE '1970-01-01' + FLOOR((CAST(${col} AS DATE) - DATE '1970-01-01') * 86400 / ${s}) * ${s} / 86400)`;
  }

  quoteIdent = quoteDouble;

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const conn = await this.pool!.getConnection();
    const start = now();
    const onAbort = () => void conn.break().catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      conn.callTimeout = opts.timeoutMs;
      if (this.cfg.readOnly) await conn.execute('SET TRANSACTION READ ONLY');
      const res: Result<Record<string, unknown>> = await conn.execute(text.replace(/;\s*$/, ''), params as unknown[], {
        outFormat: this.ora!.OUT_FORMAT_OBJECT,
        maxRows: opts.maxRows + 1,
        autoCommit: !this.cfg.readOnly && !opts.rollback,
      });
      if (this.cfg.readOnly || opts.rollback) await conn.rollback();
      const columns = (res.metaData ?? []).map((m) => ({ name: m.name, type: String(m.dbTypeName ?? 'unknown') }));
      return buildResult(res.rows ?? [], opts.maxRows, start, columns, res.rowsAffected);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await conn.close();
    }
  }

  async getDdl(schema: string, name: string, kind: DbObject['kind']): Promise<string> {
    const type = { table: 'TABLE', view: 'VIEW', materialized_view: 'MATERIALIZED_VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', sequence: 'SEQUENCE', collection: 'TABLE' }[kind];
    const r = await this.rows<{ DDL: string }>(`SELECT DBMS_METADATA.GET_DDL(:type, :name, :owner) AS ddl FROM dual`, { type, name, owner: schema });
    return (r[0]?.DDL ?? '').trim() + ';';
  }

  private async rows<T = any>(sql: string, binds: Record<string, unknown> = {}): Promise<T[]> {
    await this.connect();
    const conn = await this.pool!.getConnection();
    try {
      const r = await conn.execute(sql, binds as import('oracledb').BindParameters, { outFormat: this.ora!.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as T[];
    } finally {
      await conn.close();
    }
  }

  private defaultSchema() {
    return (this.cfg.options.defaultSchema ?? this.cfg.username ?? '').toUpperCase();
  }

  async listSchemas() {
    const r = await this.rows<{ NAME: string }>(
      `SELECT username AS name FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`,
    );
    return r.map((x) => x.NAME);
  }

  async listObjects(schema = this.defaultSchema()): Promise<DbObject[]> {
    const r = await this.rows<any>(
      `SELECT o.object_name AS name, o.object_type AS type, t.num_rows AS est
       FROM all_objects o LEFT JOIN all_tables t ON t.owner=o.owner AND t.table_name=o.object_name
       WHERE o.owner=:schema AND o.object_type IN ('TABLE','VIEW','PROCEDURE','FUNCTION') ORDER BY o.object_name`,
      { schema },
    );
    return r.map((o) => ({
      schema,
      name: o.NAME,
      kind: String(o.TYPE).toLowerCase() as DbObject['kind'],
      rowEstimate: o.EST != null ? Number(o.EST) : null,
    }));
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    const b = { schema, tbl: table };
    const [cols, pk, idx, fks, refs, stats] = await Promise.all([
      this.rows<any>(
        `SELECT column_name AS name, data_type AS type, nullable, data_default AS def, char_length AS len, column_id AS ord
         FROM all_tab_columns WHERE owner=:schema AND table_name=:tbl ORDER BY column_id`,
        b,
      ),
      this.rows<any>(
        `SELECT cc.column_name AS name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
         WHERE c.owner=:schema AND c.table_name=:tbl AND c.constraint_type='P'`,
        b,
      ),
      this.rows<any>(
        `SELECT i.index_name AS name, i.uniqueness AS uq, LISTAGG(c.column_name, ',') WITHIN GROUP (ORDER BY c.column_position) AS cols
         FROM all_indexes i JOIN all_ind_columns c ON c.index_owner=i.owner AND c.index_name=i.index_name
         WHERE i.table_owner=:schema AND i.table_name=:tbl GROUP BY i.index_name, i.uniqueness`,
        b,
      ),
      this.rows<any>(
        `SELECT c.constraint_name AS name, r.owner AS rs, r.table_name AS rt,
                LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) AS cols,
                LISTAGG(rc.column_name, ',') WITHIN GROUP (ORDER BY rc.position) AS rcols
         FROM all_constraints c JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name
         JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name
         JOIN all_cons_columns rc ON rc.owner=r.owner AND rc.constraint_name=r.constraint_name AND rc.position=cc.position
         WHERE c.owner=:schema AND c.table_name=:tbl AND c.constraint_type='R' GROUP BY c.constraint_name, r.owner, r.table_name`,
        b,
      ),
      this.rows<any>(
        `SELECT c.constraint_name AS name, c.owner AS s, c.table_name AS t FROM all_constraints c
         JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name
         WHERE c.constraint_type='R' AND r.owner=:schema AND r.table_name=:tbl`,
        b,
      ),
      this.rows<any>(`SELECT num_rows AS r, last_analyzed AS la FROM all_tables WHERE owner=:schema AND table_name=:tbl`, b),
    ]);
    const pkCols = new Set(pk.map((p) => p.NAME));
    const st = stats[0] ?? {};
    return {
      schema,
      name: table,
      columns: cols.map((c) => ({
        name: c.NAME, dataType: c.TYPE, nullable: c.NULLABLE === 'Y', defaultValue: c.DEF,
        isPrimaryKey: pkCols.has(c.NAME), maxLength: c.LEN, ordinal: c.ORD,
      })),
      indexes: idx.map((i) => ({ name: i.NAME, columns: String(i.COLS).split(','), unique: i.UQ === 'UNIQUE', primary: false })),
      foreignKeys: fks.map((f) => ({ name: f.NAME, columns: String(f.COLS).split(','), refSchema: f.RS, refTable: f.RT, refColumns: String(f.RCOLS).split(',') })),
      referencedBy: refs.map((r) => ({ schema: r.S, table: r.T, name: r.NAME })),
      stats: { rowCount: st.R != null ? Number(st.R) : null, lastAnalyzed: st.LA ? new Date(st.LA).toISOString() : null },
    };
  }

  previewTable(schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(
      `SELECT * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)} OFFSET :1 ROWS FETCH NEXT :2 ROWS ONLY`,
      [offset, limit],
      { ...opts, maxRows: limit },
    );
  }

  async completionCatalog(schema = this.defaultSchema()) {
    const r = await this.rows<any>(
      `SELECT table_name AS t, LISTAGG(column_name, ',') WITHIN GROUP (ORDER BY column_id) AS c
       FROM all_tab_columns WHERE owner=:schema GROUP BY table_name`,
      { schema },
    );
    return r.map((x) => ({ schema, table: x.T, columns: String(x.C).split(',') }));
  }
}
