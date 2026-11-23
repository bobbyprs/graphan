import { randomUUID } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { Connector, DbObject, TableDetails } from '../../connectors/types';
import { poolManager } from '../../connectors/pool-manager';
import { BadRequest, AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { dataSourcesService } from '../datasources/datasources.service';
import { prisma } from '../../lib/prisma';
import { AskError, examples, interpret } from './ask';
import { applyJoinOverrides, applyKpiOverrides, applyTableOverrides, isHidden, manualKeyColumns, overrideCount, type ModelOverrides } from './model';
import { toNumber, toTime } from '../../ml/preprocess';
import {
  buildSuggestions,
  chooseUnit,
  classifyTables,
  contributorInsight,
  correlationsFor,
  declaredJoins,
  detectKpis,
  dimensionsFor,
  humanize,
  joinCandidates,
  pickRecommended,
  profileTable,
  qualityScore,
  scoreJoin,
  seriesInsights,
  tkey,
  type DimensionRef,
  type Insight,
  type JoinRec,
  type KpiRec,
  type RawTable,
  type Suggestion,
  type TableInfo,
} from './engine';
import { limitSql, renderSpec, specTables, tableSql, type FilterRef, type QuerySpec, type SqlTarget, type TimeUnit } from './sql';

const MAX_TABLES = 80;
const MAX_EXTRA_REFS = 25;
const SAMPLE_ROWS = 1000;
const EXACT_COUNT_BELOW = 5_000_000;
const PROBE_LIMIT = 50;
const Q = { maxRows: 1000, timeoutMs: 20_000 };

export interface Analysis {
  id: string;
  workspaceId: string;
  dataSourceId: string;
  dataSourceName: string;
  dialect: string;
  schemas: string[];
  createdAt: string;
  durationMs: number;
  summary: { tables: number; analysed: number; emptyTables: number; rows: number; joins: number; declaredJoins: number; inferredJoins: number; kpis: number; suggestions: number; insights: number };
  tables: TableInfo[];
  joins: JoinRec[];
  kpis: KpiRec[];
  insights: Insight[];
  suggestions: Suggestion[];
  dimensions: (DimensionRef & { uses: number })[];
  recommended: string[];
  quality: ReturnType<typeof qualityScore>;
  warnings: string[];
  /** the data model (user corrections) applied to this analysis */
  model: { overrides: ModelOverrides; corrections: number; updatedAt: string | null };
  /** example questions for the Ask box */
  examples: string[];
}

const cache = new LRUCache<string, Analysis>({ max: 30, ttl: 60 * 60_000 });
const byInput = new LRUCache<string, string>({ max: 100, ttl: 15 * 60_000 });

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const target = (c: Connector): SqlTarget => ({ dialect: c.dialect, quote: (s) => c.quoteIdent(s), timeGroup: (col, s) => c.timeGroupExpr(col, s) });

async function loadModel(workspaceId: string, dataSourceId: string) {
  const dm = await prisma.dataModel.findUnique({ where: { dataSourceId } });
  if (!dm || dm.workspaceId !== workspaceId) return { overrides: {} as ModelOverrides, updatedAt: null as Date | null };
  return { overrides: (dm.overrides ?? {}) as ModelOverrides, updatedAt: dm.updatedAt };
}

let questionSeq = 0;

export const advisorService = {
  async getModel(workspaceId: string, dataSourceId: string) {
    await dataSourcesService.get(workspaceId, dataSourceId);
    const dm = await prisma.dataModel.findUnique({ where: { dataSourceId } });
    const mine = dm?.workspaceId === workspaceId ? dm : null;
    const overrides = (mine?.overrides ?? {}) as ModelOverrides;
    return {
      dataSourceId,
      overrides,
      corrections: overrideCount(overrides),
      joins: (mine?.joins ?? []) as unknown[],
      updatedAt: mine?.updatedAt.toISOString() ?? null,
      updatedById: mine?.updatedById ?? null,
    };
  },

  async saveModel(workspaceId: string, dataSourceId: string, overrides: ModelOverrides, userId: string) {
    await dataSourcesService.get(workspaceId, dataSourceId);
    await prisma.dataModel.upsert({
      where: { dataSourceId },
      create: { workspaceId, dataSourceId, overrides: overrides as object, updatedById: userId },
      update: { overrides: overrides as object, updatedById: userId },
    });
    return this.getModel(workspaceId, dataSourceId);
  },

  /** Answers a plain-language question from the analysed model; the answer becomes a selectable suggestion. */
  async ask(workspaceId: string, analysisId: string, input: { question: string; table?: string }) {
    const a = this.get(workspaceId, analysisId);
    const ds = await dataSourcesService.get(workspaceId, a.dataSourceId);
    const c = await poolManager.get(ds);
    const t = target(c);
    const lookup = async (ref: { table: { schema: string; table: string }; col: string }, phrases: string[]) => {
      const vals = [...new Set(phrases.map((x) => x.toLowerCase()))].slice(0, 30);
      if (!vals.length) return [];
      const col = t.quote(ref.col);
      const ph = vals.map((_v, i) => c.placeholder(i + 1)).join(', ');
      try {
        const r = await c.query(`SELECT DISTINCT LOWER(${col}) AS v FROM ${tableSql(t, ref.table)} WHERE LOWER(${col}) IN (${ph})`, vals, { maxRows: 50, timeoutMs: 8_000 });
        return r.rows.map((row) => String(row.v ?? row.V ?? '').trim()).filter(Boolean);
      } catch {
        return [];
      }
    };
    let res;
    try {
      res = await interpret(input.question, { tables: a.tables, joins: a.joins, kpis: a.kpis, table: input.table }, lookup);
    } catch (e) {
      if (e instanceof AskError) return { ok: false as const, message: e.message, hints: e.hints.length ? e.hints : a.examples };
      throw e;
    }
    const s: Suggestion = { ...res.suggestion, id: `q${++questionSeq}`, question: input.question.trim() };
    const unit = s.timeUnit ?? chooseUnit(a.tables.find((x) => x.key === s.table)?.timeRange);
    const sql = renderSpec(t, s.spec, { mode: 'probe', unit });
    try {
      const r = await c.query(s.spec.limit ? sql : limitSql(c.dialect, sql, 1000), [], Q);
      s.preview = { columns: r.columns.map((x) => ({ name: x.name, type: x.type })), rows: r.rows.slice(0, 400) };
    } catch (e) {
      return { ok: false as const, message: `The query for this question failed: ${(e as Error).message}`, hints: a.examples, sql };
    }
    // Keep it in the analysis so it can be composed like any other suggestion (asking again replaces the old answer)
    a.suggestions = [s, ...a.suggestions.filter((x) => !(x.question && x.question.toLowerCase() === s.question!.toLowerCase()))];
    return { ok: true as const, suggestion: s, understood: res.understood, ignored: res.ignored, confidence: res.confidence, alternatives: res.alternatives, notes: res.notes, sql };
  },

  get(workspaceId: string, id: string) {
    const a = cache.get(id);
    if (!a || a.workspaceId !== workspaceId) throw new AppError(410, 'This analysis has expired. Run the analysis again.', 'ANALYSIS_EXPIRED');
    return a;
  },

  async analyze(workspaceId: string, input: { dataSourceId: string; schemas?: string[]; tables?: string[]; fresh?: boolean }): Promise<Analysis> {
    const ds = await dataSourcesService.get(workspaceId, input.dataSourceId);
    if (ds.type === 'MONGODB') throw BadRequest('Database analysis supports SQL data sources');
    const model = await loadModel(workspaceId, ds.id);
    const ov = model.overrides;
    const inputKey = JSON.stringify([workspaceId, ds.id, [...(input.schemas ?? [])].sort(), [...(input.tables ?? [])].sort(), model.updatedAt?.toISOString() ?? '']);
    if (!input.fresh) {
      const prev = byInput.get(inputKey);
      const hit = prev ? cache.get(prev) : undefined;
      if (hit) return hit;
    }
    const started = Date.now();
    const c = await poolManager.get(ds);
    const t = target(c);
    const warnings: string[] = [];

    // 1. Which tables
    const schemas = input.schemas?.length ? input.schemas : await c.listSchemas();
    const objects: DbObject[] = (await pool(schemas, 4, (s) => c.listObjects(s).catch(() => [] as DbObject[]))).flat();
    let tables = objects.filter((o) => (o.kind === 'table' || o.kind === 'view' || o.kind === 'materialized_view') && !isHidden(ov, tkey(o.schema, o.name)));
    if (input.tables?.length) {
      const want = new Set(input.tables);
      tables = tables.filter((o) => want.has(tkey(o.schema, o.name)) || want.has(o.name));
    }
    const total = tables.length;
    if (!total) throw BadRequest('No tables found in the selected schema(s)');
    tables.sort((a, b) => Number(b.kind === 'table') - Number(a.kind === 'table') || (b.rowEstimate ?? 0) - (a.rowEstimate ?? 0));
    if (tables.length > MAX_TABLES) {
      warnings.push(`Analysed the ${MAX_TABLES} largest of ${tables.length} tables. Choose fewer schemas to cover the rest.`);
      tables = tables.slice(0, MAX_TABLES);
    }

    // 2. Structure of every table, plus tables they reference in other schemas (for labels)
    const describe = async (schema: string, name: string): Promise<TableDetails | null> => {
      try {
        return await c.describeTable(schema, name);
      } catch (e) {
        warnings.push(`Could not read ${schema}.${name}: ${(e as Error).message}`);
        return null;
      }
    };
    const details = (await pool(tables, 6, (o) => describe(o.schema, o.name))).filter((d): d is TableDetails => !!d && d.columns.length > 0);
    const have = new Set(details.map((d) => tkey(d.schema, d.name)));
    const manualRefs = (ov.joins?.add ?? []).flatMap((j) => [tkey(j.left.schema, j.left.table), tkey(j.right.schema, j.right.table)]);
    const extra = [...new Set([...details.flatMap((d) => d.foreignKeys.map((f) => tkey(f.refSchema || d.schema, f.refTable))), ...manualRefs])]
      .filter((k) => !have.has(k) && !isHidden(ov, k))
      .slice(0, MAX_EXTRA_REFS);
    for (const d of await pool(extra, 6, (k) => describe(k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)))) if (d?.columns.length) details.push(d);
    const estimate = new Map(objects.map((o) => [tkey(o.schema, o.name), o.rowEstimate ?? null]));

    // 3. Row counts, time ranges and a sample of rows
    const raws: RawTable[] = await pool(details, 6, async (d) => {
      const key = tkey(d.schema, d.name);
      const est = estimate.get(key);
      const timeCols = d.columns.filter((col) => /(date|time)/i.test(col.dataType)).slice(0, 6);
      const tbl = tableSql(t, { schema: d.schema, table: d.name });
      const exact = est == null || est < EXACT_COUNT_BELOW;
      let rowCount = est ?? 0;
      const timeStats: RawTable['timeStats'] = {};
      try {
        const sel = [exact ? 'COUNT(*) AS n' : '1 AS n', ...timeCols.flatMap((col, i) => [`MIN(${t.quote(col.name)}) AS mn${i}`, `MAX(${t.quote(col.name)}) AS mx${i}`])];
        const r = await c.query(`SELECT ${sel.join(', ')} FROM ${tbl}`, [], { maxRows: 1, timeoutMs: 15_000 });
        const row = r.rows[0] ?? {};
        if (exact) rowCount = toNumber(row.n ?? row.N) ?? rowCount;
        timeCols.forEach((col, i) => (timeStats[col.name] = { min: row[`mn${i}`] ?? row[`MN${i}`], max: row[`mx${i}`] ?? row[`MX${i}`] }));
      } catch (e) {
        logger.debug({ err: e, table: key }, 'advisor: stats query failed');
      }
      let sample: Record<string, unknown>[] = [];
      if (rowCount > 0 || est == null) {
        try {
          sample = (await c.previewTable(d.schema, d.name, SAMPLE_ROWS, 0, { maxRows: SAMPLE_ROWS, timeoutMs: 20_000 })).rows;
        } catch (e) {
          warnings.push(`Could not sample ${key}: ${(e as Error).message}`);
        }
      }
      if (!exact && !rowCount) rowCount = sample.length;
      return { details: d, sample, rowCount: Math.max(rowCount, sample.length), timeStats };
    });
    const rawByKey = new Map(raws.map((r) => [tkey(r.details.schema, r.details.name), r]));

    // 4. Profile columns, then find joins
    const prof = (r: RawTable, keys: Iterable<string>) => {
      const k = tkey(r.details.schema, r.details.name);
      return applyTableOverrides(profileTable(r, new Set([...keys, ...manualKeyColumns(ov, k)])), r, ov);
    };
    let infos = raws.map((r) => prof(r, []));
    const declared = declaredJoins(raws).filter((j) => rawByKey.has(tkey(j.right.schema, j.right.table)));
    const candidates = joinCandidates(infos, declared, rawByKey);
    const inferred: JoinRec[] = [];
    await pool(candidates, 6, async (cand) => {
      let overlap = 0;
      try {
        const ph = cand.values.map((_v, i) => c.placeholder(i + 1)).join(', ');
        const r = await c.query(`SELECT COUNT(DISTINCT ${t.quote(cand.rightCol)}) AS n FROM ${tableSql(t, { schema: cand.right.schema, table: cand.right.name })} WHERE ${t.quote(cand.rightCol)} IN (${ph})`, cand.values, { maxRows: 1, timeoutMs: 10_000 });
        overlap = Math.min(1, (toNumber(r.rows[0]?.n ?? r.rows[0]?.N) ?? 0) / cand.values.length);
      } catch {
        overlap = 0;
      }
      const j = scoreJoin(cand, overlap);
      if (j.confidence > 80) inferred.push(j);
    });
    // One target per column: keep the most confident
    const bestInferred = new Map<string, JoinRec>();
    for (const j of inferred) if (!bestInferred.get(j.id) || bestInferred.get(j.id)!.confidence < j.confidence) bestInferred.set(j.id, j);
    const applied = applyJoinOverrides([...declared, ...[...bestInferred.values()].sort((a, b) => b.confidence - a.confidence)], ov, rawByKey);
    const joins = applied.joins;
    for (const x of applied.invalid) warnings.push(`Data model join ${x} no longer matches the database and was skipped.`);

    // Re-profile with inferred keys so they are treated as foreign keys, not measures
    const inferredCols = new Map<string, Set<string>>();
    for (const j of joins.filter((x) => x.source === 'inferred')) {
      const k = tkey(j.left.schema, j.left.table);
      inferredCols.set(k, new Set([...(inferredCols.get(k) ?? []), j.left.column]));
    }
    if (inferredCols.size) infos = raws.map((r) => prof(r, inferredCols.get(tkey(r.details.schema, r.details.name)) ?? []));
    classifyTables(infos, joins);

    // 5. KPIs and suggestions
    const kpis = applyKpiOverrides(detectKpis(infos, joins), ov);
    const correlations = new Map(infos.map((ti) => [ti.key, correlationsFor(ti, rawByKey.get(ti.key)!.sample)]));
    let suggestions = buildSuggestions(infos, joins, kpis, correlations);
    const infoByKey = new Map(infos.map((ti) => [ti.key, ti]));

    // 6. Probe the best suggestions (proves the SQL runs, gives a preview and feeds insights)
    // Best overall, plus the best few of every kind so a balanced dashboard is always possible
    const probe = [...suggestions.slice(0, PROBE_LIMIT)];
    for (const kind of ['kpi', 'trend', 'trendBy', 'breakdown', 'share', 'failures', 'heatmap', 'detail', 'relationship'] as const)
      for (const s of suggestions.filter((x) => x.kind === kind).slice(0, 4)) if (!probe.includes(s)) probe.push(s);
    const full = new Map<string, Record<string, unknown>[]>();
    await pool(probe, 4, async (s) => {
      const unit = s.timeUnit ?? chooseUnit(infoByKey.get(s.table)?.timeRange);
      try {
        const sql = renderSpec(t, s.spec, { mode: 'probe', unit });
        const r = await c.query(s.spec.limit ? sql : limitSql(c.dialect, sql, 1000), [], Q);
        full.set(s.id, r.rows);
        const keep = s.kind === 'heatmap' ? 400 : s.kind === 'relationship' ? 300 : s.kind === 'trend' || s.kind === 'trendBy' || s.kind === 'kpi' ? 400 : 40;
        s.preview = { columns: r.columns.map((x) => ({ name: x.name, type: x.type })), rows: r.rows.slice(0, keep) };
      } catch (e) {
        s.preview = undefined;
        (s as Suggestion & { error?: string }).error = (e as Error).message;
      }
    });
    const failed = probe.filter((s) => !s.preview);
    if (failed.length) logger.debug({ failed: failed.map((f) => [f.title, (f as Suggestion & { error?: string }).error]) }, 'advisor: suggestions that failed to run');
    const points = (s: Suggestion) => new Set(s.preview!.rows.map((r) => String(r.time ?? r.TIME))).size;
    suggestions = probe.filter((s) => {
      if (!s.preview || !s.preview.rows.length) return false;
      if (s.kind !== 'detail' && s.kind !== 'relationship' && s.preview.rows.every((r) => !toNumber(r[s.fields.value ?? 'value']))) return false;
      // A trend needs a few periods to say anything; a breakdown needs at least two groups
      if ((s.kind === 'trend' || s.kind === 'trendBy') && points(s) < 4) return false;
      if ((s.kind === 'breakdown' || s.kind === 'share' || s.kind === 'failures') && s.preview.rows.length < 2) return false;
      return true;
    });
    // Sparkline KPIs with too few points become plain numbers
    for (const s of suggestions)
      if (s.kind === 'kpi' && s.fields.category && points(s) < 4) {
        s.spec = { ...s.spec, select: s.spec.select.filter((x) => x.kind !== 'time'), group: false, orderBy: undefined };
        s.fields = { value: 'value' };
        const total = s.preview!.rows.reduce((acc, r) => acc + (toNumber(r.value ?? r.VALUE) ?? 0), 0);
        s.preview = { columns: [{ name: 'value', type: 'number' }], rows: [{ value: total }] };
      }
    for (const s of suggestions) delete (s as Suggestion & { error?: string }).error;

    // 7. Insights
    const insights: Insight[] = [];
    for (const s of suggestions.filter((x) => x.kind === 'trend').slice(0, 8)) {
      const info = infoByKey.get(s.table)!;
      const rows = full.get(s.id) ?? [];
      const pts = rows.map((r) => ({ t: isoOf(r.time ?? r.TIME), v: toNumber(r.value ?? r.VALUE) ?? NaN })).filter((p) => p.t);
      insights.push(...seriesInsights(info.key, s.title.replace(/ over time$/, ''), chooseUnit(info.timeRange), pts));
    }
    for (const s of suggestions.filter((x) => (x.kind === 'breakdown' || x.kind === 'share') && x.dimension).slice(0, 8)) {
      const rows = (full.get(s.id) ?? []).map((r) => ({ label: r.label ?? r.LABEL, value: r.value ?? r.VALUE }));
      const kname = kpis.find((k) => k.id === s.kpiId)?.name ?? 'rows';
      const ins = contributorInsight(s.table, kname, s.dimension!.label, rows);
      if (ins && !insights.some((i) => i.id === ins.id)) insights.push(ins);
    }
    for (const [k, list] of correlations)
      for (const cr of list.slice(0, 2))
        insights.push({
          id: `i:${k}:${cr.a}:${cr.b}:corr`,
          kind: 'correlation',
          title: `${humanize(cr.a)} and ${humanize(cr.b).toLowerCase()} move ${cr.r > 0 ? 'together' : 'in opposite directions'}`,
          detail: `Pearson r = ${cr.r.toFixed(2)} across ${Math.min(SAMPLE_ROWS, rawByKey.get(k)!.sample.length)} sampled rows of ${k}.`,
          score: Math.round(40 + Math.abs(cr.r) * 40),
          table: k,
        });
    const empty = infos.filter((i) => i.kind === 'empty');
    if (empty.length) insights.push({ id: 'i:quality:empty', kind: 'quality', title: `${empty.length} of ${infos.length} tables are empty`, detail: empty.slice(0, 8).map((e) => e.key).join(', ') + (empty.length > 8 ? ', …' : ''), score: 25, table: '' });
    const noPk = infos.filter((i) => i.notes.some((x) => x.startsWith('No primary key') || x.startsWith('No declared primary key')) && i.rowCount > 0);
    if (noPk.length) insights.push({ id: 'i:quality:nopk', kind: 'quality', title: `${noPk.length} tables have no primary key`, detail: noPk.slice(0, 8).map((e) => e.key).join(', '), score: 22, table: '' });
    const sparseCols = infos.flatMap((i) => (i.rowCount ? i.columns.filter((col) => col.nullPct >= 80 && col.role !== 'empty').map((col) => `${i.name}.${col.name}`) : []));
    if (sparseCols.length) insights.push({ id: 'i:quality:sparse', kind: 'quality', title: `${sparseCols.length} columns are at least 80% empty`, detail: sparseCols.slice(0, 10).join(', ') + (sparseCols.length > 10 ? ', …' : ''), score: 20, table: '' });
    insights.sort((a, b) => b.score - a.score);

    // 8. Recommended selection and its quality
    const rec = pickRecommended(suggestions);
    const dims = dimensionUses(suggestions);
    const anyTime = infos.some((i) => i.timeColumn && i.rowCount > 0);
    const filter = dims[0];
    const quality = qualityScore(rec, { anyTime, anyJoins: joins.length > 0, filter: !!filter, target: 'dashboard' });

    const analysis: Analysis = {
      id: randomUUID(),
      workspaceId,
      dataSourceId: ds.id,
      dataSourceName: ds.name,
      dialect: c.dialect,
      schemas,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      summary: {
        tables: total,
        analysed: infos.length,
        emptyTables: empty.length,
        rows: infos.reduce((s, i) => s + i.rowCount, 0),
        joins: joins.length,
        declaredJoins: joins.filter((j) => j.source === 'declared').length,
        inferredJoins: joins.filter((j) => j.source !== 'declared').length,
        kpis: kpis.length,
        suggestions: suggestions.length,
        insights: insights.length,
      },
      tables: infos.sort((a, b) => b.importance - a.importance),
      joins,
      kpis: kpis.slice(0, 60),
      insights: insights.slice(0, 60),
      suggestions,
      dimensions: dims,
      recommended: rec.map((s) => s.id),
      quality,
      warnings: warnings.slice(0, 20),
      model: { overrides: ov, corrections: overrideCount(ov), updatedAt: model.updatedAt?.toISOString() ?? null },
      examples: examples(infos.filter((i) => i.rowCount > 0).slice(0, 6), new Map(infos.map((i) => [i.key, i])), joins),
    };
    cache.set(analysis.id, analysis);
    byInput.set(inputKey, analysis.id);
    // Remember the joins for SQL editor completion (best effort)
    const compact = joins.map((j) => ({ left: j.left, right: j.right, confidence: j.confidence, source: j.source }));
    prisma.dataModel
      .upsert({ where: { dataSourceId: ds.id }, create: { workspaceId, dataSourceId: ds.id, joins: compact }, update: { joins: compact } })
      .catch((e) => logger.debug({ err: e }, 'advisor: could not store joins'));
    return analysis;
  },

  /** Turns chosen suggestions into a dashboard or report definition (plus its quality score). */
  async compose(workspaceId: string, analysisId: string, input: { suggestionIds: string[]; target: 'dashboard' | 'report'; title?: string; filter?: string | null }) {
    const a = this.get(workspaceId, analysisId);
    const ds = await dataSourcesService.get(workspaceId, a.dataSourceId);
    const c = await poolManager.get(ds);
    const t = target(c);
    const chosen = input.suggestionIds.map((id) => a.suggestions.find((s) => s.id === id)).filter((s): s is Suggestion => !!s);
    if (!chosen.length) throw BadRequest('Choose at least one suggestion');
    const dim = input.filter ? a.dimensions.find((d) => d.id === input.filter) : undefined;
    const byKey = new Map(a.tables.map((x) => [x.key, x]));
    const anyTime = chosen.some((s) => s.spec.time);
    const quality = qualityScore(chosen, { anyTime: a.tables.some((x) => x.timeColumn && x.rowCount > 0), anyJoins: a.joins.length > 0, filter: !!dim, target: input.target });
    const varName = dim ? safeName(dim.col) : '';

    // Each spec gets the filter when the dimension is (or can be joined) in reach of its base table
    const withFilter = (s: Suggestion): { spec: QuerySpec; filter: FilterRef | null } => {
      if (!dim) return { spec: s.spec, filter: null };
      const here = specTables(s.spec).find((x) => x.table.schema === dim.table.schema && x.table.table === dim.table.table);
      if (here) return { spec: s.spec, filter: { alias: here.alias, col: dim.col, name: varName } };
      const base = byKey.get(tkey(s.spec.base.schema, s.spec.base.table));
      const path = base ? dimensionsFor(base, byKey, a.joins).find((p) => p.dim.id === dim.id) : undefined;
      if (!path || path.joins.length > 2) return { spec: s.spec, filter: null };
      // "All" expands to the list of values, so rows without a match on the path would silently drop out:
      // only follow paths whose keys are (nearly) always filled
      const alias = new Map<string, TableInfo | undefined>([['t0', base]]);
      for (const j of path.joins) alias.set(j.alias, byKey.get(tkey(j.table.schema, j.table.table)));
      const solid = path.joins.every((j) => (alias.get(j.fromAlias)?.columns.find((c) => c.name === j.fromColumn)?.nullPct ?? 100) <= 2);
      if (!solid) return { spec: s.spec, filter: null };
      const re = new Map(path.joins.map((j, i) => [j.alias, `f${i + 1}`]));
      const joins = path.joins.map((j) => ({ ...j, alias: re.get(j.alias)!, fromAlias: re.get(j.fromAlias) ?? j.fromAlias }));
      return { spec: { ...s.spec, joins: [...s.spec.joins, ...joins] }, filter: { alias: re.get(path.alias)!, col: dim.col, name: varName } };
    };

    const title = input.title?.trim() || `${a.dataSourceName} ${input.target === 'dashboard' ? 'overview' : 'report'}`;
    const timeFrom = earliest(chosen.map((s) => byKey.get(s.table)?.timeRange?.from));
    // Questions like "last 30 days" set the dashboard range / report default when they all agree
    const rels = [...new Set(chosen.filter((s) => s.spec.time).map((s) => s.spec.range?.relative ?? ''))];
    const askedRange = rels.length === 1 && rels[0] ? rels[0] : undefined;
    const dimTable = dim ? tableSql(t, dim.table) : '';
    const dimQuery = dim ? `SELECT DISTINCT ${t.quote(dim.col)} FROM ${dimTable} WHERE ${t.quote(dim.col)} IS NOT NULL ORDER BY 1` : '';
    let filtered = 0;

    if (input.target === 'dashboard') {
      const panels: Record<string, unknown>[] = [];
      let y = 0;
      const kpis = chosen.filter((s) => s.kind === 'kpi');
      const others = chosen.filter((s) => s.kind !== 'kpi');
      const panelFor = (s: Suggestion, gridPos: { x: number; y: number; w: number; h: number }) => {
        const f = withFilter(s);
        if (f.filter) filtered++;
        const query = renderSpec(t, f.spec, { mode: 'dashboard' }, f.filter);
        const unit = s.unit;
        const p: Record<string, unknown> = { id: `adv-${s.id}`, title: s.title, description: s.description, type: s.viz, gridPos, dataSourceId: a.dataSourceId, query, options: {} };
        switch (s.kind) {
          case 'kpi':
            p.options = { reducer: s.fields.category ? 'sum' : 'last', sparkline: !!s.fields.category, unit, decimals: s.format === 'N0' || s.format === 'C0' ? 0 : undefined };
            break;
          case 'trend':
            p.options = { unit, xField: 'time', yFields: ['value'], showLegend: false, smooth: true };
            if (s.preview && s.preview.rows.length >= 8) p.transforms = { forecast: { enabled: true, fields: ['value'], horizon: 12, model: 'auto', seasonality: 'auto', confidence: 0.95, anomalies: true, sensitivity: 'medium' } };
            break;
          case 'trendBy':
            p.options = { unit, xField: 'time', yFields: ['value'], seriesField: 'series', stacked: true };
            break;
          case 'breakdown':
          case 'failures':
            p.options = { unit, xField: 'label', yFields: [s.fields.value ?? 'value'], horizontal: true, showLegend: false, color: s.kind === 'failures' ? '#E5484D' : undefined };
            break;
          case 'share':
            p.options = { unit, donut: true, labelField: 'label', valueField: 'value' };
            break;
          case 'heatmap':
            p.options = { unit, xField: 'x', yField: 'y', valueField: 'value' };
            break;
          case 'relationship':
            p.options = { xField: s.fields.x, yField: s.fields.y };
            break;
          case 'detail':
            p.options = { pageSize: 20 };
            break;
        }
        if (dim && s.dimension?.id === dim.id && (s.kind === 'breakdown' || s.kind === 'share')) p.drilldown = { field: 'label', variable: varName };
        return p;
      };
      // Row 1: KPI cards (4 per row)
      for (let i = 0; i < kpis.length; i += 4) {
        const row = kpis.slice(i, i + 4);
        const w = Math.floor(24 / row.length);
        row.forEach((s, j) => panels.push(panelFor(s, { x: j * w, y, w: j === row.length - 1 ? 24 - j * w : w, h: 4 })));
        y += 4;
      }
      // Charts two per row; trend lines get the wider slot, detail tables a full row
      const charts = others.filter((s) => s.kind !== 'detail');
      const details = others.filter((s) => s.kind === 'detail');
      for (let i = 0; i < charts.length; ) {
        const s = charts[i];
        const next = charts[i + 1];
        const h = s.kind === 'heatmap' || next?.kind === 'heatmap' ? 10 : 9;
        if (!next) {
          panels.push(panelFor(s, { x: 0, y, w: 24, h }));
          i += 1;
        } else {
          const wide = s.kind === 'trend' || s.kind === 'trendBy' ? 15 : next.kind === 'trend' || next.kind === 'trendBy' ? 9 : 12;
          panels.push(panelFor(s, { x: 0, y, w: wide, h }));
          panels.push(panelFor(next, { x: wide, y, w: 24 - wide, h }));
          i += 2;
        }
        y += h;
      }
      for (const s of details) {
        panels.push(panelFor(s, { x: 0, y, w: 24, h: 10 }));
        y += 10;
      }
      const variables = dim
        ? [{ name: varName, label: dim.label, type: 'query', dataSourceId: a.dataSourceId, query: dimQuery, multi: true, includeAll: true, default: ['$__all'] }]
        : [];
      const definition = { panels, variables, time: { from: askedRange ?? (anyTime ? relativeFrom(timeFrom) : 'now-30d'), to: 'now' }, timezone: 'browser', graphTooltip: 'shared' as const };
      return {
        target: 'dashboard' as const,
        title,
        description: `Generated by the database analyzer from ${a.dataSourceName} (${[...new Set(chosen.flatMap((s) => s.tables))].length} tables)`,
        definition,
        quality,
        notes: dim && filtered < chosen.length ? [`The ${dim.label} filter applies to ${filtered} of ${chosen.length} panels (the others have no path to it).`] : [],
      };
    }

    // ── Paginated report ──
    const parameters: Record<string, unknown>[] = [];
    if (anyTime) {
      const days = askedRange ? Number(/^now-(\d+)d$/.exec(askedRange)?.[1]) : NaN;
      parameters.push({ name: 'date_from', label: 'From', type: 'date', default: Number.isFinite(days) ? `today-${Math.max(0, days - 1)}d` : timeFrom ? timeFrom.slice(0, 10) : 'startOfYear' });
      parameters.push({ name: 'date_to', label: 'To', type: 'date', default: 'today' });
    }
    if (dim) parameters.push({ name: varName, label: dim.label, type: 'string', multi: true, options: { kind: 'query', dataSourceId: a.dataSourceId, query: dimQuery, defaultFirst: true } });
    const datasets: Record<string, unknown>[] = [];
    const body: Record<string, unknown>[] = [];
    const cards: { label: string; value: string }[] = [];
    let n = 0;
    const notes: string[] = [];
    for (const s of chosen) {
      if (s.kind === 'relationship') {
        notes.push(`"${s.title}" (scatter) is dashboard-only and was left out of the report.`);
        continue;
      }
      const name = `ds${++n}`;
      const unit: TimeUnit = s.timeUnit ?? chooseUnit(byKey.get(s.table)?.timeRange);
      let spec = s.spec;
      if (s.kind === 'kpi') spec = { ...spec, select: spec.select.filter((x) => x.kind !== 'time'), group: false, orderBy: undefined };
      // Matrix headers show field names, so give the axes readable names
      const xName = safeName(s.fields.xLabel ?? 'column').toLowerCase();
      const yName = safeName(s.fields.yLabel ?? 'row').toLowerCase();
      if (s.kind === 'heatmap') spec = { ...spec, select: spec.select.map((x) => (x.as === 'x' ? { ...x, as: xName } : x.as === 'y' ? { ...x, as: yName === xName ? `${yName}_2` : yName } : x)) };
      const f = withFilter({ ...s, spec });
      if (f.filter) filtered++;
      datasets.push({ name, dataSourceId: a.dataSourceId, query: renderSpec(t, f.spec, { mode: 'report', unit }, f.filter), calculated: [] });
      const fmt = s.format ?? 'N0';
      switch (s.kind) {
        case 'kpi':
          cards.push({ label: s.title, value: `{{First(${name}.value, ${fmt})}}${s.unit === 'percent' ? '%' : ''}` });
          break;
        case 'trend':
          body.push({ id: `i${n}`, type: 'chart', title: s.title, dataset: name, chartType: 'line', category: 'time', series: ['value'], legend: false, height: 260, format: fmt });
          break;
        case 'trendBy':
          body.push({ id: `i${n}`, type: 'chart', title: s.title, dataset: name, chartType: 'stacked', category: 'time', series: ['value'], seriesField: 'series', height: 280, format: fmt });
          break;
        case 'breakdown':
        case 'failures':
          body.push({ id: `i${n}`, type: 'chart', title: s.title, dataset: name, chartType: 'bar', category: 'label', series: [s.fields.value ?? 'value'], legend: false, labels: true, height: Math.min(520, 120 + Math.min(25, s.preview?.rows.length ?? 10) * 18), format: fmt });
          break;
        case 'share':
          body.push({ id: `i${n}`, type: 'chart', title: s.title, dataset: name, chartType: 'donut', category: 'label', series: ['value'], labels: true, height: 260, format: fmt });
          break;
        case 'heatmap':
          body.push({ id: `i${n}`, type: 'matrix', title: s.title, dataset: name, rows: [yName === xName ? `${yName}_2` : yName], column: xName, value: 'value', aggregate: 'sum', format: fmt, maxColumns: 20 });
          break;
        case 'detail': {
          const cols = s.spec.select.map((x) => {
            const info = byKey.get(s.table)?.columns.find((col) => x.kind === 'col' && x.alias === 't0' && col.name === x.col);
            const isTime = info && (info.role === 'time' || info.role === 'auditTime');
            const isNum = info?.role === 'measure';
            return { field: x.as, header: humanize(x.as), format: isTime ? 'dd-MMM-yyyy HH:mm' : isNum ? 'N2' : undefined, align: isNum ? 'right' : undefined, rules: [] };
          });
          body.push({ id: `i${n}`, type: 'table', title: s.title, dataset: name, columns: cols, groups: [], details: true, totals: false, repeatHeader: true, sort: [], zebra: true });
          break;
        }
      }
    }
    if (cards.length) body.unshift({ id: 'kpis', type: 'kpi', cards: cards.slice(0, 8) });
    body.unshift({ id: 'intro', type: 'text', text: anyTime ? 'Period: {{Parameters.date_from}} – {{Parameters.date_to}}' : `Source: ${a.dataSourceName}`, style: { italic: true } });
    const wideTable = chosen.some((s) => s.kind === 'detail' && s.spec.select.length > 6);
    const definition = {
      page: { size: 'A4', orientation: wideTable ? 'landscape' : 'portrait', margins: [15, 12, 15, 12], fontSize: 9 },
      currency: '$',
      locale: 'en-US',
      timezone: 'UTC',
      parameters,
      datasets,
      header: { left: title, center: '', right: '{{Globals.ExecutionTime}}' },
      footer: { left: '{{User.Name}}', center: '', right: 'Page {{Globals.PageNumber}} of {{Globals.TotalPages}}' },
      showTitle: true,
      showParameters: true,
      body,
    };
    if (dim && filtered < datasets.length) notes.push(`The ${dim.label} parameter applies to ${filtered} of ${datasets.length} datasets.`);
    return { target: 'report' as const, title, description: `Generated by the database analyzer from ${a.dataSourceName}`, definition, quality, notes };
  },
};

function dimensionUses(sugs: Suggestion[]) {
  const m = new Map<string, DimensionRef & { uses: number }>();
  for (const s of sugs) {
    if (!s.dimension) continue;
    const prev = m.get(s.dimension.id);
    m.set(s.dimension.id, { ...s.dimension, uses: (prev?.uses ?? 0) + 1 + (s.recommended ? 2 : 0) });
  }
  return [...m.values()].sort((a, b) => b.uses - a.uses).slice(0, 30);
}

function isoOf(v: unknown): string {
  const ms = toTime(v instanceof Date ? v : typeof v === 'string' ? v.replace(' ', 'T') : v);
  return ms === null ? '' : new Date(ms).toISOString();
}

function earliest(xs: (string | undefined)[]) {
  const ms = xs.map((x) => (x ? Date.parse(x) : NaN)).filter((x) => Number.isFinite(x));
  return ms.length ? new Date(Math.min(...ms)).toISOString() : undefined;
}

function relativeFrom(iso?: string) {
  if (!iso) return 'now-30d';
  const days = Math.ceil((Date.now() - Date.parse(iso)) / 864e5) + 1;
  return days <= 1 ? 'now-24h' : days <= 7 ? 'now-7d' : days <= 30 ? 'now-30d' : days <= 90 ? 'now-90d' : days <= 365 ? 'now-1y' : `now-${Math.min(days, 3650)}d`;
}

function safeName(col: string) {
  const s = col.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (s || 'filter').slice(0, 40);
}
