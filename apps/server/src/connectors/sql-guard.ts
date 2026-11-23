/**
 * Lightweight SQL statement classifier used as a *first line* of defence for read-only
 * data sources. It is NOT a substitute for database-level permissions: production data
 * sources should always be configured with a read-only database account.
 */

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE']);
const WRITE_TOKENS =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COPY|ATTACH|DETACH|RENAME|LOCK|VACUUM|REINDEX|PRAGMA|SET|INTO|DO|LOAD|HANDLER|BEGIN|COMMIT|ROLLBACK)\b/i;

/** Removes comments and string/identifier literals so keyword scanning is reliable. */
export function stripSql(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === q && sql[i + 1] === q) i += 2;
        else if (sql[i] === q) break;
        else i++;
      }
      i++;
      out += q === "'" ? "''" : '_ident_';
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      // Postgres dollar-quoted strings: $tag$ ... $tag$
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? n : end + tag.length;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function splitStatements(sql: string): string[] {
  return stripSql(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
  isSelectLike: boolean;
}

export function classify(sql: string): GuardResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, reason: 'Empty query', isSelectLike: false };
  const first = statements[0];
  const keyword = first.split(/\s+/)[0].replace(/^\(+/, '').toUpperCase();
  const isSelectLike = statements.length === 1 && (keyword === 'SELECT' || keyword === 'WITH');
  return { ok: true, isSelectLike };
}

export function assertReadOnly(sql: string): GuardResult {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, reason: 'Empty query', isSelectLike: false };
  if (statements.length > 1) return { ok: false, reason: 'Multiple statements are not allowed on read-only data sources', isSelectLike: false };
  const stmt = statements[0];
  const keyword = stmt.split(/\s+/)[0].replace(/^\(+/, '').toUpperCase();
  if (!READ_KEYWORDS.has(keyword)) {
    return { ok: false, reason: `Statement "${keyword}" is not permitted on a read-only data source`, isSelectLike: false };
  }
  // Strip the leading keyword then look for write tokens (catches data-modifying CTEs and SELECT INTO)
  const m = WRITE_TOKENS.exec(stmt);
  if (m) return { ok: false, reason: `Keyword "${m[1].toUpperCase()}" is not permitted on a read-only data source`, isSelectLike: false };
  return { ok: true, isSelectLike: keyword === 'SELECT' || keyword === 'WITH' };
}

/** Removes trailing semicolons/whitespace so the statement can be wrapped. */
export function trimStatement(sql: string): string {
  return sql.replace(/[\s;]+$/g, '');
}
