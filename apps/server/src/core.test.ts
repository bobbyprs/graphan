import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly, classify, stripSql } from './connectors/sql-guard';
import { compileExpression } from './modules/queries/expression';
import { applyTransforms } from './modules/queries/transforms';
import { buildQuery } from './connectors/query-builder';
import { parseTimeExpr } from './lib/time';
import type { Connector } from './connectors/types';

test('sql-guard: allows plain reads', () => {
  for (const q of ['SELECT 1', 'select * from t;', 'WITH x AS (SELECT 1) SELECT * FROM x', "SELECT 'DROP TABLE x' AS s", 'EXPLAIN SELECT 1', '-- DELETE\nSELECT 1']) {
    assert.equal(assertReadOnly(q).ok, true, q);
  }
});

test('sql-guard: blocks writes, multi-statements and tricks', () => {
  for (const q of [
    'DELETE FROM t',
    'SELECT 1; DROP TABLE t',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT * INTO new_t FROM t',
    'EXPLAIN ANALYZE DELETE FROM t',
    'UPDATE t SET a=1',
    'SELECT 1 /* */; TRUNCATE t',
    'SELECT * FROM t FOR UPDATE',
    '',
  ]) {
    assert.equal(assertReadOnly(q).ok, false, q);
  }
});

test('sql-guard: strips literals and dollar quotes', () => {
  assert.ok(!stripSql("SELECT $$DELETE$$, 'UPDATE'").includes('DELETE'));
  assert.equal(classify('SELECT 1').isSelectLike, true);
  assert.equal(classify('SHOW TABLES').isSelectLike, false);
});

test('expression: arithmetic, functions, safety', () => {
  const row = { revenue: 200, orders: 4, name: 'x', 'unit price': 3 };
  assert.equal(compileExpression('revenue / orders').evaluate(row), 50);
  assert.equal(compileExpression('round(revenue / 3, 2)').evaluate(row), 66.67);
  assert.equal(compileExpression('if(orders > 3, 1, 0)').evaluate(row), 1);
  assert.equal(compileExpression('[unit price] * 2').evaluate(row), 6);
  assert.equal(compileExpression('safediv(revenue, 0)').evaluate(row), null);
  assert.equal(compileExpression('2 ^ 3 ^ 2').evaluate(row), 512);
  assert.equal(compileExpression('-orders + 1').evaluate(row), -3);
  assert.throws(() => compileExpression('constructor.constructor("x")()'));
  assert.throws(() => compileExpression('process.exit(1)'));
});

test('transforms: filter → calc → group → sort', () => {
  const r = applyTransforms(
    {
      columns: [{ name: 'cat', type: 'string' }, { name: 'v', type: 'number' }],
      rows: [
        { cat: 'a', v: 1 },
        { cat: 'a', v: 3 },
        { cat: 'b', v: 10 },
        { cat: 'c', v: 0 },
      ],
      rowCount: 4,
      truncated: false,
      durationMs: 1,
    },
    {
      filters: [{ field: 'v', op: 'gt', value: 0 }],
      calculatedFields: [{ name: 'v2', expression: 'v * 2' }],
      groupBy: { fields: ['cat'], aggregations: [{ field: 'v2', fn: 'sum', as: 'total' }] },
      sort: [{ field: 'total', dir: 'desc' }],
    },
  );
  assert.deepEqual(r.rows, [
    { cat: 'b', total: 20 },
    { cat: 'a', total: 8 },
  ]);
});

test('transforms: pivot reshapes long → wide and aggregates', () => {
  const r = applyTransforms(
    {
      columns: [{ name: 'month', type: 'string' }, { name: 'region', type: 'string' }, { name: 'sales', type: 'number' }],
      rows: [
        { month: 'Jan', region: 'East', sales: 10 },
        { month: 'Jan', region: 'West', sales: 5 },
        { month: 'Jan', region: 'East', sales: 2 },
        { month: 'Feb', region: 'West', sales: 7 },
      ],
      rowCount: 4,
      truncated: false,
      durationMs: 1,
    },
    { pivot: { rowField: 'month', columnField: 'region', valueField: 'sales', agg: 'sum' } },
  );
  assert.deepEqual(r.columns.map((c) => c.name), ['month', 'East', 'West']);
  assert.deepEqual(r.rows, [
    { month: 'Jan', East: 12, West: 5 },
    { month: 'Feb', East: null, West: 7 },
  ]);
});

test('transforms: rename maps, drops and reorders columns', () => {
  const r = applyTransforms(
    {
      columns: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'c', type: 'number' }],
      rows: [{ a: 1, b: 2, c: 3 }],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    },
    { rename: { map: { a: 'Alpha' }, drop: ['b'], order: ['c', 'a'] } },
  );
  assert.deepEqual(r.columns.map((c) => c.name), ['c', 'Alpha']);
  assert.deepEqual(r.rows, [{ c: 3, Alpha: 1 }]);
});

const fakePg = {
  dialect: 'postgres',
  placeholder: (i: number) => `$${i}`,
  timeGroupExpr: (c: string, s: number) => `bucket(${c},${s})`,
} as unknown as Connector;

test('query-builder: macros and variables become bound parameters', () => {
  const from = new Date('2024-01-01T00:00:00Z');
  const to = new Date('2024-01-02T00:00:00Z');
  const b = buildQuery(fakePg, 'SELECT $__timeGroup(ts, 1h) t FROM x WHERE $__timeFilter(ts) AND region IN ${region} AND name = $name', {
    timeRange: { from, to },
    variables: { region: ['EU', "x'); DROP TABLE y;--"], name: 'bob' },
  });
  assert.equal(b.text, 'SELECT bucket(ts,3600) t FROM x WHERE ts BETWEEN $1 AND $2 AND region IN ($3, $4) AND name = $5');
  assert.deepEqual(b.params, [from, to, 'EU', "x'); DROP TABLE y;--", 'bob']);
});

test('query-builder: unknown $tokens are left untouched', () => {
  const b = buildQuery(fakePg, 'SELECT $1, $unknown', { variables: {} });
  assert.equal(b.text, 'SELECT $1, $unknown');
});

test('time: relative expressions', () => {
  const now = new Date('2024-05-15T12:34:56Z');
  assert.equal(parseTimeExpr('now-6h', false, now).toISOString(), '2024-05-15T06:34:56.000Z');
  assert.equal(parseTimeExpr('now/d', false, now).toISOString(), '2024-05-15T00:00:00.000Z');
  assert.equal(parseTimeExpr('now-1d/d', true, now).toISOString(), '2024-05-14T23:59:59.999Z');
  assert.throws(() => parseTimeExpr('now-6x', false, now));
});
