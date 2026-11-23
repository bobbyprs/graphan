import { toTime } from '../../ml/preprocess';
import { tkey, type ColumnRole, type JoinRec, type KpiRec, type RawTable, type TableInfo } from './engine';

/**
 * The data model: the user's corrections to what the analyzer detected. Stored per data source and
 * applied to every analysis, so wrong guesses are fixed once instead of every run.
 */
export interface TableOverride {
  label?: string;
  synonyms?: string[];
  /** column to use as the table's time axis; null = the table has no usable time column */
  timeColumn?: string | null;
  /** column that names a row (shown instead of ids when other tables join to this one) */
  labelColumn?: string | null;
  hidden?: boolean;
}

export interface ColumnOverride {
  role?: ColumnRole;
  label?: string;
  synonyms?: string[];
}

export interface ManualJoin {
  left: { schema: string; table: string; column: string };
  right: { schema: string; table: string; column: string };
}

export interface ModelOverrides {
  tables?: Record<string, TableOverride>;
  /** keyed by `${schema}.${table}|${column}` */
  columns?: Record<string, ColumnOverride>;
  joins?: { add?: ManualJoin[]; remove?: string[] };
  kpis?: Record<string, { name?: string; hidden?: boolean }>;
}

export const colKey = (tableKey: string, column: string) => `${tableKey}|${column}`;
export const joinId = (schema: string, table: string, column: string) => `j:${tkey(schema, table)}.${column}`;

export function isHidden(ov: ModelOverrides, key: string) {
  return !!ov.tables?.[key]?.hidden;
}

/** Left-side columns of manual joins for a table (profiled as foreign keys). */
export function manualKeyColumns(ov: ModelOverrides, key: string): string[] {
  return (ov.joins?.add ?? []).filter((j) => tkey(j.left.schema, j.left.table) === key).map((j) => j.left.column);
}

/** Applies table and column corrections to a freshly profiled table (mutates and returns it). */
export function applyTableOverrides(info: TableInfo, raw: RawTable, ov: ModelOverrides): TableInfo {
  const to = ov.tables?.[info.key];
  for (const c of info.columns) {
    const co = ov.columns?.[colKey(info.key, c.name)];
    if (!co) continue;
    if (co.label?.trim()) c.label = co.label.trim();
    if (co.synonyms?.length) c.synonyms = co.synonyms.map((s) => s.trim()).filter(Boolean);
    if (co.role && co.role !== c.role) {
      if (c.role === 'primaryKey' && info.primaryKey === c.name) info.primaryKey = undefined;
      Object.assign(c, { role: co.role, roleConfidence: 100, reason: 'Set in the data model' });
      if (co.role === 'primaryKey') info.primaryKey = c.name;
    }
    c.overridden = true;
  }
  if (to) {
    if (to.label?.trim()) info.label = to.label.trim();
    if (to.synonyms?.length) info.synonyms = to.synonyms.map((s) => s.trim()).filter(Boolean);
    if (to.labelColumn !== undefined) info.labelColumn = to.labelColumn && info.columns.some((c) => c.name === to.labelColumn) ? to.labelColumn : undefined;
    info.overridden = true;
  }

  // Time column: explicit choice, or re-pick when a role change removed / added time columns
  const isTime = (name?: string | null) => {
    const c = name ? info.columns.find((x) => x.name === name) : undefined;
    return !!c && (c.role === 'time' || c.role === 'auditTime' || c.kind === 'datetime');
  };
  let time = info.timeColumn;
  if (to && to.timeColumn !== undefined) time = to.timeColumn && isTime(to.timeColumn) ? to.timeColumn : undefined;
  else if (time && !isTime(time)) time = undefined;
  if (!time && !(to && to.timeColumn === null)) time = info.columns.find((c) => c.role === 'time' && c.nullPct < 50)?.name;
  if (time !== info.timeColumn) {
    info.timeColumn = time;
    const stats = time ? raw.timeStats?.[time] : undefined;
    const col = time ? info.columns.find((c) => c.name === time) : undefined;
    const lo = toTime(stats?.min);
    const hi = toTime(stats?.max);
    info.timeRange =
      lo !== null && hi !== null ? { from: new Date(lo).toISOString(), to: new Date(hi).toISOString() } : col?.min && col?.max ? { from: String(col.min), to: String(col.max) } : undefined;
  }
  return info;
}

/** Removes rejected joins and adds manual ones (manual wins over a detected join on the same column). */
export function applyJoinOverrides(joins: JoinRec[], ov: ModelOverrides, raws: Map<string, RawTable>): { joins: JoinRec[]; invalid: string[] } {
  const remove = new Set(ov.joins?.remove ?? []);
  const invalid: string[] = [];
  const manual: JoinRec[] = [];
  for (const m of ov.joins?.add ?? []) {
    const l = raws.get(tkey(m.left.schema, m.left.table));
    const r = raws.get(tkey(m.right.schema, m.right.table));
    const ok = l?.details.columns.some((c) => c.name === m.left.column) && r?.details.columns.some((c) => c.name === m.right.column);
    if (!ok) {
      invalid.push(`${tkey(m.left.schema, m.left.table)}.${m.left.column} → ${tkey(m.right.schema, m.right.table)}.${m.right.column}`);
      continue;
    }
    manual.push({ id: joinId(m.left.schema, m.left.table, m.left.column), left: { ...m.left }, right: { ...m.right }, confidence: 100, source: 'manual', relation: 'many-to-one' });
  }
  const manualIds = new Set(manual.map((j) => j.id));
  return { joins: [...manual, ...joins.filter((j) => !remove.has(j.id) && !manualIds.has(j.id))], invalid };
}

export function applyKpiOverrides(kpis: KpiRec[], ov: ModelOverrides): KpiRec[] {
  const out: KpiRec[] = [];
  for (const k of kpis) {
    const o = ov.kpis?.[k.id];
    if (o?.hidden) continue;
    out.push(o?.name?.trim() ? { ...k, name: o.name.trim(), reason: `${k.reason} (renamed in the data model)` } : k);
  }
  return out;
}

/** Number of individual corrections (for the UI badge). */
export function overrideCount(ov: ModelOverrides) {
  return (
    Object.keys(ov.tables ?? {}).length +
    Object.keys(ov.columns ?? {}).length +
    (ov.joins?.add?.length ?? 0) +
    (ov.joins?.remove?.length ?? 0) +
    Object.keys(ov.kpis ?? {}).length
  );
}
