import type BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import { env } from '../config/env';
import type { ConnectionConfig, Connector, DbObject, QueryOptions, QueryResult, TableDetails } from './types';
import { buildResult, loadDriver, now, quoteDouble } from './util';
import { splitStatements } from './sql-guard';

type SqliteCtor = typeof BetterSqlite3;

export class SqliteConnector implements Connector {
  readonly dialect = 'sqlite' as const;
  private db?: BetterSqlite3.Database;

  constructor(private readonly cfg: ConnectionConfig) {}

  async connect() {
    if (this.db) return;
    const Database = loadDriver<SqliteCtor>('better-sqlite3');
    const file = this.cfg.options.filePath ?? this.cfg.database;
    if (!file) throw new Error('SQLite data source requires a file path');
    const base = path.resolve(env.SQLITE_BASE_DIR);
    const resolved = path.resolve(base, file);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`SQLite files must live inside SQLITE_BASE_DIR (${env.SQLITE_BASE_DIR})`);
    }
    this.db = new Database(resolved, { readonly: this.cfg.readOnly, fileMustExist: this.cfg.readOnly, timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
  }

  async close() {
    this.db?.close();
    this.db = undefined;
  }

  async ping() {
    await this.connect();
    const t = now();
    this.db!.prepare('SELECT 1').get();
    return Math.round(performance.now() - t);
  }

  placeholder() {
    return '?';
  }

  timeGroupExpr(col: string, s: number) {
    return `datetime((CAST(strftime('%s', ${col}) AS INTEGER) / ${s}) * ${s}, 'unixepoch')`;
  }

  quoteIdent = quoteDouble;

  async query(text: string, params: unknown[], opts: QueryOptions): Promise<QueryResult> {
    await this.connect();
    const start = now();
    if (splitStatements(text).length > 1 && params.length === 0 && !this.cfg.readOnly) {
      this.db!.exec(text);
      return buildResult([], opts.maxRows, start, []);
    }
    const stmt = this.db!.prepare(text);
    const bound = params.map((p) => (typeof p === 'boolean' ? Number(p) : p));
    if (!stmt.reader) {
      const info = stmt.run(...bound);
      return buildResult([], opts.maxRows, start, [], info.changes);
    }
    const rows: Record<string, unknown>[] = [];
    for (const row of stmt.iterate(...bound) as IterableIterator<Record<string, unknown>>) {
      rows.push(row);
      if (rows.length > opts.maxRows) break;
      if (performance.now() - start > opts.timeoutMs) throw new Error(`Query exceeded timeout of ${opts.timeoutMs}ms`);
    }
    const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? 'unknown' }));
    return buildResult(rows, opts.maxRows, start, columns);
  }

  async listSchemas() {
    return ['main'];
  }

  async listObjects(schema = 'main'): Promise<DbObject[]> {
    await this.connect();
    const rows = this.db!.prepare(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { name: string; type: string }[];
    return rows.map((r) => ({ schema, name: r.name, kind: r.type as DbObject['kind'] }));
  }

  async describeTable(schema: string, table: string): Promise<TableDetails> {
    await this.connect();
    const q = this.quoteIdent(table);
    const cols = this.db!.prepare(`PRAGMA table_info(${q})`).all() as any[];
    const idxList = this.db!.prepare(`PRAGMA index_list(${q})`).all() as any[];
    const indexes = idxList.map((i) => ({
      name: i.name,
      unique: !!i.unique,
      primary: i.origin === 'pk',
      columns: (this.db!.prepare(`PRAGMA index_info(${this.quoteIdent(i.name)})`).all() as any[]).map((c) => c.name),
    }));
    const fkRows = this.db!.prepare(`PRAGMA foreign_key_list(${q})`).all() as any[];
    type Fk = { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] };
    const fkMap = new Map<number, Fk>();
    for (const f of fkRows) {
      const e: Fk = fkMap.get(f.id) ?? { name: `fk_${table}_${f.id}`, columns: [], refSchema: 'main', refTable: String(f.table), refColumns: [] };
      e.columns.push(f.from);
      e.refColumns.push(f.to);
      fkMap.set(f.id, e);
    }
    const count = this.db!.prepare(`SELECT COUNT(*) AS c FROM ${q}`).get() as { c: number };
    return {
      schema,
      name: table,
      columns: cols.map((c) => ({
        name: c.name, dataType: c.type || 'ANY', nullable: !c.notnull, defaultValue: c.dflt_value,
        isPrimaryKey: c.pk > 0, maxLength: null, ordinal: c.cid + 1,
      })),
      indexes,
      foreignKeys: [...fkMap.values()],
      referencedBy: [],
      stats: { rowCount: count.c },
    };
  }

  async getDdl(_schema: string, name: string): Promise<string> {
    await this.connect();
    const rows = this.db!.prepare(`SELECT sql FROM sqlite_master WHERE (name = ? OR tbl_name = ?) AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 ELSE 1 END`).all(name, name) as { sql: string }[];
    return rows.map((r) => `${r.sql};`).join('\n\n');
  }

  previewTable(_schema: string, table: string, limit: number, offset: number, opts: QueryOptions) {
    return this.query(`SELECT * FROM ${this.quoteIdent(table)} LIMIT ? OFFSET ?`, [limit, offset], { ...opts, maxRows: limit });
  }

  async completionCatalog() {
    const objs = await this.listObjects();
    return objs.map((o) => ({
      schema: 'main',
      table: o.name,
      columns: (this.db!.prepare(`PRAGMA table_info(${this.quoteIdent(o.name)})`).all() as any[]).map((c) => c.name as string),
    }));
  }
}
