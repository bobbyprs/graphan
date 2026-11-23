import type { DashboardDefinition } from './dashboard.schema';

/** Placeholder replaced with the chosen data source id when a template is instantiated. */
export const DS = '__DATASOURCE__';

export interface DashboardTemplate {
  id: string;
  title: string;
  description: string;
  tags: string[];
  refreshInterval?: string;
  /** Data source type the queries were written for */
  dataSourceType: 'POSTGRES' | 'ANY';
  /** Tables the template queries need; checked before the dashboard is created */
  requiredTables?: string[];
  definition: DashboardDefinition;
}

const salesFilter = `o.created_at BETWEEN $__timeFrom AND $__timeTo AND r.name IN \${region} AND p.category IN \${category}`;
const salesFrom = `FROM orders o JOIN regions r ON r.id = o.region_id JOIN products p ON p.id = o.product_id`;

const salesOverview: DashboardTemplate = {
  id: 'sales-overview',
  requiredTables: ['orders', 'regions', 'products', 'customers'],
  title: 'Sales Overview',
  description: 'Revenue, orders and customer KPIs with regional and category drill-down.',
  tags: ['sales', 'sample'],
  refreshInterval: '1m',
  dataSourceType: 'POSTGRES',
  definition: {
    time: { from: 'now-30d', to: 'now' },
    timezone: 'browser',
    graphTooltip: 'shared',
    variables: [
      { name: 'region', label: 'Region', type: 'query', dataSourceId: DS, query: 'SELECT name FROM regions ORDER BY 1', multi: true, includeAll: true, default: ['$__all'] },
      { name: 'category', label: 'Category', type: 'query', dataSourceId: DS, query: 'SELECT DISTINCT category FROM products ORDER BY 1', multi: true, includeAll: true, default: ['$__all'] },
    ],
    panels: [
      {
        id: 'kpi-revenue', title: 'Revenue', type: 'kpi', gridPos: { x: 0, y: 0, w: 6, h: 4 }, dataSourceId: DS,
        query: `SELECT COALESCE(SUM(o.amount),0) AS value ${salesFrom} WHERE ${salesFilter}`,
        options: { valueField: 'value', unit: 'currency', decimals: 0, color: '#73BF69', sparkline: false },
      },
      {
        id: 'kpi-orders', title: 'Orders', type: 'kpi', gridPos: { x: 6, y: 0, w: 6, h: 4 }, dataSourceId: DS,
        query: `SELECT COUNT(*) AS value ${salesFrom} WHERE ${salesFilter}`,
        options: { valueField: 'value', unit: 'short', decimals: 0, color: '#5794F2' },
      },
      {
        id: 'kpi-aov', title: 'Avg Order Value', type: 'kpi', gridPos: { x: 12, y: 0, w: 6, h: 4 }, dataSourceId: DS,
        query: `SELECT SUM(o.amount) AS revenue, COUNT(*) AS orders ${salesFrom} WHERE ${salesFilter}`,
        transforms: { calculatedFields: [{ name: 'aov', expression: 'safediv(revenue, orders)' }] },
        options: { valueField: 'aov', unit: 'currency', decimals: 2, color: '#FF9830' },
      },
      {
        id: 'kpi-fulfilment', title: 'Fulfilment Rate', type: 'gauge', gridPos: { x: 18, y: 0, w: 6, h: 4 }, dataSourceId: DS,
        query: `SELECT 100.0 * SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0) AS value ${salesFrom} WHERE ${salesFilter}`,
        options: { valueField: 'value', min: 0, max: 100, unit: 'percent', thresholds: [{ value: 0, color: '#F2495C' }, { value: 70, color: '#FF9830' }, { value: 85, color: '#73BF69' }] },
      },
      {
        id: 'ts-revenue', title: 'Revenue & Orders over time', type: 'line', gridPos: { x: 0, y: 4, w: 16, h: 9 }, dataSourceId: DS,
        query: `SELECT $__timeGroup(o.created_at, auto) AS time, SUM(o.amount) AS revenue, COUNT(*) AS orders\n${salesFrom}\nWHERE ${salesFilter}\nGROUP BY 1 ORDER BY 1`,
        options: { xField: 'time', yFields: ['revenue', 'orders'], rightAxisFields: ['orders'], smooth: true, unit: 'currency' },
      },
      {
        id: 'pie-status', title: 'Orders by status', type: 'pie', gridPos: { x: 16, y: 4, w: 8, h: 9 }, dataSourceId: DS,
        query: `SELECT o.status AS label, COUNT(*) AS value ${salesFrom} WHERE ${salesFilter} GROUP BY 1 ORDER BY 2 DESC`,
        options: { labelField: 'label', valueField: 'value', donut: true },
      },
      {
        id: 'bar-category', title: 'Revenue by category (click to drill down)', type: 'bar', gridPos: { x: 0, y: 13, w: 12, h: 9 }, dataSourceId: DS,
        query: `SELECT p.category, SUM(o.amount) AS revenue ${salesFrom} WHERE ${salesFilter} GROUP BY 1 ORDER BY 2 DESC`,
        options: { xField: 'category', yFields: ['revenue'], horizontal: false, unit: 'currency' },
        drilldown: { field: 'category', variable: 'category' },
      },
      {
        id: 'map-region', title: 'Revenue by region', type: 'geomap', gridPos: { x: 12, y: 13, w: 12, h: 9 }, dataSourceId: DS,
        query: `SELECT r.name, r.lat, r.lon, SUM(o.amount) AS revenue ${salesFrom} WHERE ${salesFilter} GROUP BY r.name, r.lat, r.lon`,
        options: { latField: 'lat', lonField: 'lon', valueField: 'revenue', labelField: 'name' },
        drilldown: { field: 'name', variable: 'region' },
      },
      {
        id: 'treemap-products', title: 'Revenue by category / product', type: 'treemap', gridPos: { x: 0, y: 22, w: 12, h: 10 }, dataSourceId: DS,
        query: `SELECT p.category, p.name AS product, SUM(o.amount) AS revenue ${salesFrom} WHERE ${salesFilter} GROUP BY 1, 2`,
        options: { groupFields: ['category', 'product'], valueField: 'revenue' },
      },
      {
        id: 'table-customers', title: 'Top customers', type: 'table', gridPos: { x: 12, y: 22, w: 12, h: 10 }, dataSourceId: DS,
        query: `SELECT c.name AS customer, c.segment, r.name AS region, COUNT(*) AS orders, SUM(o.amount) AS revenue\n${salesFrom} JOIN customers c ON c.id = o.customer_id\nWHERE ${salesFilter}\nGROUP BY 1,2,3 ORDER BY revenue DESC LIMIT 100`,
        transforms: { calculatedFields: [{ name: 'avg_order', expression: 'round(revenue / orders, 2)' }] },
        options: { pageSize: 20 },
      },
    ],
  },
};

const opsMonitor: DashboardTemplate = {
  id: 'operations-monitor',
  requiredTables: ['server_metrics'],
  title: 'Operations Monitor',
  description: 'Infrastructure health: CPU, memory, latency and error heat map.',
  tags: ['ops', 'sample'],
  refreshInterval: '30s',
  dataSourceType: 'POSTGRES',
  definition: {
    time: { from: 'now-24h', to: 'now' },
    timezone: 'browser',
    graphTooltip: 'shared',
    variables: [
      { name: 'host', label: 'Host', type: 'query', dataSourceId: DS, query: 'SELECT DISTINCT host FROM server_metrics ORDER BY 1', multi: true, includeAll: true, default: ['$__all'] },
    ],
    panels: [
      {
        id: 'g-cpu', title: 'Avg CPU %', type: 'gauge', gridPos: { x: 0, y: 0, w: 6, h: 6 }, dataSourceId: DS,
        query: `SELECT AVG(cpu) AS value FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host}`,
        options: { valueField: 'value', min: 0, max: 100, unit: 'percent', thresholds: [{ value: 0, color: '#73BF69' }, { value: 70, color: '#FF9830' }, { value: 90, color: '#F2495C' }] },
      },
      {
        id: 'g-mem', title: 'Avg Memory %', type: 'gauge', gridPos: { x: 6, y: 0, w: 6, h: 6 }, dataSourceId: DS,
        query: `SELECT AVG(memory) AS value FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host}`,
        options: { valueField: 'value', min: 0, max: 100, unit: 'percent', thresholds: [{ value: 0, color: '#73BF69' }, { value: 75, color: '#FF9830' }, { value: 90, color: '#F2495C' }] },
      },
      {
        id: 'k-errors', title: 'Errors', type: 'kpi', gridPos: { x: 12, y: 0, w: 6, h: 6 }, dataSourceId: DS,
        query: `SELECT $__timeGroup(ts, 1h) AS time, SUM(errors) AS value FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host} GROUP BY 1 ORDER BY 1`,
        options: { valueField: 'value', reducer: 'sum', sparkline: true, xField: 'time', unit: 'short', color: '#F2495C' },
      },
      {
        id: 'k-latency', title: 'p95 Latency', type: 'kpi', gridPos: { x: 18, y: 0, w: 6, h: 6 }, dataSourceId: DS,
        query: `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS value FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host}`,
        options: { valueField: 'value', unit: 'ms', decimals: 1, thresholds: [{ value: 0, color: '#73BF69' }, { value: 250, color: '#FF9830' }, { value: 400, color: '#F2495C' }] },
      },
      {
        id: 'a-cpu', title: 'CPU by host', type: 'area', gridPos: { x: 0, y: 6, w: 12, h: 9 }, dataSourceId: DS,
        query: `SELECT $__timeGroup(ts, auto) AS time, host, AVG(cpu) AS cpu FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host} GROUP BY 1, 2 ORDER BY 1`,
        options: { xField: 'time', yFields: ['cpu'], seriesField: 'host', stacked: false, unit: 'percent' },
      },
      {
        id: 'h-errors', title: 'Errors heat map (host × hour)', type: 'heatmap', gridPos: { x: 12, y: 6, w: 12, h: 9 }, dataSourceId: DS,
        query: `SELECT to_char($__timeGroup(ts, 1h), 'MM-DD HH24:00') AS hour, host, SUM(errors) AS errors FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host} GROUP BY 1, 2 ORDER BY 1`,
        options: { xField: 'hour', yField: 'host', valueField: 'errors' },
      },
      {
        id: 's-latency', title: 'Latency vs CPU', type: 'scatter', gridPos: { x: 0, y: 15, w: 12, h: 9 }, dataSourceId: DS,
        query: `SELECT cpu, latency_ms, host FROM server_metrics WHERE $__timeFilter(ts) AND host IN \${host} ORDER BY random() LIMIT 2000`,
        options: { xField: 'cpu', yField: 'latency_ms', seriesField: 'host' },
      },
      {
        id: 'notes', title: 'About', type: 'text', gridPos: { x: 12, y: 15, w: 12, h: 9 },
        options: {
          content:
            '### Operations Monitor\nThis sample dashboard reads from the `server_metrics` table.\n\n- Variables: **host** (multi-select)\n- Auto-refresh: **30s** (live via WebSocket)\n- Try creating an alert: *Avg CPU > 80 for 5m*.',
        },
      },
    ],
  },
};

const blank: DashboardTemplate = {
  id: 'blank',
  title: 'Blank dashboard',
  description: 'Start from an empty canvas.',
  tags: [],
  dataSourceType: 'ANY',
  definition: { time: { from: 'now-6h', to: 'now' }, timezone: 'browser', graphTooltip: 'shared', variables: [], panels: [] },
};

export const BUILTIN_TEMPLATES: DashboardTemplate[] = [salesOverview, opsMonitor, blank];

/** Deep-replaces the data source placeholder. */
export function instantiateTemplate(def: DashboardDefinition, dataSourceId: string | null): DashboardDefinition {
  const json = JSON.stringify(def);
  const replaced = dataSourceId ? json.split(`"${DS}"`).join(JSON.stringify(dataSourceId)) : json.split(`"${DS}"`).join('null');
  return JSON.parse(replaced) as DashboardDefinition;
}
