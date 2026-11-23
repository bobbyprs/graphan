import * as echarts from 'echarts';
import type { DataSource } from '@prisma/client';
import type { QueryResult } from '../../connectors/types';
import type { VariableValue } from '../../connectors/query-builder';
import { AppError, BadRequest, NotFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { executeQuery } from '../queries/query.service';
import { compileExpression } from '../queries/expression';
import { dataSourceRepository } from '../datasources/datasources.repository';
import { aggregate, compareValues, evaluateText, formatValue, resolveDateKeyword, toNumber, type ExpressionScope, type FormatContext } from './format';
import { reportDefinitionSchema, type ChartItem, type MatrixItem, type ReportDefinition, type ReportItem, type ReportParameter, type TableItem } from './report.schema';
import type { RCell, RColumn, RenderedReport, RItem, RTableRow } from './rendered';

export type ParamInput = Record<string, unknown>;
export type ParamValues = Record<string, VariableValue>;

export interface RenderContext {
  reportId: string;
  title: string;
  description?: string | null;
  workspaceId: string;
  userName: string;
  /** subreport nesting depth */
  depth?: number;
  signal?: AbortSignal;
}

export interface RenderOutput {
  model: RenderedReport;
  /** raw dataset results (JSON export) */
  data: Record<string, QueryResult>;
}

const MAX_SUBREPORT_DEPTH = 3;

export function parseReportDefinition(raw: unknown): ReportDefinition {
  return reportDefinitionSchema.parse(raw);
}

async function dataSource(id: string, workspaceId: string): Promise<DataSource> {
  const ds = await dataSourceRepository.findByIdUnscoped(id);
  if (!ds || ds.workspaceId !== workspaceId) throw NotFound('Data source');
  return ds;
}

// ───────────────────────── Parameters ─────────────────────────

function coerceOne(p: ReportParameter, v: unknown, tz: string): string | number | null {
  if (v === null || v === undefined || v === '') return null;
  switch (p.type) {
    case 'integer': {
      const n = toNumber(v);
      if (n === null || !Number.isInteger(n)) throw BadRequest(`Parameter "${p.label ?? p.name}" must be a whole number`);
      return n;
    }
    case 'float': {
      const n = toNumber(v);
      if (n === null) throw BadRequest(`Parameter "${p.label ?? p.name}" must be a number`);
      return n;
    }
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1' ? 'true' : 'false';
    case 'date': {
      const s = resolveDateKeyword(String(v), tz);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw BadRequest(`Parameter "${p.label ?? p.name}" must be a date (yyyy-MM-dd)`);
      return s;
    }
    case 'datetime': {
      const s = resolveDateKeyword(String(v), tz);
      if (Number.isNaN(new Date(s).getTime())) throw BadRequest(`Parameter "${p.label ?? p.name}" must be a date/time`);
      return s;
    }
    default:
      return String(v);
  }
}

export interface ParamOption {
  value: string | number;
  label: string;
}

/** Available values for a parameter; query options see earlier parameters' values (cascading). */
export async function parameterOptions(def: ReportDefinition, name: string, current: ParamValues, workspaceId: string): Promise<ParamOption[]> {
  const p = def.parameters.find((x) => x.name === name);
  if (!p) throw NotFound('Parameter');
  if (p.options.kind === 'static') return p.options.values.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  if (p.options.kind !== 'query') return [];
  const ds = await dataSource(p.options.dataSourceId, workspaceId);
  const r = await executeQuery(ds, p.options.query, { maxRows: 5000, user: null, ctx: { variables: current } });
  const vf = p.options.valueField ?? r.columns[0]?.name;
  const lf = p.options.labelField ?? r.columns[1]?.name ?? vf;
  if (!vf) return [];
  const seen = new Set<string>();
  const out: ParamOption[] = [];
  for (const row of r.rows) {
    const raw = row[vf];
    if (raw === null || raw === undefined) continue;
    const key = String(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: typeof raw === 'number' ? raw : key, label: formatValue(row[lf!], undefined, { locale: def.locale, currency: def.currency, timezone: def.timezone }) || key });
  }
  return out;
}

export class MissingParametersError extends AppError {
  constructor(public readonly missing: string[]) {
    super(400, `Enter a value for: ${missing.join(', ')}`, 'PARAMETERS_REQUIRED', { missing });
  }
}

/** Applies defaults, coerces types and validates; returns values plus display labels. */
export async function resolveParameters(def: ReportDefinition, input: ParamInput, workspaceId: string) {
  const values: ParamValues = {};
  const labels: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of def.parameters) {
    let raw: unknown = input[p.name];
    let options: ParamOption[] | undefined;
    if (raw === undefined) {
      if (p.default !== undefined && p.default !== null) raw = p.default;
      else if (p.options.kind === 'query' && p.options.defaultFirst) {
        options = await parameterOptions(def, p.name, values, workspaceId);
        raw = p.multi ? options.map((o) => o.value) : options[0]?.value;
      }
    }
    let v: VariableValue;
    if (p.multi) {
      const arr = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]).map((x) => coerceOne(p, x, def.timezone)).filter((x): x is string | number => x !== null);
      if (!arr.length && p.required) missing.push(p.label ?? p.name);
      v = arr;
    } else {
      v = coerceOne(p, Array.isArray(raw) ? raw[0] : raw, def.timezone);
      if (v === null && p.required) missing.push(p.label ?? p.name);
    }
    if (p.options.kind === 'static') {
      const allowed = new Set(p.options.values.map((o) => String(o.value)));
      const bad = (Array.isArray(v) ? v : v === null ? [] : [v]).filter((x) => !allowed.has(String(x)));
      if (bad.length) throw BadRequest(`"${bad[0]}" is not a valid value for ${p.label ?? p.name}`);
    }
    values[p.name] = v;
    // Display labels (query labels only when a separate label column exists)
    if (p.options.kind === 'static' || (p.options.kind === 'query' && p.options.labelField)) {
      options ??= await parameterOptions(def, p.name, values, workspaceId).catch(() => []);
      const map = new Map(options.map((o) => [String(o.value), o.label]));
      labels[p.name] = (Array.isArray(v) ? v : v === null ? [] : [v]).map((x) => map.get(String(x)) ?? String(x)).join(', ');
    } else {
      labels[p.name] = Array.isArray(v) ? v.join(', ') : v === null ? '(null)' : p.type === 'boolean' ? (v === 'true' ? 'Yes' : 'No') : String(v);
    }
    // Long multi-value selections: "All (42)" when everything is selected, otherwise a short list
    if (Array.isArray(v) && v.length > 6) {
      if (p.options.kind !== 'none') options ??= await parameterOptions(def, p.name, values, workspaceId).catch(() => []);
      const sel = new Set(v.map(String));
      if (options?.length && options.length === sel.size && options.every((o) => sel.has(String(o.value)))) labels[p.name] = `All (${options.length})`;
      else if (v.length > 10) labels[p.name] = `${labels[p.name].split(', ').slice(0, 8).join(', ')} … (+${v.length - 8} more)`;
    }
  }
  if (missing.length) throw new MissingParametersError(missing);
  return { values, labels };
}

// ───────────────────────── Rendering ─────────────────────────

export async function renderReport(defRaw: unknown, input: ParamInput, ctx: RenderContext): Promise<RenderOutput> {
  const started = Date.now();
  const def = parseReportDefinition(defRaw);
  const fmt: FormatContext = { locale: def.locale, currency: def.currency, timezone: def.timezone };
  const { values, labels } = await resolveParameters(def, input, ctx.workspaceId);

  // Datasets run in parallel, read-only, as the system (viewers never need query permission)
  const data: Record<string, QueryResult> = {};
  await Promise.all(
    def.datasets.map(async (d) => {
      const ds = await dataSource(d.dataSourceId, ctx.workspaceId);
      let r: QueryResult;
      try {
        r = await executeQuery(ds, d.query, { ctx: { variables: values }, maxRows: d.maxRows, user: null, signal: ctx.signal });
      } catch (e) {
        throw new AppError(400, `Dataset "${d.name}": ${(e as Error).message.replace(/^Query failed: /, '')}`, 'DATASET_ERROR');
      }
      if (d.calculated.length) {
        const exprs = d.calculated.map((c) => ({ name: c.name, e: compileExpression(c.expression) }));
        r = {
          ...r,
          columns: [...r.columns, ...exprs.map((x) => ({ name: x.name, type: 'calculated' }))],
          rows: r.rows.map((row) => {
            const out = { ...row };
            for (const x of exprs) out[x.name] = x.e.evaluate(out);
            return out;
          }),
        };
      }
      data[d.name] = r;
    }),
  );

  const scope: ExpressionScope = {
    fmt,
    reportName: ctx.title,
    executionTime: new Date(),
    user: ctx.userName,
    parameters: values,
    parameterLabels: labels,
    datasets: data,
  };

  const items: RItem[] = [];
  const documentMap: { id: string; label: string; level: number }[] = [];
  for (const it of def.body) {
    try {
      const rendered = await renderItem(it, def, data, scope, ctx);
      if (it.bookmark && rendered.length) documentMap.push({ id: rendered[0].id, label: evaluateText(it.bookmark, scope), level: 0 });
      items.push(...rendered);
    } catch (e) {
      if (e instanceof AppError && e.code === 'SUBREPORT_DEPTH') throw e;
      items.push({ type: 'error', id: it.id, title: it.title, message: (e as Error).message });
    }
  }

  const pageScope = { ...scope, keepPageTokens: true };
  const hf = (o: { left: string; center: string; right: string }) => ({ left: evaluateText(o.left, pageScope), center: evaluateText(o.center, pageScope), right: evaluateText(o.right, pageScope) });

  const model: RenderedReport = {
    reportId: ctx.reportId,
    title: ctx.title,
    description: ctx.description,
    page: def.page,
    header: hf(def.header),
    footer: hf(def.footer),
    showTitle: def.showTitle,
    showParameters: def.showParameters,
    executedAt: scope.executionTime.toISOString(),
    user: ctx.userName,
    parameters: def.parameters.map((p) => ({ name: p.name, label: p.label ?? p.name, display: labels[p.name] ?? '', hidden: p.hidden })),
    items,
    documentMap,
    datasets: def.datasets.map((d) => ({ name: d.name, rowCount: data[d.name]?.rowCount ?? 0, truncated: !!data[d.name]?.truncated, durationMs: data[d.name]?.durationMs ?? 0 })),
    rowCount: items.reduce((n, i) => n + (i.type === 'table' ? i.dataRows : i.type === 'matrix' ? i.rows.length : 0), 0),
    durationMs: Date.now() - started,
    fmt,
  };
  return { model, data };
}

async function renderItem(it: ReportItem, def: ReportDefinition, data: Record<string, QueryResult>, scope: ExpressionScope, ctx: RenderContext): Promise<RItem[]> {
  const ds = (name: string) => {
    const r = data[name];
    if (!r) throw new Error(`Unknown dataset "${name}"`);
    return r;
  };
  const title = it.title ? evaluateText(it.title, scope) : undefined;
  switch (it.type) {
    case 'text':
      return [{ type: 'text', id: it.id, text: evaluateText(it.text, scope), style: it.style }];
    case 'list': {
      const r = ds(it.dataset);
      const rows = it.maxRows ? r.rows.slice(0, it.maxRows) : r.rows;
      const out: RItem[] = [];
      rows.forEach((row, ri) => {
        const rowScope: ExpressionScope = { ...scope, fields: row };
        for (const child of it.items) {
          const cid = `${it.id}.${ri}.${child.id}`;
          if (child.type === 'text') out.push({ type: 'text', id: cid, text: evaluateText(child.text, rowScope), style: child.style });
          else if (child.type === 'image') out.push({ type: 'image', id: cid, src: child.src, width: child.width, align: child.align ?? 'left' });
          else out.push({ type: 'divider', id: cid });
        }
      });
      // Always emit at least one node so a bookmark on an empty list still has an anchor.
      if (!out.length) out.push({ type: 'text', id: it.id, text: it.title ? '' : '', style: {} });
      return out;
    }
    case 'table':
      return [renderTable(it, ds(it.dataset), scope.fmt, title, scope.parameters)];
    case 'matrix':
      return [renderMatrix(it, ds(it.dataset), scope.fmt, title)];
    case 'chart':
      return [renderChart(it, ds(it.dataset), scope.fmt, title, def)];
    case 'kpi':
      return [{ type: 'kpi', id: it.id, title, cards: it.cards.map((c) => ({ label: evaluateText(c.label, scope), value: evaluateText(c.value, scope), color: c.color, note: c.note ? evaluateText(c.note, scope) : undefined })) }];
    case 'image':
      return [{ type: 'image', id: it.id, title, src: it.src, width: it.width, align: it.align ?? 'left' }];
    case 'pageBreak':
      return [{ type: 'pageBreak', id: it.id }];
    case 'divider':
      return [{ type: 'divider', id: it.id }];
    case 'subreport':
      return renderSubreport(it, scope, ctx, title);
  }
}

async function renderSubreport(it: Extract<ReportItem, { type: 'subreport' }>, scope: ExpressionScope, ctx: RenderContext, title?: string): Promise<RItem[]> {
  const depth = (ctx.depth ?? 0) + 1;
  if (depth > MAX_SUBREPORT_DEPTH) throw new AppError(400, `Subreports can be nested at most ${MAX_SUBREPORT_DEPTH} levels`, 'SUBREPORT_DEPTH');
  const sub = await prisma.report.findUnique({ where: { id: it.reportId } });
  if (!sub || sub.workspaceId !== ctx.workspaceId) throw new Error('Subreport not found');
  const params: ParamInput = {};
  for (const [k, expr] of Object.entries(it.params)) {
    const whole = /^\{\{\s*Parameters\.(\w+)\s*\}\}$/.exec(expr);
    params[k] = whole ? scope.parameters[whole[1]] : expr.startsWith('=') ? expr.slice(1) : evaluateText(expr, scope);
  }
  const out = await renderReport(sub.definition, params, { ...ctx, reportId: sub.id, title: sub.title, description: sub.description, depth });
  const items = out.model.items.map((i) => ({ ...i, id: `${it.id}.${i.id}` }) as RItem);
  return title ? [{ type: 'text', id: `${it.id}.title`, text: title, style: { fontSize: 12, bold: true } }, ...items] : items;
}

// ───────────────────────── Table (tablix with groups) ─────────────────────────

function matchRule(v: unknown, r: TableItem['columns'][number]['rules'][number]): boolean {
  const empty = v === null || v === undefined || v === '';
  if (r.op === 'empty') return empty;
  if (r.op === 'notEmpty') return !empty;
  if (empty) return false;
  if (r.op === 'contains') return String(v).toLowerCase().includes(String(r.value ?? '').toLowerCase());
  const c = compareValues(v, typeof r.value === 'string' && toNumber(r.value) !== null && toNumber(v) !== null ? toNumber(r.value) : r.value);
  switch (r.op) {
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '=': return c === 0;
    case '!=': return c !== 0;
  }
}

function renderTable(t: TableItem, r: QueryResult, fmt: FormatContext, title: string | undefined, params: Record<string, unknown>): RItem {
  const known = new Set(r.columns.map((c) => c.name));
  for (const f of [...t.columns.map((c) => c.field), ...t.groups.map((g) => g.field)]) if (r.rows.length && !known.has(f)) throw new Error(`Field "${f}" is not returned by dataset "${t.dataset}"`);

  const isNum = (field: string) => /int|numeric|decimal|double|real|float|number|money|calculated/i.test(r.columns.find((c) => c.name === field)?.type ?? '');
  const columns: RColumn[] = t.columns.map((c) => ({ field: c.field, header: c.header ?? c.field, align: c.align ?? (isNum(c.field) || c.aggregate && c.aggregate !== 'none' ? 'right' : 'left'), width: c.width ?? 1, format: c.format }));

  let rows = r.rows;
  if (t.filter) {
    const e = compileExpression(t.filter);
    rows = rows.filter((row) => !!e.evaluate(row));
  }
  if (t.sort.length) rows = [...rows].sort((a, b) => t.sort.reduce((acc, s) => acc || compareValues(a[s.field], b[s.field]) * (s.dir === 'desc' ? -1 : 1), 0));

  const fmtField = (field: string, v: unknown) => formatValue(v, t.columns.find((c) => c.field === field)?.format, fmt);
  const aggCells = (subset: Record<string, unknown>[], label: string): RCell[] => {
    let labelled = false;
    const cells = t.columns.map((c) => {
      if (c.aggregate && c.aggregate !== 'none') {
        const v = aggregate(subset, c.field, c.aggregate);
        return { v, t: formatValue(v, c.format ?? (c.aggregate === 'count' || c.aggregate === 'countDistinct' ? 'N0' : undefined), fmt), bold: true };
      }
      return { v: null, t: '' } as RCell;
    });
    const i = cells.findIndex((c) => c.t === '');
    if (i >= 0) {
      cells[i] = { v: label, t: label, bold: true };
      labelled = true;
    }
    return labelled ? cells : cells;
  };

  const out: RTableRow[] = [];
  let dataRows = 0;
  const emit = (subset: Record<string, unknown>[], level: number, anc: string[]) => {
    if (level === t.groups.length) {
      if (!t.details) return;
      const prev: Record<string, string> = {};
      for (const row of subset) {
        dataRows++;
        out.push({
          kind: 'data',
          level,
          anc,
          cells: t.columns.map((c) => {
            const v = row[c.field];
            const text = formatValue(v, c.format, fmt);
            const cell: RCell = { v: v instanceof Date ? v.toISOString() : v, t: c.hideDuplicates && prev[c.field] === text ? '' : text };
            prev[c.field] = text;
            const rule = c.rules.find((ru) => matchRule(v, ru));
            if (rule) Object.assign(cell, { color: rule.color, bg: rule.background, bold: rule.bold });
            if (c.drillthrough) {
              const lp: Record<string, unknown> = {};
              for (const [p, src] of Object.entries(c.drillthrough.params)) lp[p] = src.startsWith('=') ? src.slice(1) : src.startsWith('@') ? params[src.slice(1)] : row[src] instanceof Date ? (row[src] as Date).toISOString() : row[src];
              cell.link = { reportId: c.drillthrough.reportId, params: lp };
            }
            return cell;
          }),
        });
      }
      return;
    }
    const g = t.groups[level];
    const buckets = new Map<string, Record<string, unknown>[]>();
    const raw = new Map<string, unknown>();
    for (const row of subset) {
      const v = row[g.field];
      const k = v instanceof Date ? v.toISOString() : String(v ?? '');
      if (!buckets.has(k)) {
        buckets.set(k, []);
        raw.set(k, v);
      }
      buckets.get(k)!.push(row);
    }
    let keys = [...buckets.keys()];
    if (g.sort !== 'none') keys.sort((a, b) => compareValues(raw.get(a), raw.get(b)) * (g.sort === 'desc' ? -1 : 1));
    keys.forEach((k, i) => {
      const grows = buckets.get(k)!;
      const display = fmtField(g.field, raw.get(k)) || '(blank)';
      const key = `${anc[anc.length - 1] ?? ''}/${level}:${k}`;
      const header = columns.find((c) => c.field === g.field)?.header ?? g.field;
      if (g.header) {
        out.push({
          kind: 'group',
          level,
          anc,
          key,
          label: g.label ? g.label.replace(/\{\{\s*value\s*\}\}/gi, display).replace(/\{\{\s*count\s*\}\}/gi, String(grows.length)) : `${header}: ${display}`,
          cells: [],
          count: grows.length,
          collapsed: g.collapsed,
          pageBreakBefore: g.pageBreak && (i > 0 || out.length > 0),
        });
      }
      emit(grows, level + 1, g.header ? [...anc, key] : anc);
      if (g.subtotal && t.columns.some((c) => c.aggregate && c.aggregate !== 'none')) {
        out.push({ kind: 'subtotal', level, anc, cells: aggCells(grows, `Total ${display}`) });
      }
    });
  };
  emit(rows, 0, []);
  if (t.totals && rows.length && t.columns.some((c) => c.aggregate && c.aggregate !== 'none')) out.push({ kind: 'total', level: 0, anc: [], cells: aggCells(rows, 'Grand total') });

  return {
    type: 'table',
    id: t.id,
    title,
    columns,
    rows: out,
    repeatHeader: t.repeatHeader,
    zebra: t.zebra,
    empty: rows.length ? undefined : (t.noRowsMessage ?? 'No data for the selected parameters.'),
    dataRows: t.details ? dataRows : rows.length,
    groupLevels: t.groups.length,
  };
}

// ───────────────────────── Matrix (cross-tab) ─────────────────────────

function renderMatrix(m: MatrixItem, r: QueryResult, fmt: FormatContext, title?: string): RItem {
  const key = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));
  const colRaw = new Map<string, unknown>();
  for (const row of r.rows) if (!colRaw.has(key(row[m.column]))) colRaw.set(key(row[m.column]), row[m.column]);
  let cols = [...colRaw.keys()];
  if (m.columnSort !== 'none') cols.sort((a, b) => compareValues(colRaw.get(a), colRaw.get(b)) * (m.columnSort === 'desc' ? -1 : 1));
  const truncated = Math.max(0, cols.length - m.maxColumns);
  cols = cols.slice(0, m.maxColumns);

  const groups = new Map<string, { labels: unknown[]; rows: Record<string, unknown>[] }>();
  for (const row of r.rows) {
    const k = m.rows.map((f) => key(row[f])).join('\u0001');
    if (!groups.has(k)) groups.set(k, { labels: m.rows.map((f) => row[f]), rows: [] });
    groups.get(k)!.rows.push(row);
  }
  const cell = (rows: Record<string, unknown>[], bold = false): RCell => {
    const v = rows.length ? aggregate(rows, m.value, m.aggregate) : null;
    return { v, t: formatValue(v, m.format, fmt), bold };
  };
  const byCol = (rows: Record<string, unknown>[], c: string) => rows.filter((x) => key(x[m.column]) === c);
  return {
    type: 'matrix',
    id: m.id,
    title,
    rowHeaders: m.rows,
    columns: cols.map((c) => formatValue(colRaw.get(c), undefined, fmt) || '(blank)'),
    rows: [...groups.values()].map((g) => ({
      labels: g.labels.map((l) => formatValue(l, undefined, fmt)),
      cells: cols.map((c) => cell(byCol(g.rows, c))),
      total: m.rowTotals ? cell(g.rows, true) : undefined,
    })),
    columnTotals: m.columnTotals ? cols.map((c) => cell(byCol(r.rows, c), true)) : undefined,
    grandTotal: m.columnTotals && m.rowTotals ? cell(r.rows, true) : undefined,
    rowTotals: m.rowTotals,
    format: m.format,
    truncatedColumns: truncated || undefined,
    empty: r.rows.length ? undefined : 'No data for the selected parameters.',
  };
}

// ───────────────────────── Charts (ECharts, rendered server-side to SVG) ─────────────────────────

const PALETTE = ['#3871DC', '#F2A33A', '#4CAF7D', '#E05A5A', '#8E6CDB', '#2BB3C0', '#D97BB5', '#8A9A5B', '#C08B5C', '#6C7A89', '#F06292', '#26A69A'];

function renderChart(c: ChartItem, r: QueryResult, fmt: FormatContext, title: string | undefined, def: ReportDefinition): RItem {
  const key = (v: unknown) => (v instanceof Date ? formatValue(v, 'D', fmt) : formatValue(v, undefined, fmt));
  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  for (const row of r.rows) {
    const k = key(row[c.category]);
    if (!catIndex.has(k)) {
      catIndex.set(k, categories.length);
      categories.push(k);
    }
  }
  let series: { name: string; data: (number | null)[] }[];
  if (c.seriesField) {
    const map = new Map<string, (number | null)[]>();
    for (const row of r.rows) {
      const s = key(row[c.seriesField]);
      if (!map.has(s)) map.set(s, categories.map(() => null));
      const arr = map.get(s)!;
      const i = catIndex.get(key(row[c.category]))!;
      arr[i] = (arr[i] ?? 0) + (toNumber(row[c.series[0]]) ?? 0);
    }
    series = [...map.entries()].slice(0, 24).map(([name, data]) => ({ name, data }));
  } else {
    series = c.series.map((f) => {
      const data: (number | null)[] = categories.map(() => null);
      for (const row of r.rows) {
        const i = catIndex.get(key(row[c.category]))!;
        const n = toNumber(row[f]);
        if (n !== null) data[i] = (data[i] ?? 0) + n;
      }
      return { name: f, data };
    });
  }

  const label = (v: number | null) => (c.labels && v !== null ? { show: true, formatter: formatValue(v, c.format, fmt).replace(/[{}|]/g, '') } : undefined);
  const pie = c.chartType === 'pie' || c.chartType === 'donut';
  const horizontal = c.chartType === 'bar';
  const option: Record<string, unknown> = {
    animation: false,
    color: PALETTE,
    textStyle: { fontFamily: 'Roboto, Segoe UI, Arial, sans-serif' },
    tooltip: { trigger: pie ? 'item' : 'axis' },
    legend: c.legend && (series.length > 1 || pie) ? { bottom: 0, type: 'scroll' } : undefined,
    grid: pie ? undefined : { left: 8, right: 16, top: 16, bottom: c.legend && series.length > 1 ? 36 : 8, containLabel: true },
  };
  if (pie) {
    option.series = [
      {
        type: 'pie',
        radius: c.chartType === 'donut' ? ['42%', '70%'] : '70%',
        center: ['50%', '46%'],
        label: { show: true, formatter: '{b}: {d}%' },
        data: categories.map((name, i) => ({ name, value: series[0]?.data[i] ?? 0 })),
      },
    ];
  } else {
    const cat = { type: 'category', data: categories, axisLabel: { hideOverlap: true } };
    const val = { type: 'value', axisLabel: { hideOverlap: true } };
    option.xAxis = horizontal ? val : cat;
    option.yAxis = horizontal ? { ...cat, inverse: true } : val;
    option.series = series.map((s) => ({
      name: s.name,
      type: c.chartType === 'line' || c.chartType === 'area' ? 'line' : 'bar',
      stack: c.chartType === 'stacked' || (c.chartType === 'area' && series.length > 1) ? 'total' : undefined,
      areaStyle: c.chartType === 'area' ? { opacity: 0.25 } : undefined,
      smooth: c.chartType === 'line' || c.chartType === 'area' ? 0.2 : undefined,
      showSymbol: categories.length <= 40,
      data: s.data.map((v) => (c.labels ? { value: v, label: label(v) } : v)),
    }));
  }

  // Width roughly matching the printable width so text scales sensibly in PDF/Word
  const portrait = def.page.orientation === 'portrait';
  const width = portrait ? 720 : 1040;
  let svg = '';
  if (r.rows.length) {
    const inst = echarts.init(null as never, undefined, { renderer: 'svg', ssr: true, width, height: c.height });
    try {
      inst.setOption(option as echarts.EChartsOption);
      svg = inst.renderToSVGString();
    } finally {
      inst.dispose();
    }
  }
  return { type: 'chart', id: c.id, title, height: c.height, option, svg, empty: r.rows.length ? undefined : 'No data for the selected parameters.' };
}
