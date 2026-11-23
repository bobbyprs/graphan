import type { Connector, DbObjectKind, TableDetails } from './types';

/** Portable CREATE TABLE script built from introspected metadata (used when a driver has no native DDL). */
export function genericTableDdl(d: TableDetails, quote: (s: string) => string): string {
  const qn = `${quote(d.schema)}.${quote(d.name)}`;
  const pk = d.columns.filter((c) => c.isPrimaryKey).map((c) => quote(c.name));
  const lines = [
    ...d.columns.map(
      (c) =>
        `    ${quote(c.name)} ${c.dataType}${c.maxLength && !/\(/.test(c.dataType) && c.maxLength > 0 ? `(${c.maxLength})` : ''}` +
        `${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}${c.nullable ? '' : ' NOT NULL'}`,
    ),
    ...(pk.length ? [`    PRIMARY KEY (${pk.join(', ')})`] : []),
    ...d.foreignKeys.map(
      (f) =>
        `    CONSTRAINT ${quote(f.name)} FOREIGN KEY (${f.columns.map(quote).join(', ')}) REFERENCES ${quote(f.refSchema)}.${quote(f.refTable)} (${f.refColumns
          .map(quote)
          .join(', ')})`,
    ),
  ];
  let out = `-- Table: ${d.schema}.${d.name}\n\nCREATE TABLE ${qn}\n(\n${lines.join(',\n')}\n);`;
  for (const i of d.indexes.filter((x) => !x.primary)) {
    out += `\n\nCREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${quote(i.name)} ON ${qn} (${i.columns.map(quote).join(', ')});`;
  }
  return out;
}

export async function objectDdl(c: Connector, schema: string, name: string, kind: DbObjectKind): Promise<string> {
  if (c.getDdl) {
    const native = await c.getDdl(schema, name, kind);
    if (native) return native;
  }
  if (kind === 'table' || kind === 'collection') return genericTableDdl(await c.describeTable(schema, name), (s) => c.quoteIdent(s));
  return `-- DDL generation is not supported for ${kind} objects on this data source`;
}
