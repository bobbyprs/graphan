import type { Pool, PoolConfig, FieldDef } from 'pg';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now, quoteDouble } from './util';
import { classify, trimStatement } from './sql-guard';

type PgModule = typeof import('pg');

// Common PG type OIDs → friendly names
const PG_TYPES: Record<number, string> = {
  16: 'boolean', 20: 'bigint', 21: 'smallint', 23: 'integer', 700: 'real', 701: 'double', 1700: 'numeric',
  25: 'text', 1043: 'varchar', 1042: 'char', 1082: 'date', 1114: 'timestamp', 1184: 'timestamptz',
  2950: 'uuid', 114: 'json', 3802: 'jsonb', 17: 'bytea',
};

export class PostgresConnector implements Connector {
  readonly dialect = 'postgres' as const;
  private pool?: Pool;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.pool) return;
    const pg = loadDriver<PgModule>('pg');
    // Return int8/numeric as numbers where safe; dates as ISO strings via normalizeValue
    pg.types.setTypeParser(20, (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v));
    pg.types.setTypeParser(1700, (v) => Number(v));
    const o = this.cfg.options;
    const base: PoolConfig = this.cfg.connectionString
      ? { connectionString: this.cfg.connectionString }
      : {
          host: this.cfg.host ?? 'localhost',
          port: this.cfg.port ?? 5432,
          database: this.cfg.database ?? undefined,
          user: this.cfg.username ?? undefined,
          password: this.cfg.password,
        };
    this.pool = new pg.Pool({
      ...base,
      ssl: o.ssl ? { rejectUnauthorized: o.sslRejectUnauthorized ?? true } : undefined,
      min: o.poolMin ?? 0,
      max: o.poolMax ?? 10,
      idleTimeoutMillis: o.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'graphan',
    });
    this.pool.on('error', () => {
      /* idle client errors are surfaced via health checks */
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

  placeholder(i: number) {
    return `$${i}`;
  }

  timeGroupExpr(col: string, s: number) {
    return `to_timestamp(floor(extract(epoch from ${col}) / ${s}) * ${s})`;
  }

  quoteIdent = quoteDouble;

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const client = await this.pool!.connect();
    const start = now();
    const { isSelectLike } = classify(text);
    const PREFIX = 'SELECT * FROM (\n';
    const sql = isSelectLike ? `${PREFIX}${trimStatement(text)}\n) AS _g LIMIT ${opts.maxRows + 1}` : text;
    const rollback = this.cfg.readOnly || opts.rollback;
    // Cancellation: ask the server to cancel this backend's running statement
    const pid = (client as unknown as { processID?: number }).processID;
    const onAbort = () => {
      if (pid) void this.pool?.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await client.query(this.cfg.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(opts.timeoutMs)}`);
      const res = await client.query({ text: sql, values: params });
      await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
      const last = Array.isArray(res) ? res[res.length - 1] : res;
      const columns = (last.fields ?? []).map((f: FieldDef) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? 'unknown' }));
      return buildResult(last.rows ?? [], opts.maxRows, start, columns, last.command !== 'SELECT' ? last.rowCount ?? 0 : undefined);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Map error position back to the user's statement (undo the LIMIT wrapper)
      const err = e as { position?: string; message?: string };
      if (isSelectLike && err.position) err.position = String(Math.max(1, Number(err.position) - PREFIX.length));
      if (opts.signal?.aborted) err.message = 'Query cancelled by user';
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      client.release();
    }
  }

  async getDdl(schema: string, name: string, kind: DbObject['kind']): Promise<string> {
    const qn = `${this.quoteIdent(schema)}.${this.quoteIdent(name)}`;
    if (kind === 'function' || kind === 'procedure') {
      const r = await this.rows<{ def: string }>(
        `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid`,
        [schema, name],
      );
      return r.map((x) => `${x.def.trim()};`).join('\n\n');
    }
    if (kind === 'sequence') {
      const r = await this.rows<any>(
        `SELECT data_type, start_value, increment_by, min_value, max_value, cache_size, cycle FROM pg_sequences WHERE schemaname=$1 AND sequencename=$2`,
        [schema, name],
      );
      const s = r[0];
      if (!s) return `-- Sequence ${qn} not found`;
      return `-- SEQUENCE: ${schema}.${name}\n\n-- DROP SEQUENCE IF EXISTS ${qn};\n\nCREATE SEQUENCE IF NOT EXISTS ${qn}\n    AS ${s.data_type}\n    INCREMENT ${s.increment_by}\n    START ${s.start_value}\n    MINVALUE ${s.min_value}\n    MAXVALUE ${s.max_value}\n    CACHE ${s.cache_size}${s.cycle ? '\n    CYCLE' : ''};`;
    }
    const rel = await this.rows<{ oid: number; relkind: string; comment: string | null }>(
      `SELECT c.oid, c.relkind, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    if (!rel[0]) return `-- Object ${qn} not found`;
    const { oid, relkind, comment } = rel[0];
    if (relkind === 'v' || relkind === 'm') {
      const [{ def }] = await this.rows<{ def: string }>(`SELECT pg_get_viewdef($1::oid, true) AS def`, [oid]);
      const kw = relkind === 'm' ? 'MATERIALIZED VIEW' : 'VIEW';
      const create = relkind === 'm' ? `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qn}` : `CREATE OR REPLACE VIEW ${qn}`;
      return `-- ${kw}: ${schema}.${name}\n\n-- DROP ${kw} IF EXISTS ${qn};\n\n${create}\nAS\n${def.trim()}`;
    }
    const [cols, cons, idx, trg, colComments] = await Promise.all([
      this.rows<any>(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def,
                a.attidentity, a.attgenerated
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [oid],
      ),
      this.rows<any>(
        // contype 'n' = NOT NULL constraints (PG 18+); already emitted inline on the column
        `SELECT conname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint WHERE conrelid = $1 AND contype <> 'n'
         ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, conname`,
        [oid],
      ),
      this.rows<any>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
         WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = $1)`,
        [oid],
      ),
      this.rows<any>(`SELECT pg_get_triggerdef(oid, true) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal`, [oid]),
      this.rows<any>(
        `SELECT a.attname, col_description(a.attrelid, a.attnum) AS c FROM pg_attribute a
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND col_description(a.attrelid, a.attnum) IS NOT NULL`,
        [oid],
      ),
    ]);
    const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const lines = [
      ...cols.map((c) => {
        let l = `    ${this.quoteIdent(c.attname)} ${c.type}`;
        if (c.attidentity) l += ` GENERATED ${c.attidentity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
        else if (c.attgenerated === 's') l += ` GENERATED ALWAYS AS (${c.def}) STORED`;
        else if (c.def) l += ` DEFAULT ${c.def}`;
        if (c.attnotnull) l += ' NOT NULL';
        return l;
      }),
      ...cons.map((c) => `    CONSTRAINT ${this.quoteIdent(c.conname)} ${c.def}`),
    ];
    let out = `-- Table: ${schema}.${name}\n\n-- DROP TABLE IF EXISTS ${qn};\n\nCREATE TABLE IF NOT EXISTS ${qn}\n(\n${lines.join(',\n')}\n);`;
    if (comment) out += `\n\nCOMMENT ON TABLE ${qn}\n    IS ${lit(comment)};`;
    for (const c of colComments) out += `\n\nCOMMENT ON COLUMN ${qn}.${this.quoteIdent(c.attname)}\n    IS ${lit(c.c)};`;
    for (const i of idx) out += `\n\n${i.def};`;
    for (const t of trg) out += `\n\n${t.def};`;
    return out;
  }

  private async rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.connect();
    const r = await this.pool!.query(sql, params);
    return r.rows as T[];
  }

  async listSchemas() {
    const r = await this.rows<{ name: string }>(
      `SELECT nspname AS name FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
       ORDER BY 1`,
    );
    return r.map((x) => x.name);
  }

  async listObjects(schema = this.cfg.options.defaultSchema ?? 'public'): Promise<DbObject[]> {
    const rels = await this.rows<{ name: string; kind: string; est: number }>(
      `SELECT c.relname AS name, c.relkind AS kind, GREATEST(c.reltuples, 0)::bigint AS est
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY 1`,
      [schema],
    );
    const kindOf = (k: string): DbObject['kind'] => (k === 'v' ? 'view' : k === 'm' ? 'materialized_view' : k === 'S' ? 'sequence' : 'table');
    const routines = await this.rows<{ name: string; kind: string }>(
      `SELECT p.proname AS name, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY 1`,
      [schema],
    );
    return [
      ...rels.map((r) => ({
        schema,
        name: r.name,
        kind: kindOf(r.kind),
        rowEstimate: r.kind === 'S' ? null : Number(r.est),
      })),
      ...routines.map((r) => ({ schema, name: r.name, kind: r.kind as DbObject['kind'] })),
    ];
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    const [columns, indexes, fks, refs, stats] = await Promise.all([
      this.rows<any>(
        `SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default, c.character_maximum_length, c.ordinal_position,
                EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
                        WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND k.column_name=c.column_name) AS is_pk
         FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
                array_agg(a.attname::text ORDER BY array_position(ix.indkey::int2[], a.attnum)) AS columns
         FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
         WHERE n.nspname=$1 AND t.relname=$2 GROUP BY i.relname, ix.indisunique, ix.indisprimary`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT con.conname AS name, nf.nspname AS ref_schema, tf.relname AS ref_table,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num) AS columns,
                (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num, ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num) AS ref_columns
         FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
         JOIN pg_class tf ON tf.oid=con.confrelid JOIN pg_namespace nf ON nf.oid=tf.relnamespace
         WHERE con.contype='f' AND n.nspname=$1 AND t.relname=$2`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT con.conname AS name, n.nspname AS schema, t.relname AS table
         FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
         JOIN pg_class tf ON tf.oid=con.confrelid JOIN pg_namespace nf ON nf.oid=tf.relnamespace
         WHERE con.contype='f' AND nf.nspname=$1 AND tf.relname=$2`,
        [schema, table],
      ),
      this.rows<any>(
        `SELECT s.n_live_tup AS row_count, pg_total_relation_size(c.oid) AS total_bytes,
                GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyzed
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
         WHERE n.nspname=$1 AND c.relname=$2`,
        [schema, table],
      ),
    ]);
    const st = stats[0] ?? {};
    return {
      schema,
      name: table,
      columns: columns.map((c) => ({
        name: c.column_name,
        dataType: c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type,
        nullable: c.is_nullable === 'YES',
        defaultValue: c.column_default,
        isPrimaryKey: c.is_pk,
        maxLength: c.character_maximum_length,
        ordinal: c.ordinal_position,
      })),
      indexes: indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique, primary: i.primary })),
      foreignKeys: fks.map((f) => ({ name: f.name, columns: f.columns, refSchema: f.ref_schema, refTable: f.ref_table, refColumns: f.ref_columns })),
      referencedBy: refs.map((r) => ({ schema: r.schema, table: r.table, name: r.name })),
      stats: {
        rowCount: st.row_count != null ? Number(st.row_count) : null,
        totalBytes: st.total_bytes != null ? Number(st.total_bytes) : null,
        lastAnalyzed: st.last_analyzed ? new Date(st.last_analyzed).toISOString() : null,
      },
    };
  }

  previewTable(schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(`SELECT * FROM ${this.quoteIdent(schema)}.${this.quoteIdent(table)} LIMIT $1 OFFSET $2`, [limit, offset], {
      ...opts,
      maxRows: limit,
    });
  }

  /** Without a schema, covers every user schema (tables often live outside `public`). */
  async completionCatalog(schema?: string) {
    const r = await this.rows<{ table_schema: string; table_name: string; cols: string[] }>(
      `SELECT table_schema, table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols
       FROM information_schema.columns
       WHERE ${schema ? 'table_schema = $1' : "table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'"}
       GROUP BY table_schema, table_name
       LIMIT 5000`,
      schema ? [schema] : [],
    );
    return r.map((x) => ({ schema: x.table_schema, table: x.table_name, columns: x.cols }));
  }
}
