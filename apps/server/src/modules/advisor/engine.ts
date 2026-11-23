import type { TableDetails } from '../../connectors/types';
import { inferKind, toNumber, toTime, type ColumnKind } from '../../ml/preprocess';
import { mad, mean, median, pearson } from '../../ml/stats';
import type { QuerySpec, SelectItem, JoinStep, TableKeyRef } from './sql';

type Row = Record<string, unknown>;

// ───────────────────────── Types ─────────────────────────

export type ColumnRole = 'primaryKey' | 'foreignKey' | 'time' | 'auditTime' | 'measure' | 'dimension' | 'flag' | 'label' | 'identifier' | 'text' | 'empty';

export interface ColumnInfo {
  name: string;
  dataType: string;
  kind: ColumnKind;
  role: ColumnRole;
  /** 0–100: how sure the role prediction is */
  roleConfidence: number;
  reason: string;
  nullPct: number;
  uniquePct: number;
  distinct: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  top?: { value: string; count: number }[];
  /** set in the data model */
  label?: string;
  synonyms?: string[];
  overridden?: boolean;
}

export type TableKind = 'fact' | 'dimension' | 'bridge' | 'entity' | 'empty';

export interface TableInfo {
  key: string;
  schema: string;
  name: string;
  rowCount: number;
  /** profile computed from a sample rather than every row */
  sampled: boolean;
  sampleSize: number;
  kind: TableKind;
  importance: number;
  primaryKey?: string;
  labelColumn?: string;
  timeColumn?: string;
  timeRange?: { from: string; to: string };
  columns: ColumnInfo[];
  notes: string[];
  /** set in the data model */
  label?: string;
  synonyms?: string[];
  overridden?: boolean;
}

export interface JoinRec {
  id: string;
  left: { schema: string; table: string; column: string };
  right: { schema: string; table: string; column: string };
  confidence: number;
  source: 'declared' | 'inferred' | 'manual';
  scores?: { name: number; datatype: number; overlap: number };
  relation: 'many-to-one';
}

export interface KpiRec {
  id: string;
  name: string;
  table: string;
  column?: string;
  category: 'revenue' | 'count' | 'performance' | 'quantity' | 'rate' | 'size' | 'measure' | 'volume';
  agg: SelectItem;
  unit: 'short' | 'currency' | 'ms' | 's' | 'percent' | 'bytes';
  format: string;
  score: number;
  reason: string;
}

export interface Insight {
  id: string;
  kind: 'trend' | 'growth' | 'seasonality' | 'outlier' | 'contributors' | 'correlation' | 'quality';
  title: string;
  detail: string;
  score: number;
  table: string;
  direction?: 'up' | 'down' | 'flat';
  series?: { t: string; v: number }[];
}

export type SuggestionKind = 'kpi' | 'trend' | 'trendBy' | 'breakdown' | 'share' | 'failures' | 'heatmap' | 'detail' | 'relationship';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  viz: 'kpi' | 'line' | 'area' | 'bar' | 'pie' | 'heatmap' | 'table' | 'scatter';
  table: string;
  tables: string[];
  joinIds: string[];
  score: number;
  recommended: boolean;
  spec: QuerySpec;
  /** field names in the result (for panel options / report items) */
  fields: { category?: string; value?: string; values?: string[]; series?: string; x?: string; y?: string; xLabel?: string; yLabel?: string };
  unit: KpiRec['unit'];
  format?: string;
  kpiId?: string;
  /** dimension the panel breaks down by (used for filters / drill-down) */
  dimension?: DimensionRef;
  /** time bucket chosen by a question ("per week"); otherwise picked from the data's span */
  timeUnit?: 'day' | 'week' | 'month';
  /** created from a plain-language question */
  question?: string;
  preview?: { columns: { name: string; type: string }[]; rows: Row[] };
}

export interface DimensionRef {
  id: string;
  label: string;
  /** physical column */
  table: TableKeyRef;
  col: string;
  distinct: number;
  text?: boolean;
}

export interface RawTable {
  details: TableDetails;
  sample: Row[];
  rowCount: number;
  timeStats?: Record<string, { min: unknown; max: unknown }>;
}

// ───────────────────────── Helpers ─────────────────────────

export const tkey = (schema: string, table: string) => `${schema}.${table}`;

/** Display name for a table's rows: "tblfaultcodemaster" → "Faultcode". */
export function entityName(table: string) {
  const s = table.replace(/^(tbl|tb|t_|vw_|v_|dim_|fact_|mst_|m_)(?=[a-z])/i, '').replace(/(_?master|_?mst)$/i, '');
  return humanize(s || table);
}

export function humanize(s: string) {
  const t = s
    .replace(/^(tbl|tb|t_|vw_|v_)(?=[a-z])/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Table name without prefixes/suffixes that carry no meaning ("tblgtsmaster" → "gts"). */
export function stem(name: string) {
  let s = name.toLowerCase().replace(/^(tbl|tb|t_|dim_|fact_|vw_|v_|mst_|m_)/, '');
  s = s.replace(/(_?master|_?mst|_?details?|_?table|_?list|_?data)$/, '');
  s = s.replace(/_+$/, '');
  if (s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (/(ss|us|is)$/.test(s)) void 0;
  else if (s.endsWith('es') && /(ch|sh|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s')) s = s.slice(0, -1);
  return s;
}

/** Dice coefficient over character bigrams (0–1). */
export function similarity(a: string, b: string) {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  const total = x.length - 1 + (y.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

export const typeFamily = (t: string) => {
  const s = t.toLowerCase();
  if (/(int|serial|bigint|smallint|tinyint|number\(\d+\)|^number$)/.test(s)) return 'int';
  if (/(numeric|decimal|real|double|float|money)/.test(s)) return 'num';
  if (/(char|text|string|uuid|varchar|nvarchar|clob)/.test(s)) return 'text';
  if (/(date|time)/.test(s)) return 'time';
  if (/bool|bit/.test(s)) return 'bool';
  return s;
};

export function datatypeMatch(a: string, b: string) {
  const fa = typeFamily(a);
  const fb = typeFamily(b);
  if (fa === fb) return 1;
  if ((fa === 'int' && fb === 'num') || (fa === 'num' && fb === 'int')) return 0.7;
  if ((fa === 'text' && fb === 'int') || (fa === 'int' && fb === 'text')) return 0.3;
  return 0;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const missing = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// ───────────────────────── Column profiling & roles ─────────────────────────

const AUDIT_TIME = /(updated|modified|lastupdated|last_updated|changed|synced|sync_?time|deleted|expire)/i;
const EVENT_TIME = /(created|registered|_at$|_on$|date|time|timestamp|^ts$|log_time|occurred|event|start|logged|joined|period|day$)/i;
const NOT_MEASURE = /(^is_|^has_|flag|year|month|week|^day|hour|code$|status|type$|level$|^serviceid$|zip|pin|phone|mobile|(^|_)(lat|lon|lng|latitude|longitude)($|_)|_no$|number$|^length$|^port$|baud|_id_?hex|^fmi$|^spn$|^sid$|^pid$|^did$)/i;
const ORDER_COL = /(^seq$|^seq_?no$|sequence|^sort|sort_?order|^order(_?no|_?index)?$|position|^pos$|^idx$|index$|version|^rev$|revision)/i;
/** Technical strings: never useful as a dimension */
export const CODE_LIKE = /(_hex$|^hex|hex_|lid$|_ref$|^ref_|path$|url$|_key$|uuid|guid|hash|token|checksum|^cvn$|mask|dll|script|_file$|filename|^s3|password|secret|session_?data)/i;
/** Configured limits, not business measures */
const BOUND = /(^min|^max|min$|max$|^default|range|_?from$|_?to$|limit|threshold|lower|upper|^offset|length|startbyte|_bit$|_bytes$)/i;
const MEASURE_WORD = /(errors|failures|retries|hits|views|clicks|visits|calls|requests|amount|revenue|sales|price|cost|qty|quantity|count|total|value|duration|latency|size|bytes|score|rate|weight|volume|profit|income|elapsed|time_?ms|seconds|minutes|hours|distance|km|mileage|odometer|speed|temperature|voltage|current|pressure|balance|spend|fee)/i;
const LABEL_NAME = /^(name|title|label|description|display_?name|full_?name|.*_name|.*name|code|short_?name|caption|subject)$/i;
const DIM_NAME = /(status|type|category|kind|class|group|segment|region|country|state|city|channel|source|level|tier|result|mode|stage|priority|gender|unit|department|brand|model|variant|interface|communication|updatedby|created_?by|owner|user)/i;

export function profileTable(raw: RawTable, keyColumns: Set<string>): TableInfo {
  const d = raw.details;
  const key = tkey(d.schema, d.name);
  const n = raw.sample.length;
  let pkCols = d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  let impliedPk: string | undefined;
  if (!pkCols.length && n) {
    const st = stem(d.name);
    const cand = d.columns.find((c) => {
      if (!new RegExp(`^(id|${st}_?id|${st}_?key)$`, 'i').test(c.name)) return false;
      const vals = raw.sample.map((r) => r[c.name]);
      return vals.every((v) => v !== null && v !== undefined) && new Set(vals.map(String)).size === vals.length;
    });
    if (cand) {
      impliedPk = cand.name;
      pkCols = [cand.name];
    }
  }
  const fkCols = new Set(d.foreignKeys.flatMap((f) => f.columns));
  const columns: ColumnInfo[] = d.columns.map((col) => {
    const values = raw.sample.map((r) => r[col.name]);
    const present = values.filter((v) => !missing(v));
    const kind = n ? inferKind(col.name, values) : 'empty';
    const distinctSet = new Set(present.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v))));
    const info: ColumnInfo = {
      name: col.name,
      dataType: col.dataType,
      kind,
      role: 'text',
      roleConfidence: 50,
      reason: '',
      nullPct: n ? round1((1 - present.length / n) * 100) : 0,
      uniquePct: present.length ? round1((distinctSet.size / present.length) * 100) : 0,
      distinct: distinctSet.size,
    };
    const nums = present.map(toNumber).filter((x): x is number => x !== null);
    if (nums.length === present.length && nums.length && typeFamily(col.dataType) !== 'text') {
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of nums) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      info.min = lo;
      info.max = hi;
      info.mean = Math.round(mean(nums) * 1000) / 1000;
    } else if (kind === 'datetime' || typeFamily(col.dataType) === 'time') {
      const ts = present.map(toTime).filter((x): x is number => x !== null);
      if (ts.length) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const x of ts) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        info.min = new Date(lo).toISOString();
        info.max = new Date(hi).toISOString();
      }
    }
    if (kind === 'categorical' || kind === 'boolean' || (kind === 'numeric' && distinctSet.size <= 12)) {
      const counts = new Map<string, number>();
      for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      info.top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, count]) => ({ value, count }));
    }
    assignRole(info, { isPk: (col.isPrimaryKey || col.name === impliedPk) && pkCols.length === 1, isPkPart: col.isPrimaryKey, isFk: fkCols.has(col.name) || keyColumns.has(col.name), n });
    if (col.name === impliedPk) Object.assign(info, { roleConfidence: 75, reason: 'Unique, non-null id column (no declared primary key)' });
    return info;
  });

  // Time column: prefer an event/creation time over audit columns
  const times = columns.filter((c) => c.role === 'time' || c.role === 'auditTime');
  const time = times.find((c) => c.role === 'time' && c.nullPct < 50) ?? times.find((c) => c.nullPct < 50);
  const stats = time ? raw.timeStats?.[time.name] : undefined;
  const tr = stats && toTime(stats.min) !== null && toTime(stats.max) !== null ? { from: new Date(toTime(stats.min)!).toISOString(), to: new Date(toTime(stats.max)!).toISOString() } : undefined;

  const label = pickLabel(columns);
  const info: TableInfo = {
    key,
    schema: d.schema,
    name: d.name,
    rowCount: raw.rowCount,
    sampled: raw.rowCount > n,
    sampleSize: n,
    kind: 'entity',
    importance: 0,
    primaryKey: pkCols.length === 1 ? pkCols[0] : undefined,
    labelColumn: label?.name,
    timeColumn: time?.name,
    timeRange: tr ?? (time?.min && time?.max ? { from: String(time.min), to: String(time.max) } : undefined),
    columns,
    notes: [],
  };
  if (!d.columns.some((c) => c.isPrimaryKey)) info.notes.push(impliedPk ? `No declared primary key (${impliedPk} is unique)` : 'No primary key');
  const sparse = columns.filter((c) => c.nullPct >= 60 && c.role !== 'empty');
  if (sparse.length) info.notes.push(`${sparse.length} mostly-empty column${sparse.length > 1 ? 's' : ''} (${sparse.slice(0, 3).map((c) => c.name).join(', ')})`);
  return info;
}

function assignRole(c: ColumnInfo, ctx: { isPk: boolean; isPkPart: boolean; isFk: boolean; n: number }) {
  const set = (role: ColumnRole, conf: number, reason: string) => Object.assign(c, { role, roleConfidence: conf, reason });
  const tf = typeFamily(c.dataType);
  if (!ctx.n || c.kind === 'empty') return set('empty', 90, ctx.n ? 'All sampled values are empty' : 'Table has no rows');
  if (ctx.isPk) return set('primaryKey', 100, 'Declared primary key');
  if (ctx.isFk) return set('foreignKey', 95, 'References another table');
  if (c.kind === 'datetime' || tf === 'time') {
    return AUDIT_TIME.test(c.name) ? set('auditTime', 80, 'Record-maintenance timestamp') : set('time', EVENT_TIME.test(c.name) ? 92 : 75, 'Date/time values');
  }
  if (c.kind === 'boolean' || tf === 'bool') return set('flag', 90, 'Yes/no values');
  if (ORDER_COL.test(c.name)) return set('identifier', 80, 'Ordering / version column');
  if (CODE_LIKE.test(c.name)) return set('identifier', 75, 'Technical code or reference');
  if (c.kind === 'identifier' || (/(^id$|_id$|uuid|guid)/i.test(c.name) && c.uniquePct > 50)) return set('identifier', 85, 'Unique key-like values');
  if (c.kind === 'numeric') {
    const word = MEASURE_WORD.test(c.name);
    const ints = Number.isInteger(c.min) && Number.isInteger(c.max);
    if (NOT_MEASURE.test(c.name)) return c.distinct <= 30 ? set('dimension', 65, 'Numeric code with few values') : set('identifier', 60, 'Numeric code');
    if (c.distinct <= 1) return set('dimension', 40, 'Constant value');
    if (BOUND.test(c.name) && !/(amount|price|cost|revenue)/i.test(c.name)) return set('measure', 55, 'Configured bound / setting (not summed)');
    if (ints && !word && c.distinct <= 32 && Number(c.max) - Number(c.min) <= 64) return set('dimension', 62, 'Small set of integer codes');
    if (ints && !word && c.uniquePct >= 60 && c.distinct > 32) return set('identifier', 55, 'Mostly-unique integers (code or number)');
    return set('measure', word ? 92 : 70, 'Numeric values that vary');
  }
  if (c.kind === 'text') return LABEL_NAME.test(c.name) ? set('label', 80, 'Descriptive name') : set('text', 70, 'Free text');
  // categorical
  if (LABEL_NAME.test(c.name) && c.uniquePct >= 70) return set('label', 85, 'Mostly-unique descriptive name');
  if (c.distinct >= 2 && c.distinct <= 60) return set('dimension', DIM_NAME.test(c.name) ? 92 : c.distinct <= 12 ? 75 : 62, `${c.distinct} distinct values`);
  if (c.distinct < 2) return set('dimension', 40, 'Single value in sample');
  return c.uniquePct >= 70 ? set('label', 60, 'Mostly-unique text') : set('dimension', 55, `High cardinality (${c.distinct})`);
}

function pickLabel(cols: ColumnInfo[]) {
  const cands = cols.filter((c) => ['label', 'dimension', 'text'].includes(c.role) && c.kind !== 'boolean' && c.nullPct < 50 && typeFamily(c.dataType) === 'text');
  const rank = (c: ColumnInfo) =>
    (/^name$/i.test(c.name) ? 50 : /name$/i.test(c.name) ? 40 : /^(title|label|description|caption)$/i.test(c.name) ? 35 : /^code$|code$/i.test(c.name) ? 20 : 0) + Math.min(c.uniquePct, 100) / 5 - (c.role === 'text' ? 10 : 0);
  return cands.sort((a, b) => rank(b) - rank(a)).find((c) => rank(c) >= 20);
}

// ───────────────────────── Joins ─────────────────────────

export interface JoinCandidate {
  left: TableInfo;
  leftCol: ColumnInfo;
  right: TableInfo;
  rightCol: string;
  name: number;
  datatype: number;
  /** distinct sample values of the left column (to check overlap against the right table) */
  values: (string | number)[];
}

export function declaredJoins(raws: RawTable[]): JoinRec[] {
  const out: JoinRec[] = [];
  for (const r of raws)
    for (const f of r.details.foreignKeys) {
      if (f.columns.length !== 1) continue;
      out.push({
        id: `j:${tkey(r.details.schema, r.details.name)}.${f.columns[0]}`,
        left: { schema: r.details.schema, table: r.details.name, column: f.columns[0] },
        right: { schema: f.refSchema || r.details.schema, table: f.refTable, column: f.refColumns[0] },
        confidence: 100,
        source: 'declared',
        relation: 'many-to-one',
      });
    }
  return out;
}

/** Undeclared joins worth testing: name-similar key columns with compatible types. */
export function joinCandidates(tables: TableInfo[], declared: JoinRec[], raws: Map<string, RawTable>): JoinCandidate[] {
  const have = new Set(declared.map((j) => `${tkey(j.left.schema, j.left.table)}.${j.left.column}`));
  const targets = tables.filter((t) => t.primaryKey && t.rowCount > 0);
  const out: JoinCandidate[] = [];
  for (const t of tables) {
    if (!t.rowCount) continue;
    for (const c of t.columns) {
      if (c.role === 'primaryKey' || have.has(`${t.key}.${c.name}`)) continue;
      if (!/(_id|id|_key|_code|_no|_num|_ref)$/i.test(c.name) || CODE_LIKE.test(c.name.replace(/_key$|_ref$/i, ''))) continue;
      if (c.distinct < 1 || c.role === 'measure' || c.role === 'time' || c.role === 'auditTime' || c.role === 'flag') continue;
      const base = c.name.toLowerCase().replace(/(_?id|_?key|_?code|_?no|_?num)$/, '');
      for (const r of targets) {
        if (r.key === t.key) continue;
        const pk = r.columns.find((x) => x.name === r.primaryKey)!;
        const dt = datatypeMatch(c.dataType, pk.dataType);
        if (dt === 0) continue;
        let name: number;
        if (pk.name.toLowerCase() !== 'id' && pk.name.toLowerCase() === c.name.toLowerCase()) name = 1;
        else if (base && base === stem(r.name)) name = 1;
        else name = base ? Math.max(similarity(base, stem(r.name)), pk.name.toLowerCase() !== 'id' ? similarity(c.name, pk.name) : 0) : 0;
        if (name < 0.6) continue;
        const sample = raws.get(t.key)!.sample;
        const values = [...new Set(sample.map((row) => row[c.name]).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number'))].slice(0, 200);
        if (!values.length) continue;
        out.push({ left: t, leftCol: c, right: r, rightCol: pk.name, name, datatype: dt, values });
      }
    }
  }
  // Keep the best few targets per column
  const best = new Map<string, JoinCandidate[]>();
  for (const c of out) {
    const k = `${c.left.key}.${c.leftCol.name}`;
    best.set(k, [...(best.get(k) ?? []), c].sort((a, b) => b.name - a.name).slice(0, 3));
  }
  return [...best.values()].flat().slice(0, 150);
}

/** confidence = name_similarity·0.3 + datatype_match·0.2 + value_overlap·0.5 (as %). */
export function scoreJoin(c: JoinCandidate, overlap: number): JoinRec {
  const confidence = Math.round((c.name * 0.3 + c.datatype * 0.2 + overlap * 0.5) * 100);
  return {
    id: `j:${c.left.key}.${c.leftCol.name}`,
    left: { schema: c.left.schema, table: c.left.name, column: c.leftCol.name },
    right: { schema: c.right.schema, table: c.right.name, column: c.rightCol },
    confidence,
    source: 'inferred',
    scores: { name: round1(c.name * 100), datatype: round1(c.datatype * 100), overlap: round1(overlap * 100) },
    relation: 'many-to-one',
  };
}

// ───────────────────────── Table classification ─────────────────────────

export function classifyTables(tables: TableInfo[], joins: JoinRec[]) {
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const j of joins) {
    const l = tkey(j.left.schema, j.left.table);
    const r = tkey(j.right.schema, j.right.table);
    outgoing.set(l, (outgoing.get(l) ?? 0) + 1);
    incoming.set(r, (incoming.get(r) ?? 0) + 1);
  }
  for (const t of tables) {
    const out = outgoing.get(t.key) ?? 0;
    const inc = incoming.get(t.key) ?? 0;
    const meaningful = t.columns.filter((c) => ['measure', 'dimension', 'label', 'text'].includes(c.role) && !/updatedby/i.test(c.name)).length;
    const measures = t.columns.filter((c) => c.role === 'measure').length;
    if (!t.rowCount) t.kind = 'empty';
    else if (out >= 2 && meaningful <= 1) t.kind = 'bridge';
    else if (inc >= 2 && t.labelColumn && measures === 0) t.kind = 'dimension';
    else if (t.timeColumn && out >= 1 && (measures > 0 || inc === 0 || t.columns.some((c) => isOutcomeColumn(c)))) t.kind = 'fact';
    else if (inc > 0 && t.labelColumn) t.kind = 'dimension';
    else t.kind = t.timeColumn && out >= 1 ? 'fact' : 'entity';
    const rows = Math.min(40, Math.log10(t.rowCount + 1) * 10);
    const rel = Math.min(20, out * 6 + inc * 2);
    const content = Math.min(20, measures * 6 + meaningful * 2 + (t.columns.some(isOutcomeColumn) ? 8 : 0));
    const time = t.timeColumn ? (t.columns.find((c) => c.name === t.timeColumn)?.role === 'time' ? 15 : 9) : 0;
    const kindAdj = t.kind === 'fact' ? 5 : t.kind === 'bridge' ? -15 : t.kind === 'empty' ? -100 : 0;
    t.importance = Math.max(0, Math.min(100, Math.round(rows + rel + content + time + kindAdj)));
  }
}

// ───────────────────────── KPI detection ─────────────────────────

const KPI_KEYWORDS: { category: KpiRec['category']; re: RegExp; weight: number; unit?: KpiRec['unit']; agg: 'sum' | 'avg' }[] = [
  { category: 'revenue', re: /(revenue|amount|sales|income|price|cost|profit|value|turnover|fee|charge|spend|margin)/i, weight: 40, unit: 'currency', agg: 'sum' },
  { category: 'performance', re: /(duration|response_?time|processing_?time|latency|elapsed|wait|turnaround|ms$|_secs?$|seconds)/i, weight: 36, agg: 'avg' },
  { category: 'quantity', re: /(qty|quantity|units|volume|count|total|num_|items|pieces)/i, weight: 34, agg: 'sum' },
  { category: 'size', re: /(bytes|size|length_?mb|_kb|_mb|weight)/i, weight: 22, unit: 'bytes', agg: 'sum' },
  { category: 'rate', re: /(rate|ratio|pct|percent|score|efficiency|utili[sz]ation)/i, weight: 28, unit: 'percent', agg: 'avg' },
];

export const GOOD = ['pass', 'passed', 'success', 'successful', 'ok', 'completed', 'complete', 'done', 'approved', 'true', 'yes', 'resolved', 'closed', 'delivered', 'valid', 'succeeded'];
export const BAD = ['fail', 'failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'aborted', 'invalid', 'timeout', 'declined', 'false', 'no', 'not ok', 'nok'];

export function isOutcomeColumn(c: ColumnInfo) {
  if (c.role !== 'dimension' || !c.top?.length) return false;
  const vals = c.top.map((t) => t.value.toLowerCase().trim());
  return vals.some((v) => GOOD.includes(v)) && vals.some((v) => BAD.includes(v) || !GOOD.includes(v)) && /(result|status|outcome|state)/i.test(c.name);
}

/** Display names that honour the data model's labels. */
export const tableLabel = (t: TableInfo) => t.label || entityName(t.name);
export const colLabel = (c: ColumnInfo) => c.label || humanize(c.name);

export function outcomeValues(c: ColumnInfo) {
  return [...new Set((c.top ?? []).map((t) => t.value.toLowerCase().trim()).filter((v) => GOOD.includes(v)))];
}

export function detectKpis(tables: TableInfo[], joins: JoinRec[]): KpiRec[] {
  const out: KpiRec[] = [];
  for (const t of tables) {
    if (t.kind === 'empty' || t.kind === 'bridge') continue;
    const imp = t.importance / 100;
    const entity = tableLabel(t);
    // Row volume is the universal KPI for event/fact tables
    if (t.kind === 'fact' || t.timeColumn) {
      out.push({
        id: `k:${t.key}:count`,
        name: `${entity} records`,
        table: t.key,
        category: 'volume',
        agg: { kind: 'agg', fn: 'count', as: 'value' },
        unit: 'short',
        format: 'N0',
        score: Math.round(45 + imp * 40 + (t.kind === 'fact' ? 8 : 0)),
        reason: t.timeColumn ? `Row count of ${t.name}, trendable by ${t.timeColumn}` : `Row count of ${t.name}`,
      });
    }
    for (const c of t.columns) {
      if (c.role === 'measure' && c.roleConfidence >= 65) {
        const kw = KPI_KEYWORDS.find((k) => k.re.test(c.name));
        const spread = c.distinct > 10 ? 10 : c.distinct > 2 ? 5 : 0;
        const complete = (100 - c.nullPct) / 10;
        const agg = kw?.agg ?? (c.min !== undefined && Number(c.min) >= 0 ? 'sum' : 'avg');
        const unit = kw?.unit ?? (/(_ms|ms$)/i.test(c.name) ? 'ms' : 'short');
        const label = `${agg === 'sum' ? 'Total' : 'Average'} ${colLabel(c).toLowerCase()}`;
        out.push({
          id: `k:${t.key}:${c.name}`,
          name: label.charAt(0).toUpperCase() + label.slice(1),
          table: t.key,
          column: c.name,
          category: kw?.category ?? 'measure',
          agg: { kind: 'agg', fn: agg, alias: 't0', col: c.name, as: 'value' },
          unit,
          format: unit === 'currency' ? 'C0' : unit === 'percent' ? 'N1' : Number.isInteger(c.min) && Number.isInteger(c.max) && agg === 'sum' ? 'N0' : 'N2',
          score: Math.round(Math.min(99, kw ? kw.weight + spread + complete + imp * 35 : 8 + spread + complete + imp * 25)),
          reason: kw ? `"${c.name}" looks like a ${kw.category} measure` : `Numeric measure (${c.distinct} distinct values)`,
        });
      } else if (isOutcomeColumn(c)) {
        const good = outcomeValues(c);
        out.push({
          id: `k:${t.key}:${c.name}:rate`,
          name: `${colLabel(c)} success rate`,
          table: t.key,
          column: c.name,
          category: 'rate',
          agg: { kind: 'rate', alias: 't0', col: c.name, values: good, as: 'value' },
          unit: 'percent',
          format: 'N1',
          score: Math.round(Math.min(99, 55 + imp * 40)),
          reason: `"${c.name}" has outcome values (${c.top!.slice(0, 4).map((x) => x.value).join(', ')})`,
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function pluralize(s: string) {
  const l = s.toLowerCase();
  if (/(s|x|ch|sh)$/.test(l)) return `${s}es`;
  if (/[^aeiou]y$/.test(l)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

// ───────────────────────── Dimensions reachable from a table ─────────────────────────

export interface DimPath {
  dim: DimensionRef;
  joins: JoinStep[];
  /** alias the dimension column lives on */
  alias: string;
  score: number;
  viaJoin: boolean;
}

export function dimensionsFor(t: TableInfo, byKey: Map<string, TableInfo>, joins: JoinRec[]): DimPath[] {
  const out: DimPath[] = [];
  for (const c of t.columns) {
    if (c.role !== 'dimension' && c.role !== 'flag') continue;
    if (c.distinct < 2 || c.distinct > 60 || c.nullPct > 70 || CODE_LIKE.test(c.name)) continue;
    const audit = /(updatedby|updated_by|created_?by|modified_?by)/i.test(c.name);
    const boring = /^(is_?active|active|isdeleted|is_?deleted|deleted|enabled)$/i.test(c.name);
    out.push({
      dim: { id: `d:${t.key}.${c.name}`, label: colLabel(c), table: { schema: t.schema, table: t.name }, col: c.name, distinct: c.distinct, text: typeFamily(c.dataType) === 'text' },
      joins: [],
      alias: 't0',
      viaJoin: false,
      score: 50 - Math.round(c.nullPct / 4) + cardScore(c.distinct) + (isOutcomeColumn(c) ? 15 : 0) + (DIM_NAME.test(c.name) ? 8 : 0) - (audit ? 18 : 0) - (boring ? 25 : 0) - (c.role === 'flag' ? 8 : 0),
    });
  }
  let n = 0;
  const step = (fromAlias: string, from: TableInfo, depth: number, path: JoinStep[], scoreBase: number) => {
    for (const j of joins) {
      if (tkey(j.left.schema, j.left.table) !== from.key) continue;
      const r = byKey.get(tkey(j.right.schema, j.right.table));
      if (!r || !r.rowCount || r.key === t.key || path.some((p) => tkey(p.table.schema, p.table.table) === r.key)) continue;
      const alias = `j${++n}`;
      const js: JoinStep = { fromAlias, fromColumn: j.left.column, table: { schema: r.schema, table: r.name }, alias, column: j.right.column, joinId: j.id };
      const nextPath = [...path, js];
      const fkCol = from.columns.find((c) => c.name === j.left.column);
      const label = r.labelColumn ? r.columns.find((c) => c.name === r.labelColumn) : undefined;
      if (label && fkCol && fkCol.nullPct < 80) {
        const distinct = Math.max(1, Math.min(fkCol.distinct, label.distinct || fkCol.distinct));
        if (distinct >= 2)
          out.push({
            dim: { id: `d:${r.key}.${label.name}`, label: dimLabel(r, label), table: { schema: r.schema, table: r.name }, col: label.name, distinct, text: typeFamily(label.dataType) === 'text' },
            joins: nextPath,
            alias,
            viaJoin: true,
            score: scoreBase + cardScore(distinct) + Math.round((j.confidence - 80) / 4) - (fkCol.nullPct > 30 ? 10 : 0),
          });
      }
      // Low-cardinality categories on the referenced table ("product → category")
      for (const c of r.columns) {
        if (c.role !== 'dimension' || c.distinct < 2 || c.distinct > 40 || !DIM_NAME.test(c.name) || CODE_LIKE.test(c.name) || /(updatedby|updated_by|created_?by|modified_?by|^user)/i.test(c.name) || c.name === label?.name) continue;
        out.push({
          dim: { id: `d:${r.key}.${c.name}`, label: dimLabel(r, c), table: { schema: r.schema, table: r.name }, col: c.name, distinct: c.distinct, text: typeFamily(c.dataType) === 'text' },
          joins: nextPath,
          alias,
          viaJoin: true,
          score: scoreBase - 6 + cardScore(c.distinct) + (DIM_NAME.test(c.name) ? 6 : 0),
        });
      }
      if (depth < 2) step(alias, r, depth + 1, nextPath, scoreBase - 12);
    }
  };
  step('t0', t, 1, [], 62);
  // de-duplicate the same physical dimension (shortest path wins)
  const seen = new Map<string, DimPath>();
  for (const p of out) {
    const prev = seen.get(p.dim.id);
    if (!prev || p.score > prev.score) seen.set(p.dim.id, p);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/** "tblecumaster" + "ecu_name" → "Ecu name"; "tbldocument" + "name" → "Document"; + "category" → "Document category". */
export function dimLabel(t: TableInfo, c: ColumnInfo) {
  if (c.label) return c.label;
  const table = t.name;
  const col = c.name;
  const ent = t.label || humanize(stem(table)) || entityName(table);
  if (/^(name|title|label|description)$/i.test(col)) return ent;
  const st = stem(table).replace(/[^a-z]/g, '');
  if (st && col.toLowerCase().replace(/[^a-z]/g, '').startsWith(st)) return humanize(col);
  return `${ent} ${humanize(col).toLowerCase()}`;
}

const cardScore = (d: number) => (d <= 1 ? -40 : d <= 3 ? 4 : d <= 12 ? 14 : d <= 30 ? 10 : d <= 60 ? 2 : -10);

// ───────────────────────── Suggestions ─────────────────────────

export function buildSuggestions(tables: TableInfo[], joins: JoinRec[], kpis: KpiRec[], correlations: Map<string, { a: string; b: string; r: number }[]>): Suggestion[] {
  const byKey = new Map(tables.map((t) => [t.key, t]));
  const out: Suggestion[] = [];
  let n = 0;
  const id = () => `s${++n}`;
  const ranked = tables.filter((t) => t.kind !== 'empty' && t.kind !== 'bridge' && t.rowCount > 0).sort((a, b) => b.importance - a.importance).slice(0, 25);

  for (const t of ranked) {
    const ref = { schema: t.schema, table: t.name };
    const imp = t.importance;
    const tk = kpis.filter((k) => k.table === t.key);
    const countKpi = tk.find((k) => k.category === 'volume');
    const mainKpi = tk.find((k) => k.category !== 'volume' && k.category !== 'rate' && k.category !== 'measure' && k.score >= 55) ?? countKpi ?? tk[0] ?? fallbackCount(t);
    const time = t.timeColumn ? { alias: 't0', col: t.timeColumn } : undefined;
    const dims = dimensionsFor(t, byKey, joins);
    const entity = `${tableLabel(t).toLowerCase()} records`;
    const base = { table: t.key };
    const timeIsAudit = t.columns.find((c) => c.name === t.timeColumn)?.role === 'auditTime';

    // KPI cards (with sparkline when the table has a time column)
    for (const k of tk.slice(0, 3)) {
      // Sparklines only for additive KPIs: summing per-bucket averages or rates would be wrong
      const additive = k.agg.kind === 'agg' && (k.agg.fn === 'sum' || k.agg.fn === 'count');
      const spark = time && additive ? time : undefined;
      out.push({
        ...base,
        id: id(),
        kind: 'kpi',
        title: k.name,
        description: k.reason,
        viz: 'kpi',
        tables: [t.key],
        joinIds: [],
        score: clamp(k.score * 0.75 + imp * 0.25),
        recommended: false,
        spec: { base: ref, joins: [], select: spark ? [{ kind: 'time', alias: 't0', col: spark.col, as: 'time' }, k.agg] : [k.agg], time, group: !!spark, orderBy: spark ? [{ as: 'time', dir: 'asc' }] : undefined },
        fields: { value: 'value', category: spark ? 'time' : undefined },
        unit: k.unit,
        format: k.format,
        kpiId: k.id,
      });
    }

    // Trend over time
    if (time) {
      const k = mainKpi;
      out.push({
        ...base,
        id: id(),
        kind: 'trend',
        title: `${k.name} over time`,
        description: `${k.name} by ${humanize(t.columns.find((c) => c.name === time.col)?.label || time.col).toLowerCase()}${timeIsAudit ? ' (last-updated time; no creation date found)' : ''}`,
        viz: 'line',
        tables: [t.key],
        joinIds: [],
        score: clamp(58 + imp * 0.35 - (timeIsAudit ? 12 : 0)),
        recommended: false,
        spec: { base: ref, joins: [], select: [{ kind: 'time', alias: 't0', col: time.col, as: 'time' }, { ...k.agg, as: 'value' } as SelectItem], time, group: true, orderBy: [{ as: 'time', dir: 'asc' }] },
        fields: { category: 'time', value: 'value' },
        unit: k.unit,
        format: k.format,
        kpiId: k.id,
      });
      const stackDim = dims.find((d) => d.dim.distinct >= 2 && d.dim.distinct <= 8 && d.score >= 55);
      if (stackDim) {
        out.push({
          ...base,
          id: id(),
          kind: 'trendBy',
          title: `${k.name} over time by ${stackDim.dim.label.toLowerCase()}`,
          description: `Stacked trend split by ${stackDim.dim.label}${stackDim.viaJoin ? ` (joined from ${stackDim.dim.table.table})` : ''}`,
          viz: 'area',
          tables: [t.key, ...stackDim.joins.map((j) => tkey(j.table.schema, j.table.table))],
          joinIds: stackDim.joins.map((j) => j.joinId),
          score: clamp(48 + imp * 0.3 + (stackDim.score - 60) * 0.3),
          recommended: false,
          spec: {
            base: ref,
            joins: stackDim.joins,
            select: [{ kind: 'time', alias: 't0', col: time.col, as: 'time' }, { kind: 'col', alias: stackDim.alias, col: stackDim.dim.col, as: 'series' }, { ...k.agg, as: 'value' } as SelectItem],
            time,
            notNull: [{ alias: stackDim.alias, col: stackDim.dim.col, text: stackDim.dim.text }],
            group: true,
            orderBy: [{ as: 'time', dir: 'asc' }],
          },
          fields: { category: 'time', value: 'value', series: 'series' },
          unit: k.unit,
          format: k.format,
          kpiId: k.id,
          dimension: stackDim.dim,
        });
      }
    }

    // Breakdowns by own and joined dimensions
    for (const d of dims.slice(0, 5)) {
      const k = mainKpi;
      const pie = d.dim.distinct <= 6 && !d.viaJoin;
      out.push({
        ...base,
        id: id(),
        kind: pie ? 'share' : 'breakdown',
        title: `${k.name} by ${d.dim.label.toLowerCase()}`,
        description: d.viaJoin
          ? `Joins ${t.name} → ${d.joins.map((j) => j.table.table).join(' → ')} so the chart shows ${d.dim.label.toLowerCase()} instead of ${d.joins[0].fromColumn}`
          : `${d.dim.distinct} ${humanize(d.dim.col).toLowerCase()} values`,
        viz: pie ? 'pie' : 'bar',
        tables: [t.key, ...d.joins.map((j) => tkey(j.table.schema, j.table.table))],
        joinIds: d.joins.map((j) => j.joinId),
        score: clamp(40 + imp * 0.3 + (d.score - 55) * 0.6 + (d.viaJoin ? 6 : 0)),
        recommended: false,
        spec: {
          base: ref,
          joins: d.joins,
          select: [{ kind: 'col', alias: d.alias, col: d.dim.col, as: 'label' }, { ...k.agg, as: 'value' } as SelectItem],
          time,
          notNull: [{ alias: d.alias, col: d.dim.col, text: d.dim.text }],
          group: true,
          orderBy: [{ as: 'value', dir: 'desc' }],
          limit: 25,
        },
        fields: { category: 'label', value: 'value' },
        unit: k.unit,
        format: k.format,
        kpiId: k.id,
        dimension: d.dim,
      });
    }

    // Failures by a dimension, for tables with an outcome column (result / status)
    const outcome = t.columns.find(isOutcomeColumn);
    if (outcome) {
      const good = outcomeValues(outcome);
      const d = dims.find((x) => x.dim.col !== outcome.name && x.dim.distinct >= 2);
      if (d) {
        out.push({
          ...base,
          id: id(),
          kind: 'failures',
          title: `Unsuccessful ${colLabel(outcome).toLowerCase()} by ${d.dim.label.toLowerCase()}`,
          description: `Rows where ${outcome.name} is not ${good.join('/')}, grouped by ${d.dim.label}`,
          viz: 'bar',
          tables: [t.key, ...d.joins.map((j) => tkey(j.table.schema, j.table.table))],
          joinIds: d.joins.map((j) => j.joinId),
          score: clamp(62 + imp * 0.3),
          recommended: false,
          spec: {
            base: ref,
            joins: d.joins,
            select: [{ kind: 'col', alias: d.alias, col: d.dim.col, as: 'label' }, { kind: 'countWhere', alias: 't0', col: outcome.name, values: good, negate: true, as: 'failures' }],
            time,
            notNull: [{ alias: d.alias, col: d.dim.col, text: d.dim.text }],
            group: true,
            orderBy: [{ as: 'failures', dir: 'desc' }],
            limit: 25,
          },
          fields: { category: 'label', value: 'failures' },
          unit: 'short',
          format: 'N0',
          dimension: d.dim,
        });
      }
    }

    // Cross-tab of the two best dimensions
    const d1 = dims[0];
    const d2 = dims.find((d) => d !== d1 && d.dim.distinct <= 15 && d.dim.id !== d1?.dim.id);
    if (d1 && d2 && d1.dim.distinct <= 40) {
      const k = countKpi ?? mainKpi;
      const joinSteps = mergeJoins(d1.joins, d2.joins);
      out.push({
        ...base,
        id: id(),
        kind: 'heatmap',
        title: `${d1.dim.label} × ${d2.dim.label.toLowerCase()}`,
        description: `${k.name} for each combination (matrix in reports)`,
        viz: 'heatmap',
        tables: [...new Set([t.key, ...joinSteps.map((j) => tkey(j.table.schema, j.table.table))])],
        joinIds: joinSteps.map((j) => j.joinId),
        score: clamp(38 + imp * 0.3 + (d1.score + d2.score - 110) * 0.2),
        recommended: false,
        spec: {
          base: ref,
          joins: joinSteps,
          select: [{ kind: 'col', alias: d2.alias, col: d2.dim.col, as: 'x' }, { kind: 'col', alias: d1.alias, col: d1.dim.col, as: 'y' }, { ...k.agg, as: 'value' } as SelectItem],
          time,
          notNull: [{ alias: d1.alias, col: d1.dim.col, text: d1.dim.text }, { alias: d2.alias, col: d2.dim.col, text: d2.dim.text }],
          group: true,
          orderBy: [{ as: 'value', dir: 'desc' }],
          limit: 600,
        },
        fields: { x: 'x', y: 'y', value: 'value', xLabel: d2.dim.label, yLabel: d1.dim.label },
        unit: k.unit,
        format: k.format,
        kpiId: k.id,
        dimension: d1.dim,
      });
    }

    // Correlated measures
    for (const cr of (correlations.get(t.key) ?? []).slice(0, 1)) {
      out.push({
        ...base,
        id: id(),
        kind: 'relationship',
        title: `${humanize(cr.a)} vs ${humanize(cr.b).toLowerCase()}`,
        description: `Correlation r = ${cr.r.toFixed(2)} in the sample`,
        viz: 'scatter',
        tables: [t.key],
        joinIds: [],
        score: clamp(35 + Math.abs(cr.r) * 30 + imp * 0.2),
        recommended: false,
        spec: { base: ref, joins: [], select: [{ kind: 'col', alias: 't0', col: cr.b, as: cr.b }, { kind: 'col', alias: 't0', col: cr.a, as: cr.a }], time, group: false, limit: 2000 },
        fields: { x: cr.b, y: cr.a },
        unit: 'short',
      });
    }

    // Detail table with ids replaced by joined names
    const labelDims = dims.filter((d) => d.viaJoin && d.joins.length === 1 && byKey.get(tkey(d.dim.table.schema, d.dim.table.table))?.labelColumn === d.dim.col).slice(0, 4);
    const own = t.columns.filter((c) => ['dimension', 'measure', 'label', 'time'].includes(c.role) && c.nullPct < 90 && !/updatedby/i.test(c.name)).slice(0, 8);
    if (own.length + labelDims.length >= 2) {
      const sel: SelectItem[] = [];
      if (t.timeColumn && !own.some((c) => c.name === t.timeColumn)) sel.push({ kind: 'col', alias: 't0', col: t.timeColumn, as: t.timeColumn });
      for (const c of own) sel.push({ kind: 'col', alias: 't0', col: c.name, as: c.name });
      for (const d of labelDims) sel.push({ kind: 'col', alias: d.alias, col: d.dim.col, as: uniqueAs(sel, safeAs(`${stem(d.dim.table.table)}_${d.dim.col}`)) });
      out.push({
        ...base,
        id: id(),
        kind: 'detail',
        title: t.timeColumn ? `Latest ${entity}` : `${tableLabel(t)} list`,
        description: labelDims.length ? `Rows with ${labelDims.map((d) => d.dim.label).join(', ')} looked up from related tables` : `Key columns of ${t.name}`,
        viz: 'table',
        tables: [t.key, ...labelDims.map((d) => tkey(d.dim.table.schema, d.dim.table.table))],
        joinIds: [...new Set(labelDims.flatMap((d) => d.joins.map((j) => j.joinId)))],
        score: clamp(36 + imp * 0.35 + labelDims.length * 4),
        recommended: false,
        spec: { base: ref, joins: labelDims.reduce<JoinStep[]>((acc, d) => mergeJoins(acc, d.joins), []), select: sel, time, group: false, orderBy: t.timeColumn ? [{ as: sel.find((s) => s.kind === 'col' && s.col === t.timeColumn)!.as, dir: 'desc' }] : undefined, limit: 200 },
        fields: {},
        unit: 'short',
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function fallbackCount(t: TableInfo): KpiRec {
  return { id: `k:${t.key}:count`, name: `${tableLabel(t)} records`, table: t.key, category: 'volume', agg: { kind: 'agg', fn: 'count', as: 'value' }, unit: 'short', format: 'N0', score: 40, reason: 'Row count' };
}

export function mergeJoins(a: JoinStep[], b: JoinStep[]) {
  const out = [...a];
  const aliases = new Set(a.map((j) => j.alias));
  for (const j of b) if (!aliases.has(j.alias)) out.push(j);
  return out;
}

const safeAs = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
const uniqueAs = (sel: SelectItem[], as: string) => {
  let a = as;
  let i = 2;
  while (sel.some((s) => s.as === a)) a = `${as}_${i++}`;
  return a;
};
const clamp = (n: number) => Math.max(1, Math.min(99, Math.round(n)));

/** Greedy, balanced pick for the one-click dashboard: KPIs, a trend, joined breakdowns, a matrix, details. */
export function pickRecommended(sugs: Suggestion[], max = 12) {
  const usable = sugs.filter((s) => !s.preview || s.preview.rows.length > 0);
  const chosen: Suggestion[] = [];
  // Same title from another table is usually a copy (view over a table, *_raw copies): keep one
  const add = (s?: Suggestion) => s && !chosen.includes(s) && !chosen.some((c) => c.title === s.title) && chosen.length < max && chosen.push(s);
  const mainTable = usable.find((s) => s.kind !== 'kpi')?.table;
  const kpis = usable.filter((s) => s.kind === 'kpi');
  for (const k of [...kpis.filter((k) => k.table === mainTable).slice(0, 2), ...kpis.filter((k) => k.table !== mainTable)].slice(0, 4)) add(k);
  add(usable.find((s) => s.kind === 'trend'));
  add(usable.find((s) => s.kind === 'trendBy'));
  const breakdowns = usable.filter((s) => s.kind === 'breakdown' || s.kind === 'share' || s.kind === 'failures');
  add(breakdowns.find((s) => s.joinIds.length > 0));
  for (const b of breakdowns.slice(0, 4)) if (chosen.filter((c) => breakdowns.includes(c)).length < 3) add(b);
  add(usable.find((s) => s.kind === 'heatmap'));
  // second table: its trend or top breakdown
  const second = usable.find((s) => s.table !== mainTable && (s.kind === 'trend' || s.kind === 'breakdown'));
  add(second);
  add(usable.find((s) => s.kind === 'detail' && s.table === mainTable) ?? usable.find((s) => s.kind === 'detail'));
  for (const s of chosen) s.recommended = true;
  return chosen;
}

// ───────────────────────── Insights ─────────────────────────

export function correlationsFor(t: TableInfo, sample: Row[]) {
  const ms = t.columns.filter((c) => c.role === 'measure' && c.distinct > 5).slice(0, 8);
  const out: { a: string; b: string; r: number }[] = [];
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++) {
      const x: number[] = [];
      const y: number[] = [];
      for (const r of sample) {
        const a = toNumber(r[ms[i].name]);
        const b = toNumber(r[ms[j].name]);
        if (a !== null && b !== null) {
          x.push(a);
          y.push(b);
        }
      }
      if (x.length < 20) continue;
      const r = pearson(x, y);
      if (Math.abs(r) >= 0.6 && Math.abs(r) < 0.999) out.push({ a: ms[i].name, b: ms[j].name, r: Math.round(r * 1000) / 1000 });
    }
  return out.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
}

const fmtNum = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2));
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/**
 * Trend, growth, seasonality and outliers for one KPI time series (buckets oldest → newest).
 * The last bucket is treated as possibly incomplete when it ends after `now`.
 */
export function seriesInsights(table: string, kpiName: string, unit: 'day' | 'week' | 'month', points: { t: string; v: number }[], now = Date.now()): Insight[] {
  const out: Insight[] = [];
  let pts = points.filter((p) => Number.isFinite(p.v));
  if (pts.length < 4) return out;
  const unitMs = unit === 'day' ? 864e5 : unit === 'week' ? 6048e5 : 2592e6;
  const last = pts[pts.length - 1];
  if (Date.parse(last.t) + unitMs > now) pts = pts.slice(0, -1);
  if (pts.length < 4) return out;
  const y = pts.map((p) => p.v);
  // Fit the trend without outliers, so one spike doesn't hide (or fake) a trend
  const med0 = median(y);
  const s0 = mad(y, med0);
  const keep = y.map((v) => !s0 || Math.abs((v - med0) / s0) < 3.5);
  const x = y.map((_v, i) => i).filter((_v, i) => keep[i]);
  const yc = y.filter((_v, i) => keep[i]);
  const my = mean(yc);
  const mx = mean(x);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < yc.length; i++) {
    sxy += (x[i] - mx) * (yc[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const r = yc.length > 2 ? pearson(x, yc) : 0;
  const r2 = r * r;
  const rel = my ? slope / Math.abs(my) : 0;
  const series = points.slice(-60);
  const id = (k: string) => `i:${table}:${kpiName}:${k}`;

  // 1. Trend
  if (r2 >= 0.3 && Math.abs(rel) >= 0.01) {
    out.push({
      id: id('trend'),
      kind: 'trend',
      title: `${kpiName} is trending ${slope > 0 ? 'up' : 'down'}`,
      detail: `About ${pct(rel)} per ${unit} on average over ${pts.length} ${unit}s (R² ${r2.toFixed(2)}).`,
      score: Math.round(55 + r2 * 30 + Math.min(15, Math.abs(rel) * 100)),
      table,
      direction: slope > 0 ? 'up' : 'down',
      series,
    });
  } else {
    out.push({ id: id('trend'), kind: 'trend', title: `${kpiName} has no clear trend`, detail: `Fluctuates around ${fmtNum(my)} per ${unit} (R² ${r2.toFixed(2)}).`, score: 30, table, direction: 'flat', series });
  }

  // 2. Growth: latest complete period vs the one before, and last 3 vs previous 3
  const a = y[y.length - 1];
  const b = y[y.length - 2];
  const g = b ? (a - b) / Math.abs(b) : 0;
  if (b && Math.abs(g) >= 0.02) {
    out.push({
      id: id('growth'),
      kind: 'growth',
      title: `${kpiName} ${g >= 0 ? 'grew' : 'fell'} ${pct(g)} in the latest ${unit}`,
      detail: `${fmtNum(a)} in ${labelOf(pts[pts.length - 1].t, unit)} vs ${fmtNum(b)} in ${labelOf(pts[pts.length - 2].t, unit)}.${y.length >= 6 ? ` Last 3 ${unit}s vs previous 3: ${pct((sum(y.slice(-3)) - sum(y.slice(-6, -3))) / (Math.abs(sum(y.slice(-6, -3))) || 1))}.` : ''}`,
      score: Math.round(40 + Math.min(40, Math.abs(g) * 60) - (Math.max(Math.abs(a), Math.abs(b)) < 10 ? 25 : 0)),
      table,
      direction: g > 0.02 ? 'up' : g < -0.02 ? 'down' : 'flat',
    });
  }

  // 3. Seasonality via autocorrelation at the natural lag
  const lag = unit === 'day' ? 7 : unit === 'month' ? 12 : 4;
  if (y.length >= lag * 2 + 2) {
    const ac = autocorr(y, lag);
    if (ac >= 0.4)
      out.push({
        id: id('season'),
        kind: 'seasonality',
        title: `${kpiName} repeats every ${lag} ${unit}s`,
        detail: `Autocorrelation at lag ${lag} is ${ac.toFixed(2)}, a ${unit === 'day' ? 'weekly' : unit === 'month' ? 'yearly' : 'monthly'} pattern. Forecast panels will model it.`,
        score: Math.round(45 + ac * 40),
        table,
      });
  }

  // 4. Outliers (robust z-score on the series)
  const med = median(y);
  const s = mad(y, med);
  if (s > 0) {
    const odd = pts.map((p, i) => ({ p, z: (y[i] - med) / s })).filter((o) => Math.abs(o.z) >= 3.5);
    if (odd.length)
      out.push({
        id: id('outlier'),
        kind: 'outlier',
        title: `${odd.length} unusual ${unit}${odd.length > 1 ? 's' : ''} for ${kpiName.toLowerCase()}`,
        detail: odd
          .sort((p, q) => Math.abs(q.z) - Math.abs(p.z))
          .slice(0, 3)
          .map((o) => `${labelOf(o.p.t, unit)}: ${fmtNum(o.p.v)} (${o.z > 0 ? 'high' : 'low'}, typical ${fmtNum(med)})`)
          .join('; '),
        score: Math.round(50 + Math.min(35, odd.length * 8) - (Math.max(...odd.map((o) => Math.abs(o.p.v))) < 10 ? 20 : 0)),
        table,
        series,
      });
  }
  return out;
}

export function contributorInsight(table: string, kpiName: string, dimLabel: string, rows: { label: unknown; value: unknown }[]): Insight | null {
  const vals = rows.filter((r) => r.label !== null && r.label !== undefined && String(r.label).trim() !== '').map((r) => ({ label: String(r.label), v: toNumber(r.value) ?? 0 })).filter((r) => r.v > 0);
  if (vals.length < 5) return null;
  const total = sum(vals.map((v) => v.v));
  if (!total) return null;
  vals.sort((a, b) => b.v - a.v);
  const top = vals.slice(0, 3);
  const share = sum(top.map((t) => t.v)) / total;
  return {
    id: `i:${table}:${kpiName}:${dimLabel}:top`,
    kind: 'contributors',
    title: `Top ${top.length} ${dimLabel.toLowerCase()} values make up ${(share * 100).toFixed(0)}% of ${kpiName.toLowerCase()}`,
    detail: top.map((t) => `${t.label} ${(100 * (t.v / total)).toFixed(1)}%`).join(' · ') + ` (of ${vals.length}${rows.length >= 25 ? '+' : ''})`,
    score: Math.round(40 + share * 40 + (vals.length >= 8 && share > 0.6 ? 10 : 0)),
    table,
  };
}

function autocorr(y: number[], lag: number) {
  const m = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < y.length; i++) {
    den += (y[i] - m) ** 2;
    if (i >= lag) num += (y[i] - m) * (y[i - lag] - m);
  }
  return den ? num / den : 0;
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function labelOf(t: string, unit: 'day' | 'week' | 'month') {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return unit === 'month' ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : d.toISOString().slice(0, 10);
}

export function chooseUnit(range?: { from: string; to: string }): 'day' | 'week' | 'month' {
  if (!range) return 'month';
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 864e5;
  return days <= 90 ? 'day' : days <= 540 ? 'week' : 'month';
}

// ───────────────────────── Quality score ─────────────────────────

export interface QualityScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  parts: { name: string; score: number; max: number; tip?: string }[];
}

export function qualityScore(chosen: Suggestion[], ctx: { anyTime: boolean; anyJoins: boolean; filter: boolean; target: 'dashboard' | 'report' }): QualityScore {
  const has = (...k: SuggestionKind[]) => chosen.some((s) => k.includes(s.kind));
  const parts: QualityScore['parts'] = [];
  // Coverage
  let cov = 0;
  const covTips: string[] = [];
  if (has('kpi')) cov += 8;
  else covTips.push('add headline KPIs');
  if (!ctx.anyTime || has('trend', 'trendBy')) cov += 8;
  else covTips.push('add a trend over time');
  if (has('breakdown', 'share', 'failures', 'heatmap')) cov += 8;
  else covTips.push('add a breakdown by a dimension');
  if (has('detail')) cov += 6;
  else covTips.push('add a detail table');
  parts.push({ name: 'Coverage (KPIs, trend, breakdown, detail)', score: cov, max: 30, tip: covTips.length ? `To improve: ${covTips.join(', ')}.` : undefined });
  // Relevance
  const rel = chosen.length ? Math.round((mean(chosen.map((s) => s.score)) / 100) * 25) : 0;
  parts.push({ name: 'Relevance of the chosen metrics', score: rel, max: 25, tip: rel < 15 ? 'Pick higher-ranked suggestions (sorted by relevance).' : undefined });
  // Diversity
  const types = new Set(chosen.map((s) => s.viz)).size;
  const dupTitles = chosen.length - new Set(chosen.map((s) => s.title)).size;
  const div = Math.max(0, [0, 5, 9, 12, 15][Math.min(types, 4)] - dupTitles * 3);
  parts.push({ name: 'Visual variety', score: div, max: 15, tip: types < 3 ? 'Mix chart types (KPI, line, bar, table).' : dupTitles ? 'Remove duplicate panels.' : undefined });
  // Multi-table
  const joined = chosen.some((s) => s.joinIds.length > 0);
  const mt = !ctx.anyJoins ? 10 : joined ? 10 : 3;
  parts.push({ name: 'Combines related tables', score: mt, max: 10, tip: !joined && ctx.anyJoins ? 'Add a breakdown that joins a related table (shows names instead of ids).' : undefined });
  // Interactivity
  const inter = (ctx.filter ? 5 : 0) + (ctx.anyTime && chosen.some((s) => s.spec.time) ? 3 : ctx.anyTime ? 0 : 3) + (chosen.some((s) => s.dimension) ? 2 : 0);
  parts.push({ name: ctx.target === 'dashboard' ? 'Interactivity (filter, time range, drill-down)' : 'Parameters (filter, date range)', score: inter, max: 10, tip: !ctx.filter ? 'Choose a filter so viewers can slice every panel.' : undefined });
  // Size
  const nC = chosen.length;
  const size = nC === 0 ? 0 : nC < 3 ? 4 : nC <= 14 ? 10 : nC <= 20 ? 6 : 3;
  parts.push({ name: 'Size', score: size, max: 10, tip: nC < 3 ? 'A dashboard usually needs at least 4 panels.' : nC > 14 ? 'Large dashboards load slowly; consider splitting.' : undefined });
  const score = parts.reduce((s, p) => s + p.score, 0);
  return { score, grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D', parts };
}
