/**
 * Built-in report templates (sample sales schema). "__DS__" is replaced with the chosen data source,
 * "__REPORT_<key>__" with the id of a report created earlier in the same pack (drill-through / subreports).
 */
export interface ReportTemplate {
  id: string;
  title: string;
  description: string;
  requiredTables: string[];
  reports: { key: string; title: string; description: string; definition: unknown }[];
}

const dateFilter = `o.created_at >= \${date_from}::date AND o.created_at < \${date_to}::date + 1`;

const orderDetails = {
  key: 'details',
  title: 'Order Details',
  description: 'Every order for a region and product in a date range (drill-through target).',
  definition: {
    page: { size: 'A4', orientation: 'landscape', fontSize: 8 },
    parameters: [
      { name: 'date_from', label: 'From', type: 'date', default: 'startOfYear' },
      { name: 'date_to', label: 'To', type: 'date', default: 'today' },
      { name: 'region', label: 'Region', type: 'string', options: { kind: 'query', dataSourceId: '__DS__', query: 'SELECT name FROM regions ORDER BY 1' } },
      { name: 'product', label: 'Product', type: 'string', required: false, options: { kind: 'query', dataSourceId: '__DS__', query: 'SELECT name FROM products ORDER BY 1' } },
    ],
    datasets: [
      {
        name: 'orders',
        dataSourceId: '__DS__',
        maxRows: 20000,
        query: `SELECT o.id AS order_id, o.created_at, c.name AS customer, c.segment, p.name AS product, o.quantity, o.amount, o.status
FROM orders o
JOIN regions r ON r.id = o.region_id
JOIN products p ON p.id = o.product_id
JOIN customers c ON c.id = o.customer_id
WHERE ${dateFilter}
  AND r.name = \${region}
  AND (\${product}::text IS NULL OR p.name = \${product})
ORDER BY o.created_at DESC`,
      },
    ],
    header: { left: 'Order Details', right: '{{Parameters.region}}' },
    body: [
      {
        id: 'k',
        type: 'kpi',
        cards: [
          { label: 'Orders', value: '{{Count(orders)}}' },
          { label: 'Revenue', value: '{{Sum(orders.amount, C0)}}', color: '#3871DC' },
          { label: 'Units', value: '{{Sum(orders.quantity, N0)}}' },
          { label: 'Average order', value: '{{Avg(orders.amount, C2)}}' },
        ],
      },
      {
        id: 't',
        type: 'table',
        dataset: 'orders',
        groups: [{ field: 'status', label: 'Status: {{value}}', sort: 'asc', collapsed: false }],
        columns: [
          { field: 'created_at', header: 'Date', format: 'dd-MMM-yyyy HH:mm', width: 1.3 },
          { field: 'order_id', header: 'Order #', width: 0.8, aggregate: 'count' },
          { field: 'customer', header: 'Customer', width: 1.4 },
          { field: 'segment', header: 'Segment' },
          { field: 'product', header: 'Product', width: 1.8 },
          { field: 'quantity', header: 'Qty', format: 'N0', width: 0.6, aggregate: 'sum' },
          { field: 'amount', header: 'Amount', format: 'C2', aggregate: 'sum', rules: [{ op: '>=', value: 2000, color: '#1B7F3B', bold: true }] },
        ],
      },
    ],
  },
};

const salesPerformance = {
  key: 'sales',
  title: 'Sales Performance',
  description: 'Revenue by region, category and product with subtotals, cross-tab, trend and drill-through to order details.',
  definition: {
    page: { size: 'A4', orientation: 'portrait', fontSize: 8.5 },
    parameters: [
      { name: 'date_from', label: 'From', type: 'date', default: 'startOfYear' },
      { name: 'date_to', label: 'To', type: 'date', default: 'today' },
      { name: 'region', label: 'Region', type: 'string', multi: true, options: { kind: 'query', dataSourceId: '__DS__', query: 'SELECT name FROM regions ORDER BY 1', defaultFirst: true } },
      { name: 'category', label: 'Category', type: 'string', multi: true, options: { kind: 'query', dataSourceId: '__DS__', query: 'SELECT DISTINCT category FROM products ORDER BY 1', defaultFirst: true } },
      {
        name: 'product',
        label: 'Product (depends on Category)',
        type: 'string',
        multi: true,
        options: { kind: 'query', dataSourceId: '__DS__', query: 'SELECT name FROM products WHERE category IN ${category} ORDER BY 1', defaultFirst: true },
      },
    ],
    datasets: [
      {
        name: 'sales',
        dataSourceId: '__DS__',
        query: `SELECT r.name AS region, p.category, p.name AS product,
       COUNT(*) AS orders, SUM(o.quantity) AS units, SUM(o.amount) AS revenue
FROM orders o
JOIN regions r ON r.id = o.region_id
JOIN products p ON p.id = o.product_id
WHERE ${dateFilter} AND r.name IN \${region} AND p.category IN \${category} AND p.name IN \${product}
GROUP BY 1, 2, 3
ORDER BY 1, 2, 6 DESC`,
        calculated: [{ name: 'avg_order', expression: 'revenue / orders' }],
      },
      {
        name: 'trend',
        dataSourceId: '__DS__',
        query: `SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month, p.category, SUM(o.amount) AS revenue
FROM orders o JOIN regions r ON r.id = o.region_id JOIN products p ON p.id = o.product_id
WHERE ${dateFilter} AND r.name IN \${region} AND p.category IN \${category} AND p.name IN \${product}
GROUP BY 1, 2 ORDER BY 1, 2`,
      },
      {
        name: 'status',
        dataSourceId: '__DS__',
        query: `SELECT r.name AS region, o.status, COUNT(*) AS orders
FROM orders o JOIN regions r ON r.id = o.region_id JOIN products p ON p.id = o.product_id
WHERE ${dateFilter} AND r.name IN \${region} AND p.category IN \${category} AND p.name IN \${product}
GROUP BY 1, 2 ORDER BY 1, 2`,
      },
    ],
    header: { left: 'Graphan · Sales', center: '', right: 'Run {{Globals.ExecutionTime}}' },
    body: [
      {
        id: 'kpis',
        type: 'kpi',
        cards: [
          { label: 'Revenue', value: '{{Sum(sales.revenue, C0)}}', color: '#3871DC' },
          { label: 'Orders', value: '{{Sum(sales.orders, N0)}}' },
          { label: 'Units sold', value: '{{Sum(sales.units, N0)}}' },
          { label: 'Products', value: '{{CountDistinct(sales.product)}}' },
        ],
      },
      { id: 'trend', type: 'chart', title: 'Monthly revenue by category', dataset: 'trend', chartType: 'stacked', category: 'month', series: ['revenue'], seriesField: 'category', height: 260 },
      { id: 'mix', type: 'chart', title: 'Revenue mix by category', dataset: 'sales', chartType: 'donut', category: 'category', series: ['revenue'], height: 240 },
      { id: 'pb', type: 'pageBreak' },
      { id: 'h1', type: 'text', text: 'Sales by region and category', style: { fontSize: 13, bold: true } },
      {
        id: 'note',
        type: 'text',
        text: 'Click a product to open its order details for that region. Products under {{Parameters.date_from}} – {{Parameters.date_to}} with revenue below $5,000 are highlighted.',
        style: { italic: true, color: '#6B7280' },
      },
      {
        id: 'bytable',
        type: 'table',
        dataset: 'sales',
        groups: [
          { field: 'region', label: '{{value}}', sort: 'asc' },
          { field: 'category', label: '{{value}}', sort: 'asc', collapsed: false },
        ],
        columns: [
          {
            field: 'product',
            header: 'Product',
            width: 2.4,
            drillthrough: { reportId: '__REPORT_details__', params: { region: 'region', product: 'product', date_from: '@date_from', date_to: '@date_to' } },
          },
          { field: 'orders', header: 'Orders', format: 'N0', aggregate: 'sum' },
          { field: 'units', header: 'Units', format: 'N0', aggregate: 'sum' },
          { field: 'avg_order', header: 'Avg order', format: 'C2', aggregate: 'avg' },
          { field: 'revenue', header: 'Revenue', format: 'C0', aggregate: 'sum', width: 1.2, rules: [{ op: '<', value: 5000, color: '#B91C1C' }] },
        ],
      },
      { id: 'pb2', type: 'pageBreak' },
      {
        id: 'matrix',
        type: 'matrix',
        title: 'Orders by region and status',
        dataset: 'status',
        rows: ['region'],
        column: 'status',
        value: 'orders',
        aggregate: 'sum',
        format: 'N0',
      },
    ],
  },
};

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'sales-pack',
    title: 'Sales report pack',
    description: 'Sales Performance (grouped tables, subtotals, cross-tab, charts, cascading parameters) + Order Details drill-through report.',
    requiredTables: ['orders', 'regions', 'products', 'customers'],
    reports: [orderDetails, salesPerformance],
  },
];
