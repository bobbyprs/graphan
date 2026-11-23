import type { Connector, TableDetails } from '../connectors/types';
import { profileColumns, type ColumnProfile } from './preprocess';

type Row = Record<string, unknown>;

/** A dashboard definition (validated by dashboardDefinitionSchema when it is saved). */
export interface SuggestedDashboard {
  title: string;
  description: string;
  definition: {
    panels: Record<string, unknown>[];
    variables: Record<string, unknown>[];
    time: { from: string; to: string };
    timezone: string;
    graphTooltip: 'shared';
  };
  insights: string[];
}

const TIME_NAME = /(created|updated|date|time|ts|timestamp|_at|day|month|period)$/i;
const MEASURE_HINT = /(amount|revenue|price|total|sales|cost|qty|quantity|count|value|score|latency|duration|cpu|memory|bytes|errors|profit)/i;

const pid = (() => {
  let n = 0;
  return () => `auto-${++n}`;
})();

/**
 * Builds a ready-to-use dashboard from a table's schema and a sample of its rows:
 * headline KPIs with sparklines, a forecast + anomaly chart, category breakdowns,
 * a dimension filter variable with drill-down, and a latest-rows table.
 */
export function suggestDashboard(connector: Connector, dataSourceId: string, details: TableDetails, sample: Row[]): SuggestedDashboard {
  const q = (s: string) => connector.quoteIdent(s);
  const table = connector.dialect === 'sqlite' && (details.schema === 'main' || !details.schema) ? q(details.name) : `${q(details.schema)}.${q(details.name)}`;
  const keyCols = new Set([...details.columns.filter((c) => c.isPrimaryKey).map((c) => c.name), ...details.foreignKeys.flatMap((f) => f.columns)]);
  const profiles = profileColumns(
    sample,
    details.columns.map((c) => c.name),
  );
  const byName = new Map(profiles.map((p) => [p.name, p]));

  const timeCol = pickTime(profiles, details);
  const measures = profiles
    .filter((p) => p.kind === 'numeric' && !keyCols.has(p.name) && p.distinct > 1)
    .sort((a, b) => Number(MEASURE_HINT.test(b.name)) - Number(MEASURE_HINT.test(a.name)) || (b.stats?.std ?? 0) - (a.stats?.std ?? 0))
    .slice(0, 3)
    .map((p) => p.name);
  const dims = profiles
    .filter((p) => (p.kind === 'categorical' || p.kind === 'boolean') && p.distinct >= 2 && p.distinct <= 60 && !keyCols.has(p.name))
    .sort((a, b) => a.distinct - b.distinct)
    .slice(0, 2)
    .map((p) => p.name);

  const dimVar = dims[0] ? safeVarName(dims[0]) : null;
  const where = (extra: string[] = []) => {
    const conds = [...(timeCol ? [`$__timeFilter(${q(timeCol)})`] : []), ...(dimVar ? [`${q(dims[0])} IN \${${dimVar}}`] : []), ...extra];
    return conds.length ? `\nWHERE ${conds.join('\n  AND ')}` : '';
  };
  const tg = timeCol ? `$__timeGroup(${q(timeCol)}, auto)` : '';
  const insights: string[] = [];
  const panels: Record<string, unknown>[] = [];
  let y = 0;

  // ── Row 1: KPIs ──
  const kpis: { title: string; expr: string; unit?: string }[] = [{ title: 'Rows', expr: 'COUNT(*)', unit: 'short' }];
  for (const m of measures) kpis.push({ title: `Total ${humanize(m)}`, expr: `SUM(${q(m)})`, unit: unitFor(m) });
  const kw = Math.floor(24 / kpis.length);
  kpis.forEach((k, i) => {
    panels.push({
      id: pid(),
      title: k.title,
      type: 'kpi',
      gridPos: { x: i * kw, y, w: i === kpis.length - 1 ? 24 - i * kw : kw, h: 4 },
      dataSourceId,
      query: timeCol ? `SELECT ${tg} AS time, ${k.expr} AS value\nFROM ${table}${where()}\nGROUP BY ${tg}\nORDER BY 1` : `SELECT ${k.expr} AS value\nFROM ${table}${where()}`,
      options: { reducer: timeCol ? 'sum' : 'last', sparkline: !!timeCol, unit: k.unit },
      transforms: timeCol ? { forecast: forecastCfg(['value'], false) } : undefined,
    });
  });
  y += 4;

  // ── Row 2: trend with forecast + anomaly detection, and the main breakdown ──
  if (timeCol) {
    const m = measures[0];
    const expr = m ? `SUM(${q(m)})` : 'COUNT(*)';
    const alias = m ? m : 'rows';
    panels.push({
      id: pid(),
      title: `${humanize(alias)} over time · forecast`,
      description: 'Auto-selected forecasting model with a 95% prediction interval; red markers are statistically unusual points.',
      type: 'line',
      gridPos: { x: 0, y, w: dims[0] ? 16 : 24, h: 9 },
      dataSourceId,
      query: `SELECT ${tg} AS time, ${expr} AS ${q(alias)}\nFROM ${table}${where()}\nGROUP BY ${tg}\nORDER BY 1`,
      options: { unit: m ? unitFor(m) : 'short' },
      transforms: { forecast: forecastCfg([alias], true) },
    });
    insights.push(`Forecasting ${humanize(alias)} by ${humanize(timeCol)} with automatic model selection and anomaly detection.`);
  }
  if (dims[0]) {
    panels.push({
      id: pid(),
      title: `Share by ${humanize(dims[0])}`,
      type: 'pie',
      gridPos: { x: timeCol ? 16 : 0, y, w: timeCol ? 8 : 12, h: 9 },
      dataSourceId,
      query: `SELECT ${q(dims[0])} AS label, ${measures[0] ? `SUM(${q(measures[0])})` : 'COUNT(*)'} AS value\nFROM ${table}${where()}\nGROUP BY ${q(dims[0])}\nORDER BY 2 DESC`,
      transforms: { limit: 12 },
      options: { donut: true, labelField: 'label', valueField: 'value', unit: measures[0] ? unitFor(measures[0]) : 'short' },
      drilldown: dimVar ? { field: 'label', variable: dimVar } : undefined,
    });
  }
  y += 9;

  // ── Row 3: second breakdown + measure relationship ──
  const breakdownDim = dims[1] ?? dims[0];
  if (breakdownDim) {
    const m = measures[0];
    panels.push({
      id: pid(),
      title: `${m ? humanize(m) : 'Rows'} by ${humanize(breakdownDim)}`,
      type: 'bar',
      gridPos: { x: 0, y, w: 12, h: 8 },
      dataSourceId,
      query: `SELECT ${q(breakdownDim)} AS ${q(breakdownDim)}, ${m ? `SUM(${q(m)})` : 'COUNT(*)'} AS value\nFROM ${table}${where()}\nGROUP BY ${q(breakdownDim)}\nORDER BY 2 DESC`,
      transforms: { limit: 15 },
      options: { horizontal: true, xField: breakdownDim, yFields: ['value'], showLegend: false, unit: m ? unitFor(m) : 'short' },
    });
  }
  if (measures.length >= 2) {
    panels.push({
      id: pid(),
      title: `${humanize(measures[0])} vs ${humanize(measures[1])}`,
      type: 'scatter',
      gridPos: { x: breakdownDim ? 12 : 0, y, w: breakdownDim ? 12 : 24, h: 8 },
      dataSourceId,
      query: limitQuery(connector, `SELECT ${q(measures[1])} AS ${q(measures[1])}, ${q(measures[0])} AS ${q(measures[0])}${dims[0] ? `, ${q(dims[0])} AS ${q(dims[0])}` : ''}\nFROM ${table}${where()}`, 2000),
      options: { xField: measures[1], yField: measures[0], seriesField: dims[0] },
    });
    insights.push(`Try ML Studio → Regression to predict ${humanize(measures[0])} from the other columns.`);
  } else if (timeCol && measures[0] && breakdownDim) {
    panels.push({
      id: pid(),
      title: `${humanize(measures[0])} by ${humanize(breakdownDim)} over time`,
      type: 'area',
      gridPos: { x: 12, y, w: 12, h: 8 },
      dataSourceId,
      query: `SELECT ${tg} AS time, ${q(breakdownDim)} AS series, SUM(${q(measures[0])}) AS value\nFROM ${table}${where()}\nGROUP BY ${tg}, ${q(breakdownDim)}\nORDER BY 1`,
      options: { seriesField: 'series', stacked: true, unit: unitFor(measures[0]) },
    });
  }
  if (breakdownDim || measures.length >= 2) y += 8;

  // ── Row 4: latest rows ──
  panels.push({
    id: pid(),
    title: timeCol ? 'Latest rows' : 'Sample rows',
    type: 'table',
    gridPos: { x: 0, y, w: 24, h: 9 },
    dataSourceId,
    query: limitQuery(connector, `SELECT * FROM ${table}${where()}${timeCol ? `\nORDER BY ${q(timeCol)} DESC` : ''}`, 200),
    options: { pageSize: 20 },
  });

  const variables: Record<string, unknown>[] = dimVar
    ? [
        {
          name: dimVar,
          label: humanize(dims[0]),
          type: 'query',
          dataSourceId,
          query: `SELECT DISTINCT ${q(dims[0])} FROM ${table} WHERE ${q(dims[0])} IS NOT NULL ORDER BY 1`,
          multi: true,
          includeAll: true,
          default: ['$__all'],
        },
      ]
    : [];

  // Time range wide enough to cover the data
  let from = 'now-30d';
  const range = timeCol ? byName.get(timeCol)?.range : undefined;
  if (range) {
    const days = Math.ceil((Date.now() - Date.parse(range.from)) / 864e5);
    from = days <= 1 ? 'now-24h' : days <= 7 ? 'now-7d' : days <= 30 ? 'now-30d' : days <= 90 ? 'now-90d' : days <= 180 ? 'now-180d' : days <= 365 ? 'now-1y' : `now-${Math.min(days, 3650)}d`;
    insights.push(`Data spans ${new Date(range.from).toLocaleDateString()} – ${new Date(range.to).toLocaleDateString()}.`);
  }
  if (!timeCol) insights.push('No date/time column found — forecasting panels were skipped.');
  if (!measures.length) insights.push('No numeric measures found — panels count rows instead.');

  return {
    title: `${humanize(details.name)} overview`,
    description: `Generated from ${details.schema ? `${details.schema}.` : ''}${details.name} by ML Studio`,
    definition: { panels, variables, time: { from, to: 'now' }, timezone: 'browser', graphTooltip: 'shared' },
    insights,
  };
}

function pickTime(profiles: ColumnProfile[], details: TableDetails): string | undefined {
  const dt = profiles.filter((p) => p.kind === 'datetime' || (/date|time/i.test(details.columns.find((c) => c.name === p.name)?.dataType ?? '') && p.kind !== 'numeric'));
  return (dt.find((p) => TIME_NAME.test(p.name)) ?? dt[0])?.name;
}

function forecastCfg(fields: string[], anomalies: boolean) {
  return { enabled: true, fields, horizon: 24, model: 'auto', seasonality: 'auto', confidence: 0.95, anomalies, sensitivity: 'medium' };
}

function limitQuery(c: Connector, sql: string, n: number) {
  switch (c.dialect) {
    case 'mssql':
      return sql.replace(/^SELECT /, `SELECT TOP ${n} `);
    case 'oracle':
      return `${sql}\nFETCH FIRST ${n} ROWS ONLY`;
    default:
      return `${sql}\nLIMIT ${n}`;
  }
}

function safeVarName(col: string) {
  const s = col.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (s || 'dim').slice(0, 40);
}

export function humanize(s: string) {
  const t = s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function unitFor(col: string) {
  if (/(amount|revenue|price|cost|sales|profit)/i.test(col)) return 'currency';
  if (/(latency|duration)_?ms$|_ms$/i.test(col)) return 'ms';
  if (/(pct|percent|cpu|memory|ratio|rate)$/i.test(col)) return 'percent';
  if (/bytes/i.test(col)) return 'bytes';
  return 'short';
}
