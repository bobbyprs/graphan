import type { DataSourceType, DbObject, TableDetails } from '@/api/types';

/** Quotes an identifier only when needed, per dialect (keeps generated SQL readable like pgAdmin). */
export function quoteIdent(type: DataSourceType, name: string): string {
  switch (type) {
    case 'MYSQL':
      return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
    case 'MSSQL':
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name.replace(/]/g, ']]')}]`;
    case 'ORACLE':
      return /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
    default:
      return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
  }
}

export function qualified(type: DataSourceType, schema: string, name: string) {
  return type === 'SQLITE' ? quoteIdent(type, name) : `${quoteIdent(type, schema)}.${quoteIdent(type, name)}`;
}

export function selectRows(type: DataSourceType, o: Pick<DbObject, 'schema' | 'name'>, limit?: number) {
  if (type === 'MONGODB') return JSON.stringify({ collection: o.name, find: {}, limit: limit ?? 1000 }, null, 2);
  const q = qualified(type, o.schema, o.name);
  if (!limit) return `SELECT * FROM ${q};`;
  if (type === 'MSSQL') return `SELECT TOP (${limit}) * FROM ${q};`;
  if (type === 'ORACLE') return `SELECT * FROM ${q}\nFETCH FIRST ${limit} ROWS ONLY;`;
  return `SELECT * FROM ${q}\nLIMIT ${limit};`;
}

export function countRows(type: DataSourceType, o: Pick<DbObject, 'schema' | 'name'>) {
  if (type === 'MONGODB') return JSON.stringify({ collection: o.name, aggregate: [{ $count: 'count' }] });
  return `SELECT COUNT(*) AS count FROM ${qualified(type, o.schema, o.name)}`;
}

export type ScriptKind = 'select' | 'insert' | 'update' | 'delete';

/** pgAdmin-style SELECT / INSERT / UPDATE / DELETE scripts with `?` placeholders. */
export function crudScript(type: DataSourceType, d: TableDetails, kind: ScriptKind): string {
  const q = qualified(type, d.schema, d.name);
  const cols = d.columns.map((c) => quoteIdent(type, c.name));
  const pk = d.columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(type, c.name));
  const where = pk.length ? pk.map((c) => `${c} = ?`).join(' AND ') : '<condition>';
  switch (kind) {
    case 'select':
      return `SELECT ${cols.join(', ')}\n\tFROM ${q};`;
    case 'insert':
      return `INSERT INTO ${q}(\n\t${cols.join(', ')})\n\tVALUES (${cols.map(() => '?').join(', ')});`;
    case 'update':
      return `UPDATE ${q}\n\tSET ${cols.filter((c) => !pk.includes(c)).map((c) => `${c}=?`).join(', ')}\n\tWHERE ${where};`;
    case 'delete':
      return `DELETE FROM ${q}\n\tWHERE ${where};`;
  }
}
