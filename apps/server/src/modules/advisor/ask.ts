import {
  BAD,
  CODE_LIKE,
  GOOD,
  chooseUnit,
  colLabel,
  dimLabel,
  humanize,
  isOutcomeColumn,
  mergeJoins,
  outcomeValues,
  pluralize,
  similarity,
  stem,
  tableLabel,
  tkey,
  typeFamily,
  type ColumnInfo,
  type DimensionRef,
  type JoinRec,
  type KpiRec,
  type Suggestion,
  type SuggestionKind,
  type TableInfo,
} from './engine';
import type { JoinStep, QuerySpec, SelectItem, TableKeyRef, TimeUnit, WhereCond } from './sql';

/**
 * Plain-language questions → a query spec, using only the analysed model (no external service).
 * "unsuccessful flashes by ecu name last 30 days" → count of tblflash rows where result is not a
 * success value, grouped by tblecu.ecu_name (joined), over the last 30 days.
 */

export interface AskContext {
  tables: TableInfo[];
  joins: JoinRec[];
  kpis: KpiRec[];
  now?: number;
  /** force the base table (from a "did you mean" alternative) */
  table?: string;
}

/** Looks up which phrases are actual values of a column (lower-cased matches). */
export type ValueLookup = (target: { table: TableKeyRef; col: string }, phrases: string[]) => Promise<string[]>;

export interface Understood {
  kind: 'table' | 'measure' | 'by' | 'time' | 'filter' | 'sort';
  text: string;
}

export interface AskResult {
  suggestion: Omit<Suggestion, 'id'>;
  understood: Understood[];
  ignored: string[];
  confidence: number;
  alternatives: { table: string; label: string }[];
  timeUnit?: TimeUnit;
  /** things the user should know about the answer ("no rows in this range; data ends …") */
  notes: string[];
}

export class AskError extends Error {
  constructor(
    message: string,
    public hints: string[],
  ) {
    super(message);
  }
}

// ───────────────────────── Words and matching ─────────────────────────

const STOP = new Set(
  'show me give list display get find what which who whose how is are was were be been the a an of for in on at to and or with all each every chart graph plot table please data row rows record records entry entries value values do does did i we our my has have had there that this these those it its as from vs versus can could would you tell see view number count much many total sum'.split(
    ' ',
  ),
);
// "count", "number", "total", "sum" are in STOP only for subject matching; aggregations are read first.

function singular(w: string) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

export function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^(tbl|tb)(?=[a-z])/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

/** 0–1: how well a phrase names something ("ecu name" ~ "ecu_name" = 1, "flash" ~ "tblflash" = 1). */
export function matchScore(phrase: string[], name: string): number {
  if (!phrase.length || !name) return 0;
  const nw = words(name);
  if (!nw.length) return 0;
  const pj = phrase.join('');
  const nj = nw.join('');
  if (pj === nj) return 1;
  const st = stem(name.replace(/\s+/g, '_'));
  if (st && pj === st.replace(/[^a-z0-9]/g, '')) return 1;
  if (phrase.every((w) => nw.includes(w))) return nw.length === phrase.length ? 0.95 : 0.8 + 0.1 * (phrase.length / nw.length);
  // Compound names: "flash" ~ "flashsessionlog" (shorter names win)
  let part = 0;
  for (const target of [nj, st?.replace(/[^a-z0-9]/g, '')]) {
    if (!target || pj.length < 4 || target.length <= pj.length) continue;
    if (target.startsWith(pj)) part = Math.max(part, 0.78 + 0.12 * (pj.length / target.length));
    else if (pj.length >= 5 && target.includes(pj)) part = Math.max(part, 0.74 + 0.1 * (pj.length / target.length));
  }
  // "faultcode" vs "fault code", plural/singular, small typos
  return Math.max(part, similarity(pj, nj) * 0.95, st ? similarity(pj, st) * 0.95 : 0);
}

const best = (phrase: string[], names: (string | undefined)[]) => Math.max(0, ...names.filter((n): n is string => !!n).map((n) => matchScore(phrase, n)));

function ngrams(tokens: string[], max = 3) {
  const out: { start: number; len: number; words: string[] }[] = [];
  for (let len = Math.min(max, tokens.length); len >= 1; len--) for (let i = 0; i + len <= tokens.length; i++) out.push({ start: i, len, words: tokens.slice(i, i + len) });
  return out;
}

// ───────────────────────── Reachable tables ─────────────────────────

interface Reach {
  alias: string;
  info: TableInfo;
  joins: JoinStep[];
}

function reachable(t: TableInfo, byKey: Map<string, TableInfo>, joins: JoinRec[], maxDepth = 2): Reach[] {
  const out: Reach[] = [{ alias: 't0', info: t, joins: [] }];
  let n = 0;
  const walk = (from: Reach, depth: number) => {
    for (const j of joins) {
      if (tkey(j.left.schema, j.left.table) !== from.info.key) continue;
      const r = byKey.get(tkey(j.right.schema, j.right.table));
      if (!r || !r.rowCount || r.key === t.key || from.joins.some((p) => tkey(p.table.schema, p.table.table) === r.key)) continue;
      const alias = `q${++n}`;
      const step: JoinStep = { fromAlias: from.alias, fromColumn: j.left.column, table: { schema: r.schema, table: r.name }, alias, column: j.right.column, joinId: j.id };
      const reach: Reach = { alias, info: r, joins: [...from.joins, step] };
      out.push(reach);
      if (depth < maxDepth) walk(reach, depth + 1);
    }
  };
  walk(out[0], 1);
  return out;
}

interface ColRef {
  reach: Reach;
  col: ColumnInfo;
  score: number;
}

const GROUPABLE = new Set(['dimension', 'label', 'flag', 'text', 'identifier']);

function tableNames(t: TableInfo) {
  return [t.label, ...(t.synonyms ?? []), stem(t.name), t.name, tableLabel(t)];
}

function columnNames(r: Reach, c: ColumnInfo) {
  const own = [c.label, ...(c.synonyms ?? []), c.name, colLabel(c)];
  if (r.alias === 't0') return own;
  const t = r.info;
  const ent = [t.label, ...(t.synonyms ?? []), stem(t.name)].filter((x): x is string => !!x);
  const out: (string | undefined)[] = [...own, ...ent.map((e) => `${e} ${c.label ?? c.name}`)];
  // The label column stands for the table itself: "by ecu" → tblecu.ecu_name
  if (c.name === t.labelColumn) out.push(...ent, tableLabel(t));
  return out;
}

function findColumn(phrase: string[], reach: Reach[], accept: (c: ColumnInfo, r: Reach) => boolean): ColRef | undefined {
  let top: ColRef | undefined;
  for (const r of reach)
    for (const c of r.info.columns) {
      if (!accept(c, r)) continue;
      let s = best(phrase, columnNames(r, c));
      if (s < 0.75) continue;
      // prefer the base table, short paths, label columns and real dimensions
      s += (r.alias === 't0' ? 0.03 : 0) - r.joins.length * 0.01 + (c.name === r.info.labelColumn ? 0.02 : 0) + (c.role === 'dimension' || c.role === 'label' ? 0.01 : 0);
      if (!top || s > top.score) top = { reach: r, col: c, score: s };
    }
  return top;
}

// ───────────────────────── Phrase extraction ─────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const utcDate = (y: number, m: number, dd = 1) => new Date(Date.UTC(y, m, dd));

interface Parsed {
  range?: { from?: string; to?: string; relative?: string; text: string };
  grain?: TimeUnit | 'auto';
  top?: { n?: number; dir: 'asc' | 'desc'; text: string };
  rate?: 'good' | 'bad';
  outcome?: 'good' | 'bad';
  agg?: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'countDistinct';
  list: boolean;
  share: boolean;
  by: string[][];
  where: { col: string[]; value: string; negate: boolean }[];
  quoted: string[];
  rest: string[];
}

function cut(text: string, re: RegExp, fn: (m: RegExpExecArray) => void) {
  const m = re.exec(text);
  if (!m) return text;
  fn(m);
  return `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`;
}

export function parsePhrases(question: string, now = Date.now()): Parsed {
  const p: Parsed = { list: false, share: false, by: [], where: [], quoted: [], rest: [] };
  let text = ` ${question.replace(/[‘’“”]/g, '"')} `;
  // quoted values keep their case and spaces
  text = text.replace(/(^|\s)["']([^"']{1,80})["'](?=\s|$|[?.!,])/g, (_m, pre, v) => {
    p.quoted.push(String(v).trim());
    return `${pre} `;
  });
  text = ` ${text.toLowerCase().replace(/[?!,;()]/g, ' ').replace(/\s+/g, ' ')} `;
  const today = new Date(day(new Date(now)));

  // Date range
  const rel = (n: number, unit: string, label: string) => {
    const days = unit.startsWith('day') ? n : unit.startsWith('week') ? 7 * n : unit.startsWith('month') ? 30 * n : unit.startsWith('quarter') ? 91 * n : 365 * n;
    p.range = { from: day(addDays(today, -days + 1)), relative: `now-${days}d`, text: label };
  };
  text = cut(text, /\s(?:in |over |during |for )?(?:the )?(?:last|past|previous)\s+(\d{1,4})\s+(days?|weeks?|months?|quarters?|years?)\s/, (m) => rel(Number(m[1]), m[2], `Last ${m[1]} ${m[2]}`));
  if (!p.range)
    text = cut(text, /\s(?:in |during |for )?(this|last|previous)\s+(week|month|year)\s/, (m) => {
      const y = today.getUTCFullYear();
      const mo = today.getUTCMonth();
      const cur = m[1] === 'this';
      let from: Date;
      let to: Date;
      if (m[2] === 'year') [from, to] = cur ? [utcDate(y, 0), addDays(today, 1)] : [utcDate(y - 1, 0), utcDate(y, 0)];
      else if (m[2] === 'month') [from, to] = cur ? [utcDate(y, mo), addDays(today, 1)] : [utcDate(y, mo - 1), utcDate(y, mo)];
      else {
        const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
        [from, to] = cur ? [monday, addDays(today, 1)] : [addDays(monday, -7), monday];
      }
      p.range = { from: day(from), to: day(to), text: `${m[1] === 'this' ? 'This' : 'Last'} ${m[2]}` };
    });
  if (!p.range) text = cut(text, /\stoday\s/, () => (p.range = { from: day(today), to: day(addDays(today, 1)), text: 'Today' }));
  if (!p.range) text = cut(text, /\syesterday\s/, () => (p.range = { from: day(addDays(today, -1)), to: day(today), text: 'Yesterday' }));
  if (!p.range)
    text = cut(text, /\sbetween\s(\d{4}-\d{2}-\d{2})\s(?:and|to)\s(\d{4}-\d{2}-\d{2})\s/, (m) => (p.range = { from: m[1], to: day(addDays(new Date(m[2]), 1)), text: `${m[1]} – ${m[2]}` }));
  if (!p.range)
    text = cut(text, /\sfrom\s(\d{4}-\d{2}-\d{2})\s(?:to|until|till)\s(\d{4}-\d{2}-\d{2})\s/, (m) => (p.range = { from: m[1], to: day(addDays(new Date(m[2]), 1)), text: `${m[1]} – ${m[2]}` }));
  if (!p.range) text = cut(text, /\s(?:since|after|from)\s(\d{4}-\d{2}-\d{2})\s/, (m) => (p.range = { from: m[1], text: `Since ${m[1]}` }));
  if (!p.range)
    text = cut(text, /\s(?:in|during|for)?\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s(\d{4})\s/, (m) => {
      const mo = MONTHS.indexOf(m[1]);
      const y = Number(m[2]);
      p.range = { from: day(utcDate(y, mo)), to: day(utcDate(y, mo + 1)), text: `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${y}` };
    });
  if (!p.range) text = cut(text, /\s(?:since)\s((?:19|20)\d{2})\s/, (m) => (p.range = { from: `${m[1]}-01-01`, text: `Since ${m[1]}` }));
  if (!p.range)
    text = cut(text, /\s(?:in|during|for)?\s?((?:19|20)\d{2})\s/, (m) => (p.range = { from: `${m[1]}-01-01`, to: `${Number(m[1]) + 1}-01-01`, text: m[1] }));

  // Time grain
  const grains: [RegExp, TimeUnit | 'auto'][] = [
    [/\s(daily|per day|by day|each day|day by day|by date|per date|every day)\s/, 'day'],
    [/\s(weekly|per week|by week|each week|week by week|every week)\s/, 'week'],
    [/\s(monthly|per month|by month|each month|month by month|every month)\s/, 'month'],
    [/\s(over time|trends?|timeline|history|time series|evolution|growth)\s/, 'auto'],
  ];
  for (const [re, g] of grains) if (!p.grain) text = cut(text, re, () => (p.grain = g));

  // Top / bottom N
  text = cut(text, /\s(top|bottom|best|worst|highest|lowest|largest|smallest|most|least|fewest)\s(\d{1,3})\s/, (m) => {
    p.top = { n: Number(m[2]), dir: /bottom|worst|lowest|smallest|least|fewest/.test(m[1]) ? 'asc' : 'desc', text: `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}` };
  });
  if (!p.top) text = cut(text, /\s(top|bottom)\s/, (m) => (p.top = { n: 10, dir: m[1] === 'bottom' ? 'asc' : 'desc', text: m[1] === 'top' ? 'Top 10' : 'Bottom 10' }));
  if (!p.top) text = cut(text, /\s(?:the )?(most|least|fewest)\s/, (m) => (p.top = { dir: m[1] === 'most' ? 'desc' : 'asc', text: m[1] === 'most' ? 'Most first' : 'Least first' }));

  // Rates and outcomes
  text = cut(text, /\s(success|pass|completion|approval)\s?(rate|ratio|percentage|percent|%)\s/, () => (p.rate = 'good'));
  if (!p.rate) text = cut(text, /\s(failure|fail|error|rejection)\s?(rate|ratio|percentage|percent|%)\s/, () => (p.rate = 'bad'));
  if (!p.rate) text = cut(text, /\s(?:%|percent(?:age)?)\s(?:of\s)?(successful|passed|completed)\s/, () => (p.rate = 'good'));
  if (!p.rate) text = cut(text, /\s(?:%|percent(?:age)?)\s(?:of\s)?(failed|unsuccessful|failing)\s/, () => (p.rate = 'bad'));
  if (!p.rate) {
    const bad = /\s(failed|failing|unsuccessful|failures?|errors?|rejected|aborted)\s/.exec(text);
    const good = /\s(successful|succeeded|passed|completed|approved)\s/.exec(text);
    if (bad) p.outcome = 'bad';
    else if (good) p.outcome = 'good';
  }

  // Explicit filters: "where status is failed", "with region = north", "status not open"
  for (;;) {
    const before = text;
    text = cut(
      text,
      /\s(?:where|with|whose|having|and)\s([a-z0-9_ ]{1,40}?)\s(?:=|==|is not|isn't|!=|<>|is|equals|equal to|not)\s([a-z0-9_.\- ]{1,60}?)(?=\s(?:and|by|per|over|for|top|in|sorted|order)\s|\s*$)/,
      (m) => p.where.push({ col: words(m[1]).filter((w) => !STOP.has(w)), value: m[2].trim(), negate: /is not|isn't|!=|<>|\snot\s/.test(m[0]) }),
    );
    if (text === before) break;
  }

  // Grouping: "by region and product", "per user", "for each ecu", "across channels"
  for (;;) {
    const before = text;
    text = cut(text, /\s(?:split by|grouped by|group by|broken down by|breakdown by|for each|for every|by|per|across|vs|versus)\s([a-z0-9_ ]{1,60}?)(?=\s(?:by|per|for|in|where|with|over|since|from|during|top|sorted|order|having|across)\s|\s*$)/, (m) => {
      for (const part of m[1].split(/\s(?:and|&|then)\s/)) {
        const w = words(part).filter((x) => !STOP.has(x));
        if (w.length) p.by.push(w);
      }
    });
    if (text === before) break;
  }

  // Aggregations
  if (/\s(how many|number of|count of|count|no of)\s/.test(text)) p.agg = 'count';
  if (/\s(distinct|unique|different)\s/.test(text)) p.agg = 'countDistinct';
  else if (/\s(average|avg|mean|typical)\s/.test(text)) p.agg = 'avg';
  else if (/\s(total|sum of|sum)\s/.test(text)) p.agg = p.agg ?? 'sum';
  else if (/\s(maximum|max|highest|largest|peak|longest|biggest)\s/.test(text)) p.agg = 'max';
  else if (/\s(minimum|min|lowest|smallest|shortest)\s/.test(text)) p.agg = 'min';
  text = text.replace(/\s(how many|number of|count of|no of|sum of|total|sum|count|distinct|unique|different|average|avg|mean|typical|maximum|max|highest|largest|peak|longest|biggest|minimum|min|lowest|smallest|shortest)(?=\s)/g, ' ');
  p.list = /\s(list|latest|recent|newest|last \d+ rows|details?|show all|rows|records of|entries)\s/.test(text) && !p.agg;
  p.share = /\s(share|split|proportion|distribution|breakdown|mix|percentage of)\s/.test(text);
  text = text.replace(/\s(list|latest|recent|newest|details?|show all|share|split|proportion|distribution|breakdown|mix)(?=\s)/g, ' ');

  p.rest = text.split(' ').filter((w) => w && !/^(failed|failing|unsuccessful|successful|succeeded|passed|completed|approved|rejected|aborted)$/.test(w));
  return p;
}

// ───────────────────────── Interpretation ─────────────────────────

const AGG_WORD: Record<string, string> = { sum: 'Total', avg: 'Average', max: 'Maximum', min: 'Minimum', count: 'Number of', countDistinct: 'Distinct' };

type Plan = {
  t: TableInfo;
  score: number;
  entity?: { start: number; len: number; score: number };
  measure?: { col: ColumnInfo; score: number; start: number; len: number };
  kpi?: KpiRec;
  reach: Reach[];
  dims: ColRef[];
  outcome?: ColumnInfo;
  distinct?: { alias: string; col: string; label: string; score: number; start: number; len: number };
};

export async function interpret(question: string, ctx: AskContext, lookup?: ValueLookup): Promise<AskResult> {
  const byKey = new Map(ctx.tables.map((t) => [t.key, t]));
  const candidates = ctx.tables.filter((t) => t.rowCount > 0 && t.kind !== 'empty' && (!ctx.table || t.key === ctx.table));
  if (!candidates.length) throw new AskError('No tables with data to answer from.', []);
  let p = parsePhrases(question, ctx.now);
  let { plans, subjectRaw, subject } = planAll(p, candidates, byKey, ctx);
  // "top 5 users by number of sessions": the grouping and the measured thing are swapped
  if (p.by.length === 1 && subjectRaw.length) {
    const swapped: Parsed = { ...p, by: [subject.filter((w) => !STOP.has(w))], rest: p.by[0] };
    const alt = planAll(swapped, candidates, byKey, ctx);
    if (alt.plans[0] && alt.plans[0].dims.length === 1 && (!plans[0] || alt.plans[0].score > plans[0].score + 0.1)) ({ plans, subjectRaw, subject } = { ...alt, plans: alt.plans }), (p = swapped);
  }
  return finish(question, p, plans, subjectRaw, subject, byKey, ctx, lookup);
}

function planAll(p: Parsed, candidates: TableInfo[], byKey: Map<string, TableInfo>, ctx: AskContext) {
  const subjectRaw = p.rest.filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
  const subject = subjectRaw.map(singular);
  // Score each table as the base of the question
  const plans: Plan[] = [];
  for (const t of candidates) {
    const reach = reachable(t, byKey, ctx.joins);
    let entity: Plan['entity'];
    let measure: Plan['measure'];
    let kpi: KpiRec | undefined;
    for (const g of ngrams(subject)) {
      const s = best(g.words, tableNames(t));
      if (s >= 0.75 && (!entity || s > entity.score)) entity = { start: g.start, len: g.len, score: s };
    }
    const numeric = t.columns.filter((c) => c.role === 'measure' || (c.kind === 'numeric' && !['primaryKey', 'foreignKey', 'identifier'].includes(c.role)));
    for (const g of ngrams(subject)) {
      if (entity && g.start < entity.start + entity.len && g.start + g.len > entity.start) continue;
      for (const c of numeric) {
        const s = best(g.words, [c.label, ...(c.synonyms ?? []), c.name, colLabel(c)]) + (c.role === 'measure' ? 0.02 : 0);
        if (s >= 0.78 && (!measure || s > measure.score)) measure = { col: c, score: s, start: g.start, len: g.len };
      }
    }
    // "unique customers": the counted thing is a joined table (count distinct keys) or a column of this one
    let distinct: Plan['distinct'];
    if (p.agg === 'countDistinct')
      for (const g of ngrams(subject)) {
        if (entity && g.start < entity.start + entity.len && g.start + g.len > entity.start) continue;
        for (const r of reach.filter((x) => x.joins.length === 1)) {
          const s = best(g.words, tableNames(r.info));
          if (s >= 0.8 && (!distinct || s > distinct.score)) distinct = { alias: 't0', col: r.joins[0].fromColumn, label: tableLabel(r.info).toLowerCase(), score: s, start: g.start, len: g.len };
        }
        for (const c of t.columns.filter((x) => x.role !== 'measure' && x.role !== 'empty' && x.role !== 'primaryKey')) {
          const s = best(g.words, [c.label, ...(c.synonyms ?? []), c.name, colLabel(c)]);
          if (s >= 0.8 && (!distinct || s > distinct.score)) distinct = { alias: 't0', col: c.name, label: colLabel(c).toLowerCase(), score: s, start: g.start, len: g.len };
        }
      }
    // A KPI by its (possibly renamed) name: "flash success rate"
    for (const k of ctx.kpis.filter((x) => x.table === t.key && x.category !== 'volume')) {
      const s = matchScore(subject, k.name);
      if (s >= 0.85 && (!measure || s > measure.score)) kpi = k;
    }
    const dims = p.by.map((phrase) => findColumn(phrase, reach, (c) => GROUPABLE.has(c.role))).filter((d): d is ColRef => !!d);
    const outcome = t.columns.find(isOutcomeColumn);
    let score = (entity?.score ?? 0) * 1 + (measure ? measure.score * 0.8 : 0) + (kpi ? 0.9 : 0) + (distinct ? distinct.score * 0.9 : 0) + dims.reduce((s, d) => s + d.score * 0.6, 0) - (p.by.length - dims.length) * 0.6;
    if ((p.grain || p.range) && !t.timeColumn) score -= 0.5;
    if (p.rate || p.outcome) score += outcome ? 0.3 : p.rate ? -0.6 : 0;
    if (t.kind === 'fact') score += 0.05;
    score += (t.importance / 100) * 0.15;
    plans.push({ t, score, entity, measure, kpi, reach, dims, outcome, distinct });
  }
  plans.sort((a, b) => b.score - a.score);
  return { plans, subjectRaw, subject };
}

async function finish(question: string, p: Parsed, plans: Plan[], subjectRaw: string[], subject: string[], byKey: Map<string, TableInfo>, ctx: AskContext, lookup?: ValueLookup): Promise<AskResult> {
  const plan = plans[0];
  const matchedSomething = plan.entity || plan.measure || plan.kpi || plan.distinct || plan.dims.length;
  if (!matchedSomething || plan.score < 0.7) {
    const tops = ctx.tables.filter((t) => t.rowCount > 0).sort((a, b) => b.importance - a.importance).slice(0, 4);
    throw new AskError(`I couldn't match "${question}" to a table or column.`, examples(tops, byKey, ctx.joins));
  }
  const { t, reach } = plan;
  const understood: Understood[] = [{ kind: 'table', text: tableLabel(t) }];
  const conf: number[] = [plan.entity?.score ?? plan.measure?.score ?? 0.8];
  const used = new Set<number>();
  const markUsed = (start: number, len: number) => {
    for (let i = start; i < start + len; i++) used.add(i);
  };
  if (plan.entity) markUsed(plan.entity.start, plan.entity.len);
  if (plan.measure) markUsed(plan.measure.start, plan.measure.len);
  if (plan.distinct) markUsed(plan.distinct.start, plan.distinct.len);

  let joins: JoinStep[] = [];
  const addJoins = (r: Reach) => (joins = mergeJoins(joins, r.joins));
  const where: WhereCond[] = [];
  const filterText: string[] = [];

  // Outcome filters ("failed flashes") and rates ("success rate")
  const outcome = plan.outcome;
  const good = outcome ? outcomeValues(outcome) : [];
  const explicitOutcome = !!outcome && p.where.some((w) => best(w.col, [outcome.name, colLabel(outcome)]) >= 0.75);
  if (p.outcome && outcome && !p.rate && !explicitOutcome) {
    where.push({ alias: 't0', col: outcome.name, values: good, negate: p.outcome === 'bad' });
    filterText.push(`${colLabel(outcome)} ${p.outcome === 'bad' ? 'is not' : 'is'} ${good.join('/')}`);
  }

  // Explicit "where X is Y"
  for (const w of p.where) {
    const ref = findColumn(w.col, reach, (c) => c.role !== 'empty');
    if (!ref) {
      filterText.push(`(ignored: ${w.col.join(' ')} = ${w.value})`);
      continue;
    }
    addJoins(ref.reach);
    const numeric = ['int', 'num'].includes(typeFamily(ref.col.dataType));
    const bool = ref.col.kind === 'boolean' || typeFamily(ref.col.dataType) === 'bool';
    if (bool) where.push({ alias: ref.reach.alias, col: ref.col.name, values: [], bool: true, negate: /^(false|no|0|n)$/.test(w.value) !== w.negate });
    else where.push({ alias: ref.reach.alias, col: ref.col.name, values: [numeric ? Number(w.value) : w.value], numeric, negate: w.negate });
    filterText.push(`${colLabel(ref.col)} ${w.negate ? 'is not' : 'is'} ${w.value}`);
    conf.push(ref.score);
  }

  // Grouping
  const dims = plan.dims.slice(0, 2);
  for (const d of dims) {
    addJoins(d.reach);
    conf.push(d.score);
    understood.push({ kind: 'by', text: dimTitle(d) });
  }

  // Values mentioned without a column ("flashes for ABS"): check leftover words and quoted strings against data
  const leftover = subject.map((w, i) => ({ w, i })).filter((x) => !used.has(x.i));
  const rawLeft = subjectRaw.filter((_w, i) => !used.has(i));
  const phrases = [...new Set([...p.quoted, ...ngrams(rawLeft, 3).map((g) => g.words.join(' '))])].filter((s) => s.length >= 2).slice(0, 24);
  const matchedPhrases = new Set<string>();
  if (phrases.length) {
    const textCols = reach
      .flatMap((r) => r.info.columns.filter((c) => ['dimension', 'label', 'text', 'identifier'].includes(c.role) && typeFamily(c.dataType) === 'text' && !CODE_LIKE.test(c.name)).map((c) => ({ r, c })))
      .sort((a, b) => Number(b.c.name === b.r.info.labelColumn) - Number(a.c.name === a.r.info.labelColumn) || a.r.joins.length - b.r.joins.length);
    let lookups = 0;
    for (const { r, c } of textCols) {
      const remaining = phrases.filter((ph) => !matchedPhrases.has(ph) && ![...matchedPhrases].some((m) => m.includes(ph) || ph.includes(m)));
      if (!remaining.length) break;
      const local = (c.top ?? []).map((x) => x.value.toLowerCase().trim());
      let hits = remaining.filter((ph) => local.includes(ph.toLowerCase()));
      if (!hits.length && lookup && lookups < 10 && (c.name === r.info.labelColumn || c.role === 'dimension') && ++lookups) hits = (await lookup({ table: { schema: r.info.schema, table: r.info.name }, col: c.name }, remaining.map((x) => x.toLowerCase()))).filter((h) => remaining.some((ph) => ph.toLowerCase() === h));
      if (!hits.length) continue;
      // longest phrase wins ("north america" over "north")
      hits.sort((a, b) => b.length - a.length);
      const vals = hits.filter((h, i) => !hits.slice(0, i).some((x) => x.includes(h)));
      addJoins(r);
      where.push({ alias: r.alias, col: c.name, values: vals.map((v) => v.toLowerCase()) });
      const shown = vals.map((v) => [...p.quoted, ...phrases].find((ph) => ph.toLowerCase() === v) ?? v);
      filterText.push(`${r.alias === 't0' ? colLabel(c) : c.name === r.info.labelColumn && !c.label ? r.info.label || humanize(stem(r.info.name)) : dimLabel(r.info, c)} is ${shown.join(' or ')}`);
      for (const v of vals) matchedPhrases.add(v.toLowerCase());
      conf.push(0.95);
    }
  }
  for (const f of filterText) understood.push({ kind: 'filter', text: f });

  // Measure
  const fail = p.rate === 'bad';
  let agg: SelectItem;
  let measureName: string;
  let unit: Suggestion['unit'] = 'short';
  let format = 'N0';
  const entityPlural = pluralize(tableLabel(t).toLowerCase());
  const adjective = p.outcome && outcome && !p.rate ? (p.outcome === 'bad' ? 'unsuccessful ' : 'successful ') : '';
  if (p.rate && outcome) {
    agg = { kind: 'rate', alias: 't0', col: outcome.name, values: good, negate: fail, as: 'value' };
    measureName = `${colLabel(outcome)} ${fail ? 'failure' : 'success'} rate`;
    unit = 'percent';
    format = 'N1';
  } else if (plan.kpi && !p.agg) {
    agg = { ...plan.kpi.agg, as: 'value' } as SelectItem;
    measureName = plan.kpi.name;
    unit = plan.kpi.unit;
    format = plan.kpi.format;
  } else if (p.agg === 'countDistinct') {
    // "unique users" → COUNT(DISTINCT user_id)
    const col = plan.distinct;
    if (col) {
      agg = { kind: 'agg', fn: 'countDistinct', alias: col.alias, col: col.col, as: 'value' };
      measureName = `Distinct ${pluralize(col.label)}`;
      conf.push(col.score);
    } else {
      agg = { kind: 'agg', fn: 'count', as: 'value' };
      measureName = `Number of ${entityPlural}`;
    }
  } else if (plan.measure) {
    const c = plan.measure.col;
    const kpi = ctx.kpis.find((k) => k.table === t.key && k.column === c.name && k.agg.kind === 'agg');
    const fn = p.agg && p.agg !== 'count' ? p.agg : kpi && kpi.agg.kind === 'agg' ? kpi.agg.fn : c.min !== undefined && Number(c.min) >= 0 ? 'sum' : 'avg';
    agg = { kind: 'agg', fn: fn as 'sum', alias: 't0', col: c.name, as: 'value' };
    measureName = `${AGG_WORD[fn] ?? 'Total'} ${colLabel(c).toLowerCase()}`;
    unit = kpi?.unit ?? (/(_ms|ms$)/i.test(c.name) ? 'ms' : 'short');
    format = unit === 'currency' ? 'C0' : fn === 'sum' && Number.isInteger(c.min) && Number.isInteger(c.max) ? 'N0' : 'N2';
    conf.push(plan.measure.score);
  } else {
    agg = { kind: 'agg', fn: 'count', as: 'value' };
    measureName = `Number of ${adjective}${entityPlural}`;
  }
  understood.splice(1, 0, { kind: 'measure', text: measureName });

  // Time
  const time = t.timeColumn ? { alias: 't0', col: t.timeColumn } : undefined;
  const ignored: string[] = [];
  if ((p.grain || p.range) && !time) ignored.push(`time (${tableLabel(t)} has no date column)`);
  const range = time && p.range ? { from: p.range.from, to: p.range.to, relative: p.range.relative } : undefined;
  if (range) understood.push({ kind: 'time', text: p.range!.text });
  const notes: string[] = [];
  const fmtDay = (iso: string) => new Date(iso).toUTCString().slice(5, 16);
  if (range && t.timeRange) {
    const last = Date.parse(t.timeRange.to);
    const first = Date.parse(t.timeRange.from);
    if (range.from && last < Date.parse(range.from)) notes.push(`${tableLabel(t)} has no rows in this period: its latest ${t.timeColumn} is ${fmtDay(t.timeRange.to)}.`);
    else if (range.to && first >= Date.parse(range.to)) notes.push(`${tableLabel(t)} has no rows in this period: its data starts ${fmtDay(t.timeRange.from)}.`);
  }
  const spanFrom = range?.from ?? t.timeRange?.from;
  const spanTo = range?.to ?? t.timeRange?.to ?? new Date(ctx.now ?? Date.now()).toISOString();
  const unit2: TimeUnit = p.grain && p.grain !== 'auto' ? p.grain : chooseUnit(spanFrom ? { from: spanFrom, to: spanTo } : t.timeRange);
  const series = !!time && !!p.grain;
  if (series) understood.push({ kind: 'time', text: `By ${unit2}` });

  // Shape of the answer
  let kind: SuggestionKind;
  const select: SelectItem[] = [];
  const fields: Suggestion['fields'] = {};
  let orderBy: QuerySpec['orderBy'];
  let limit: number | undefined;
  let viz: Suggestion['viz'];
  const notNull = dims.map((d) => ({ alias: d.reach.alias, col: d.col.name, text: typeFamily(d.col.dataType) === 'text' }));
  if (dims.length >= 2 && !series) {
    kind = 'heatmap';
    viz = 'heatmap';
    select.push({ kind: 'col', alias: dims[1].reach.alias, col: dims[1].col.name, as: 'x' }, { kind: 'col', alias: dims[0].reach.alias, col: dims[0].col.name, as: 'y' }, agg);
    Object.assign(fields, { x: 'x', y: 'y', value: 'value', xLabel: dimTitle(dims[1]), yLabel: dimTitle(dims[0]) });
    orderBy = [{ as: 'value', dir: 'desc' }];
    limit = 600;
  } else if (series) {
    select.push({ kind: 'time', alias: 't0', col: time!.col, as: 'time' });
    if (dims.length) {
      kind = 'trendBy';
      viz = 'area';
      select.push({ kind: 'col', alias: dims[0].reach.alias, col: dims[0].col.name, as: 'series' });
      fields.series = 'series';
    } else {
      kind = 'trend';
      viz = 'line';
    }
    select.push(agg);
    Object.assign(fields, { category: 'time', value: 'value' });
    orderBy = [{ as: 'time', dir: 'asc' }];
  } else if (dims.length === 1) {
    const d = dims[0];
    const pie = p.share && d.col.distinct <= 8 && agg.kind === 'agg' && (agg.fn === 'count' || agg.fn === 'sum');
    kind = pie ? 'share' : p.outcome === 'bad' && !p.rate ? 'failures' : 'breakdown';
    viz = pie ? 'pie' : 'bar';
    select.push({ kind: 'col', alias: d.reach.alias, col: d.col.name, as: 'label' }, agg);
    Object.assign(fields, { category: 'label', value: 'value' });
    orderBy = [{ as: 'value', dir: p.top?.dir ?? 'desc' }];
    limit = p.top?.n ?? 25;
  } else if (p.list) {
    kind = 'detail';
    viz = 'table';
    const own = t.columns.filter((c) => ['dimension', 'measure', 'label', 'time'].includes(c.role) && c.nullPct < 90).slice(0, 8);
    if (time && !own.some((c) => c.name === time.col)) select.push({ kind: 'col', alias: 't0', col: time.col, as: time.col });
    for (const c of own) select.push({ kind: 'col', alias: 't0', col: c.name, as: c.name });
    for (const r of reach.filter((x) => x.joins.length === 1 && x.info.labelColumn).slice(0, 3)) {
      addJoins(r);
      const as = `${stem(r.info.name)}_${r.info.labelColumn}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
      if (!select.some((s) => s.as === as)) select.push({ kind: 'col', alias: r.alias, col: r.info.labelColumn!, as });
    }
    orderBy = time ? [{ as: select.find((s) => s.kind === 'col' && s.col === time.col)!.as, dir: 'desc' }] : undefined;
    limit = p.top?.n ?? 200;
    measureName = `${tableLabel(t)} rows`;
    understood[1] = { kind: 'measure', text: 'Rows (list)' };
  } else {
    kind = 'kpi';
    viz = 'kpi';
    select.push(agg);
    fields.value = 'value';
  }
  if (p.top) understood.push({ kind: 'sort', text: p.top.text });

  // Unused words are reported so the user knows what was not understood
  for (const x of leftover) if (!used.has(x.i) && !matchedPhrases.has(x.w) && ![...matchedPhrases].some((m) => m.split(' ').map(singular).includes(x.w))) ignored.push(x.w);
  if (dims.length < p.by.length) for (const b of p.by.filter((ph) => !plan.dims.some((d) => best(ph, columnNames(d.reach, d.col)) >= 0.75))) ignored.push(`by ${b.join(' ')}`);

  const spec: QuerySpec = { base: { schema: t.schema, table: t.name }, joins, select, time, group: kind !== 'kpi' && kind !== 'detail', orderBy, limit, notNull: notNull.length ? notNull : undefined, where: where.length ? where : undefined, range };
  // KPI with grouping off but filters on: still a single number
  if (kind === 'kpi') spec.group = false;

  const title = buildTitle(kind, measureName, dims, p, range ? p.range!.text : undefined, unit2);
  const tablesUsed = [...new Set([t.key, ...joins.map((j) => tkey(j.table.schema, j.table.table))])];
  const alternatives = plans
    .slice(1)
    .filter((x) => x.score >= plan.score - 0.25 && x.score > 0.7 && tableLabel(x.t) !== tableLabel(t))
    .slice(0, 3)
    .map((x) => ({ table: x.t.key, label: `${tableLabel(x.t)} (${x.t.key})` }));
  const dimension: DimensionRef | undefined = dims[0]
    ? { id: `d:${dims[0].reach.info.key}.${dims[0].col.name}`, label: dimTitle(dims[0]), table: { schema: dims[0].reach.info.schema, table: dims[0].reach.info.name }, col: dims[0].col.name, distinct: dims[0].col.distinct, text: typeFamily(dims[0].col.dataType) === 'text' }
    : undefined;
  const confidence = Math.round(Math.min(...conf, 1) * 100 - ignored.length * 6);
  return {
    suggestion: {
      kind,
      title,
      description: `Answer to "${question.trim()}": ${understood.map((u) => u.text).join(' · ')}`,
      viz,
      table: t.key,
      tables: tablesUsed,
      joinIds: [...new Set(joins.map((j) => j.joinId))],
      score: Math.max(1, Math.min(99, confidence)),
      recommended: false,
      spec,
      fields,
      unit,
      format,
      dimension,
      timeUnit: series || range ? unit2 : undefined,
    },
    understood,
    ignored: [...new Set(ignored)],
    confidence: Math.max(5, Math.min(100, confidence)),
    alternatives,
    timeUnit: unit2,
    notes,
  };
}

function dimTitle(d: ColRef) {
  const r = d.reach;
  if (r.alias === 't0') return colLabel(d.col);
  if (d.col.label) return d.col.label;
  if (d.col.name === r.info.labelColumn && !d.col.label) return r.info.label || humanize(stem(r.info.name)) || tableLabel(r.info);
  return dimLabel(r.info, d.col);
}

function buildTitle(kind: SuggestionKind, measure: string, dims: ColRef[], p: Parsed, rangeText: string | undefined, unit: TimeUnit) {
  let s = measure;
  if (kind === 'trend' || kind === 'trendBy') s += ` by ${unit}`;
  if (dims.length) s += ` by ${dims.map((d) => dimTitle(d).toLowerCase()).join(' and ')}`;
  if (p.top?.n && (kind === 'breakdown' || kind === 'failures' || kind === 'share')) s = `${p.top.dir === 'desc' ? 'Top' : 'Bottom'} ${p.top.n}: ${s}`;
  if (rangeText) s += ` (${rangeText.toLowerCase()})`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Example questions built from the model, shown when a question could not be matched. */
export function examples(tables: TableInfo[], byKey: Map<string, TableInfo>, joins: JoinRec[]): string[] {
  const out: string[] = [];
  for (const t of tables) {
    const ent = pluralize(tableLabel(t).toLowerCase());
    const reach = reachable(t, byKey, joins);
    const dim = reach.flatMap((r) => r.info.columns.filter((c) => (c.role === 'dimension' && c.distinct >= 2 && c.distinct <= 30) || (r.alias !== 't0' && c.name === r.info.labelColumn)).map((c) => ({ r, c })))[0];
    const by = dim ? (dim.r.alias === 't0' ? colLabel(dim.c) : dim.c.name === dim.r.info.labelColumn ? tableLabel(dim.r.info) : colLabel(dim.c)).toLowerCase() : undefined;
    const outcome = t.columns.find(isOutcomeColumn);
    if (outcome && by) out.push(`failed ${ent} by ${by}`);
    else if (by) out.push(`${ent} by ${by}`);
    if (t.timeColumn) out.push(`${ent} per month last 12 months`);
    if (out.length >= 5) break;
  }
  return [...new Set(out)].slice(0, 5);
}

export { GOOD, BAD };
