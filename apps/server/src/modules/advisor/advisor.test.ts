import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TableDetails } from '../../connectors/types';
import {
  buildSuggestions,
  classifyTables,
  contributorInsight,
  datatypeMatch,
  declaredJoins,
  detectKpis,
  joinCandidates,
  pickRecommended,
  profileTable,
  qualityScore,
  scoreJoin,
  seriesInsights,
  similarity,
  stem,
  tkey,
  type RawTable,
} from './engine';
import { renderSpec, type QuerySpec, type SqlTarget } from './sql';

const pg: SqlTarget = { dialect: 'postgres', quote: (s) => `"${s}"`, timeGroup: (c, s) => `to_timestamp(floor(extract(epoch from ${c}) / ${s}) * ${s})` };
const ms: SqlTarget = { dialect: 'mssql', quote: (s) => `[${s}]`, timeGroup: (c) => c };

const col = (name: string, dataType: string, isPrimaryKey = false, ordinal = 1) => ({ name, dataType, nullable: true, isPrimaryKey, ordinal });
const details = (schema: string, name: string, columns: ReturnType<typeof col>[], fks: TableDetails['foreignKeys'] = []): TableDetails => ({
  schema,
  name,
  columns,
  indexes: [],
  foreignKeys: fks,
  referencedBy: [],
  stats: {} as TableDetails['stats'],
});

// A small shop: orders reference customers by a declared FK and products by an undeclared one
const customers: RawTable = {
  details: details('s', 'customers', [col('id', 'integer', true), col('name', 'varchar'), col('segment', 'varchar')]),
  sample: Array.from({ length: 40 }, (_v, i) => ({ id: i + 1, name: `Customer ${i + 1}`, segment: ['Retail', 'SMB', 'Enterprise'][i % 3] })),
  rowCount: 40,
};
const products: RawTable = {
  details: details('s', 'tblproductmaster', [col('product_id', 'integer', true), col('title', 'varchar'), col('category', 'varchar')]),
  sample: Array.from({ length: 30 }, (_v, i) => ({ product_id: 100 + i, title: `Product ${i}`, category: ['Phones', 'Laptops', 'Audio', 'TV'][i % 4] })),
  rowCount: 30,
};
const orders: RawTable = {
  details: details(
    's',
    'orders',
    [col('id', 'integer', true), col('customer_id', 'integer'), col('product_id', 'integer'), col('created_at', 'timestamp'), col('amount', 'numeric'), col('status', 'varchar'), col('seq', 'integer')],
    [{ name: 'fk_c', columns: ['customer_id'], refSchema: 's', refTable: 'customers', refColumns: ['id'] }],
  ),
  sample: Array.from({ length: 400 }, (_v, i) => ({
    id: i + 1,
    customer_id: (i % 40) + 1,
    product_id: 100 + (i % 30),
    created_at: new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString(),
    amount: 50 + ((i * 37) % 400),
    status: ['completed', 'completed', 'failed', 'pending'][i % 4],
    seq: i % 7,
  })),
  rowCount: 400,
  timeStats: { created_at: { min: '2025-01-01T00:00:00Z', max: '2026-02-04T00:00:00Z' } },
};
const raws = [customers, products, orders];

test('name similarity, stems and type matching', () => {
  assert.equal(stem('tblproductmaster'), 'product');
  assert.equal(stem('customers'), 'customer');
  assert.equal(stem('categories'), 'category');
  assert.equal(similarity('vehicle', 'vehicle'), 1);
  assert.ok(similarity('vehicle', 'vehicles') > 0.8);
  assert.ok(similarity('vehicle', 'invoice') < 0.5);
  assert.equal(datatypeMatch('integer', 'bigint'), 1);
  assert.equal(datatypeMatch('integer', 'numeric'), 0.7);
  assert.equal(datatypeMatch('timestamp', 'integer'), 0);
});

test('column roles: keys, time, measure, dimension, label; ordering columns are not measures', () => {
  const t = profileTable(orders, new Set());
  const role = (n: string) => t.columns.find((c) => c.name === n)!.role;
  assert.equal(role('id'), 'primaryKey');
  assert.equal(role('customer_id'), 'foreignKey');
  assert.equal(role('created_at'), 'time');
  assert.equal(role('amount'), 'measure');
  assert.equal(role('status'), 'dimension');
  assert.equal(role('seq'), 'identifier');
  assert.equal(t.timeColumn, 'created_at');
  const amount = t.columns.find((c) => c.name === 'amount')!;
  assert.equal(amount.nullPct, 0);
  assert.equal(amount.min, 50);
  assert.ok(amount.mean! > 50);
  assert.equal(profileTable(customers, new Set()).labelColumn, 'name');
});

test('join detection: declared FK = 100, inferred uses 0.3·name + 0.2·type + 0.5·overlap', () => {
  const infos = raws.map((r) => profileTable(r, new Set()));
  const declared = declaredJoins(raws);
  assert.equal(declared.length, 1);
  assert.equal(declared[0].confidence, 100);
  const cands = joinCandidates(infos, declared, new Map(raws.map((r) => [tkey(r.details.schema, r.details.name), r])));
  const c = cands.find((x) => x.leftCol.name === 'product_id' && x.right.name === 'tblproductmaster');
  assert.ok(c, 'product_id → tblproductmaster.product_id is a candidate');
  assert.equal(c!.name, 1);
  const j = scoreJoin(c!, 1);
  assert.equal(j.confidence, 100);
  assert.equal(scoreJoin(c!, 0.5).confidence, 75, 'half overlap falls below the 80% bar');
  assert.ok(!cands.some((x) => x.leftCol.name === 'amount'), 'measures are never join keys');
});

test('KPIs, suggestions with joins, recommended set and quality score', () => {
  let infos = raws.map((r) => profileTable(r, new Set()));
  const declared = declaredJoins(raws);
  const map = new Map(raws.map((r) => [tkey(r.details.schema, r.details.name), r]));
  const inferred = joinCandidates(infos, declared, map).map((c) => scoreJoin(c, 1)).filter((j) => j.confidence > 80);
  const joins = [...declared, ...inferred];
  infos = raws.map((r) => profileTable(r, new Set(inferred.filter((j) => j.left.table === r.details.name).map((j) => j.left.column))));
  classifyTables(infos, joins);
  assert.equal(infos.find((t) => t.name === 'orders')!.kind, 'fact');
  const kpis = detectKpis(infos, joins);
  const revenue = kpis.find((k) => k.column === 'amount')!;
  assert.equal(revenue.category, 'revenue');
  assert.ok(revenue.score >= 80, `amount KPI score ${revenue.score}`);
  assert.ok(kpis.some((k) => k.category === 'rate' && k.column === 'status'), 'completed/failed → success rate');

  const sugs = buildSuggestions(infos, joins, kpis, new Map());
  const bySegment = sugs.find((s) => s.dimension?.col === 'segment');
  assert.ok(bySegment, 'breakdown by a column of the joined customers table');
  assert.equal(bySegment!.spec.joins[0].table.table, 'customers');
  assert.ok(sugs.some((s) => s.dimension?.col === 'category' && s.spec.joins.some((j) => j.table.table === 'tblproductmaster')), 'inferred join is used');
  const rec = pickRecommended(sugs);
  assert.ok(rec.some((s) => s.kind === 'kpi') && rec.some((s) => s.kind === 'trend') && rec.some((s) => s.joinIds.length), 'balanced pick');
  const q = qualityScore(rec, { anyTime: true, anyJoins: true, filter: true, target: 'dashboard' });
  assert.ok(q.score >= 75, `quality ${q.score}`);
  const poor = qualityScore([sugs.find((s) => s.kind === 'kpi')!], { anyTime: true, anyJoins: true, filter: false, target: 'dashboard' });
  assert.ok(poor.score < 50 && poor.parts.some((p) => p.tip), 'single KPI scores low with tips');
});

test('SQL rendering: dashboard macros, report parameters, dialects, filter', () => {
  const spec: QuerySpec = {
    base: { schema: 's', table: 'orders' },
    joins: [{ fromAlias: 't0', fromColumn: 'customer_id', table: { schema: 's', table: 'customers' }, alias: 'j1', column: 'id', joinId: 'j' }],
    select: [{ kind: 'col', alias: 'j1', col: 'segment', as: 'label' }, { kind: 'agg', fn: 'sum', alias: 't0', col: 'amount', as: 'value' }],
    time: { alias: 't0', col: 'created_at' },
    group: true,
    orderBy: [{ as: 'value', dir: 'desc' }],
    limit: 25,
    notNull: [{ alias: 'j1', col: 'segment', text: true }],
  };
  const dash = renderSpec(pg, spec, { mode: 'dashboard' }, { alias: 'j1', col: 'segment', name: 'segment' });
  assert.match(dash, /LEFT JOIN "s"\."customers" j1 ON j1\."id" = t0\."customer_id"/);
  assert.match(dash, /\$__timeFilter\(t0\."created_at"\)/);
  assert.match(dash, /j1\."segment" IN \$\{segment\}/);
  assert.match(dash, /j1\."segment" <> ''/);
  assert.match(dash, /GROUP BY j1\."segment"\nORDER BY 2 DESC\nLIMIT 25$/);
  const rep = renderSpec(pg, spec, { mode: 'report', unit: 'month' });
  assert.match(rep, /\$\{date_from\}::date AND t0\."created_at" < \$\{date_to\}::date \+ 1/);
  const probe = renderSpec(ms, { ...spec, select: [{ kind: 'time', alias: 't0', col: 'created_at', as: 'time' }, { kind: 'rate', alias: 't0', col: 'status', values: ["o'k"], as: 'value' }], orderBy: [{ as: 'time', dir: 'asc' }] }, { mode: 'probe', unit: 'month' });
  assert.match(probe, /^SELECT TOP 25 CONVERT\(varchar\(10\), DATEFROMPARTS\(YEAR\(t0\.\[created_at\]\), MONTH\(t0\.\[created_at\]\), 1\)/);
  assert.match(probe, /LOWER\(t0\.\[status\]\) IN \('o''k'\)/, 'literals are escaped');
  assert.doesNotMatch(probe, /\$__|\$\{/, 'probe mode has no macros or parameters');
});

test('series insights: trend, growth, outliers, seasonality; contributors', () => {
  const pts = Array.from({ length: 24 }, (_v, i) => ({ t: new Date(Date.UTC(2024, i, 1)).toISOString(), v: 100 + i * 10 + (i % 12 === 5 ? 15 : 0) }));
  pts[10].v = 900;
  const ins = seriesInsights('s.orders', 'Revenue', 'month', pts, Date.UTC(2030, 0, 1));
  const trend = ins.find((i) => i.kind === 'trend')!;
  assert.equal(trend.direction, 'up');
  assert.ok(ins.some((i) => i.kind === 'outlier' && i.detail.includes('Nov 2024')), 'spike flagged');
  assert.ok(ins.some((i) => i.kind === 'growth'));
  const seasonal = Array.from({ length: 36 }, (_v, i) => ({ t: new Date(Date.UTC(2022, i, 1)).toISOString(), v: 100 + 50 * Math.sin((2 * Math.PI * i) / 12) }));
  assert.ok(seriesInsights('t', 'Visits', 'month', seasonal, Date.UTC(2030, 0, 1)).some((i) => i.kind === 'seasonality'));
  const top = contributorInsight('t', 'Revenue', 'Region', [
    { label: 'North', value: 500 },
    { label: 'South', value: 300 },
    { label: 'East', value: 100 },
    { label: 'West', value: 60 },
    { label: 'Central', value: 40 },
  ]);
  assert.match(top!.title, /Top 3 region values make up 90% of revenue/);
});

// ───────────── Data model corrections and plain-language questions ─────────────
import { interpret, AskError, parsePhrases } from './ask';
import { applyJoinOverrides, applyKpiOverrides, applyTableOverrides, type ModelOverrides } from './model';

function shopModel(ov: ModelOverrides = {}) {
  const prof = (r: RawTable, keys: string[] = []) => applyTableOverrides(profileTable(r, new Set(keys)), r, ov);
  let infos = raws.map((r) => prof(r));
  const declared = declaredJoins(raws);
  const map = new Map(raws.map((r) => [tkey(r.details.schema, r.details.name), r]));
  const inferred = joinCandidates(infos, declared, map).map((c) => scoreJoin(c, 1)).filter((j) => j.confidence > 80);
  const joins = applyJoinOverrides([...declared, ...inferred], ov, map).joins;
  infos = raws.map((r) => prof(r, joins.filter((j) => j.source !== 'declared' && j.left.table === r.details.name).map((j) => j.left.column)));
  classifyTables(infos, joins);
  const kpis = applyKpiOverrides(detectKpis(infos, joins), ov);
  return { tables: infos, joins, kpis, now: Date.UTC(2026, 1, 4) };
}

test('data model: labels, roles, removed and manual joins, KPI renames', () => {
  const ov: ModelOverrides = {
    tables: { 's.customers': { label: 'Client', synonyms: ['buyer'] }, 's.orders': { timeColumn: null } },
    columns: { 's.orders|seq': { role: 'measure', label: 'Sequence' }, 's.customers|segment': { label: 'Market segment' } },
    joins: { remove: ['j:s.orders.product_id'] },
    kpis: { 'k:s.orders:amount': { name: 'Revenue' } },
  };
  const m = shopModel(ov);
  const orders = m.tables.find((t) => t.name === 'orders')!;
  assert.equal(orders.timeColumn, undefined, 'time column switched off');
  const seq = orders.columns.find((c) => c.name === 'seq')!;
  assert.equal(seq.role, 'measure');
  assert.equal(seq.roleConfidence, 100);
  assert.ok(!m.joins.some((j) => j.id === 'j:s.orders.product_id'), 'rejected join removed');
  assert.equal(m.kpis.find((k) => k.id === 'k:s.orders:amount')!.name, 'Revenue');
  const sugs = buildSuggestions(m.tables, m.joins, m.kpis, new Map());
  assert.ok(sugs.some((s) => s.title === 'Revenue by market segment'), sugs.map((s) => s.title).join(' | '));

  const manual = applyJoinOverrides([], { joins: { add: [{ left: { schema: 's', table: 'orders', column: 'seq' }, right: { schema: 's', table: 'customers', column: 'id' } }, { left: { schema: 's', table: 'nope', column: 'x' }, right: { schema: 's', table: 'customers', column: 'id' } }] } }, new Map(raws.map((r) => [tkey(r.details.schema, r.details.name), r])));
  assert.equal(manual.joins[0].source, 'manual');
  assert.equal(manual.joins[0].confidence, 100);
  assert.equal(manual.invalid.length, 1, 'joins to missing tables are reported');
});

test('question phrases: ranges, grain, top, rate, grouping, filters', () => {
  const now = Date.UTC(2026, 1, 4);
  const p = parsePhrases('Top 5 failed orders by customer segment and category in the last 30 days', now);
  assert.deepEqual(p.top, { n: 5, dir: 'desc', text: 'Top 5' });
  assert.equal(p.outcome, 'bad');
  assert.deepEqual(p.by, [['customer', 'segment'], ['category']]);
  assert.equal(p.range!.relative, 'now-30d');
  assert.equal(p.range!.from, '2026-01-06');
  assert.equal(parsePhrases('orders per week', now).grain, 'week');
  assert.equal(parsePhrases('order success rate', now).rate, 'good');
  const lm = parsePhrases('revenue last month', now).range!;
  assert.deepEqual([lm.from, lm.to], ['2026-01-01', '2026-02-01']);
  assert.deepEqual(parsePhrases('orders in 2025', now).range!.to, '2026-01-01');
  assert.deepEqual(parsePhrases('orders where status is pending', now).where, [{ col: ['status'], value: 'pending', negate: false }]);
});

test('questions → specs: joins, filters, measures, shapes', async () => {
  const m = shopModel();
  const ask = (q: string, lookup?: Parameters<typeof interpret>[2]) => interpret(q, m, lookup);

  const a = await ask('total amount by segment');
  assert.equal(a.suggestion.kind, 'breakdown');
  assert.deepEqual(a.suggestion.spec.select[1], { kind: 'agg', fn: 'sum', alias: 't0', col: 'amount', as: 'value' });
  assert.equal(a.suggestion.spec.joins[0].table.table, 'customers', 'segment comes from the joined customers table');
  assert.equal(a.suggestion.title, 'Total amount by customer segment');

  const f = await ask('failed orders by product category last 30 days');
  assert.equal(f.suggestion.kind, 'failures');
  assert.ok(f.suggestion.spec.joins.some((j) => j.table.table === 'tblproductmaster'), 'inferred join used');
  assert.deepEqual(f.suggestion.spec.where, [{ alias: 't0', col: 'status', values: ['completed'], negate: true }]);
  assert.equal(f.suggestion.spec.range!.relative, 'now-30d');
  const probe = renderSpec(pg, f.suggestion.spec, { mode: 'probe', unit: 'day' });
  assert.match(probe, /t0\."created_at" >= DATE '2026-01-06'/);
  assert.match(probe, /t0\."status" IS NOT NULL AND NOT \(LOWER\(t0\."status"\) IN \('completed'\)\)/);
  assert.doesNotMatch(renderSpec(pg, f.suggestion.spec, { mode: 'dashboard' }), /DATE '/, 'relative ranges follow the dashboard time picker');

  const t = await ask('orders per week');
  assert.equal(t.suggestion.kind, 'trend');
  assert.equal(t.suggestion.timeUnit, 'week');

  const r = await ask('order success rate by segment');
  assert.equal(r.suggestion.spec.select[1].kind, 'rate');
  assert.equal(r.suggestion.unit, 'percent');

  const k = await ask('how many orders for Retail');
  assert.equal(k.suggestion.kind, 'kpi');
  assert.deepEqual(k.suggestion.spec.where?.[0].values, ['retail'], 'value found in the sampled top values');

  const lookedUp: string[] = [];
  const v = await ask('orders for "Product 7"', async (ref, phrases) => {
    lookedUp.push(`${ref.table.table}.${ref.col}`);
    return ref.col === 'title' && phrases.includes('product 7') ? ['product 7'] : [];
  });
  assert.ok(lookedUp.includes('tblproductmaster.title'));
  assert.ok(v.suggestion.spec.where?.some((w) => w.col === 'title'));

  const u = await ask('unique customers per month');
  assert.deepEqual(u.suggestion.spec.select[1], { kind: 'agg', fn: 'countDistinct', alias: 't0', col: 'customer_id', as: 'value' });

  const h = await ask('orders by segment and status');
  assert.equal(h.suggestion.kind, 'heatmap');

  await assert.rejects(ask('xyzzy plugh'), (e: unknown) => e instanceof AskError && e.hints.length > 0);
});
