import { z } from 'zod';

/**
 * Report definition — Graphan's equivalent of an SSRS RDL file, stored as JSON.
 *
 * Expressions in text (titles, textboxes, header/footer, subscription subjects) use {{ ... }}:
 *   {{Parameters.region}}  {{Globals.ReportName}}  {{Globals.ExecutionTime}}  {{User.Name}}
 *   {{Globals.PageNumber}} {{Globals.TotalPages}}   (header/footer only)
 *   {{Sum(sales.amount, C2)}}  {{Avg|Min|Max|Count|CountDistinct|First|Last(dataset.field[, format])}}  {{Count(sales)}}
 *
 * Format codes (SSRS-style): N0 N2 (number) · C0 C2 (currency) · P0 P1 (percent) · F2 (fixed, no grouping)
 *   · D (date) · DT (date+time) · T (time) · or a date pattern such as "dd-MMM-yyyy HH:mm".
 */

const id = z.string().min(1).max(64);
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Use letters, digits and _ (start with a letter)');
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional();
const format = z.string().max(64).optional();
const align = z.enum(['left', 'center', 'right']).optional();
export const AGGREGATES = ['sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'first', 'last'] as const;
const aggregate = z.enum(['none', ...AGGREGATES]).optional();

const textStyle = z
  .object({
    fontSize: z.number().min(6).max(48).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color,
    background: color,
    align,
  })
  .default({});

export const parameterSchema = z.object({
  name,
  label: z.string().max(120).optional(),
  type: z.enum(['string', 'integer', 'float', 'date', 'datetime', 'boolean']).default('string'),
  multi: z.boolean().default(false),
  required: z.boolean().default(true),
  hidden: z.boolean().default(false),
  /** Static default value(s); "today", "today-7d", "startOfMonth", "startOfYear" work for dates */
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).nullable().optional(),
  /** Available values: static list, or a query (may reference other parameters → cascading) */
  options: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('static'), values: z.array(z.object({ value: z.union([z.string(), z.number()]), label: z.string().max(200).optional() })).max(1000) }),
      z.object({
        kind: z.literal('query'),
        dataSourceId: z.string().uuid(),
        query: z.string().min(1).max(20_000),
        valueField: z.string().max(128).optional(),
        labelField: z.string().max(128).optional(),
        /** Use the first returned value(s) as default (SSRS "default from query") */
        defaultFirst: z.boolean().default(false),
      }),
    ])
    .default({ kind: 'none' }),
});

export const datasetSchema = z.object({
  name,
  dataSourceId: z.string().uuid(),
  query: z.string().min(1).max(100_000),
  maxRows: z.number().int().min(1).max(200_000).optional(),
  /** Calculated fields: { name, expression } using the safe expression engine (e.g. "revenue - cost") */
  calculated: z.array(z.object({ name, expression: z.string().min(1).max(2000) })).max(50).default([]),
});

const ruleSchema = z.object({
  op: z.enum(['<', '<=', '>', '>=', '=', '!=', 'contains', 'empty', 'notEmpty']),
  value: z.union([z.string(), z.number()]).optional(),
  color,
  background: color,
  bold: z.boolean().optional(),
});

const drillSchema = z.object({
  reportId: z.string().uuid(),
  /** target parameter name → source field of the clicked row, "@param" (this report's parameter) or "=literal" */
  params: z.record(z.string().max(128)).default({}),
});

export const columnSchema = z.object({
  field: z.string().min(1).max(128),
  header: z.string().max(200).optional(),
  format,
  align,
  /** Relative width weight (PDF/Word) */
  width: z.number().min(0.2).max(20).optional(),
  aggregate,
  rules: z.array(ruleSchema).max(10).default([]),
  drillthrough: drillSchema.optional(),
  /** Repeat value only on first row of a run (SSRS HideDuplicates) */
  hideDuplicates: z.boolean().optional(),
});

export const groupSchema = z.object({
  field: z.string().min(1).max(128),
  label: z.string().max(200).optional(),
  sort: z.enum(['none', 'asc', 'desc']).default('none'),
  header: z.boolean().default(true),
  subtotal: z.boolean().default(true),
  pageBreak: z.boolean().default(false),
  /** Interactive viewer: start collapsed (toggle) */
  collapsed: z.boolean().default(false),
});

const base = { id, title: z.string().max(300).optional(), bookmark: z.string().max(120).optional() };

/** Items that may repeat inside a list region (one block per dataset row; {{Fields.col}} resolves per row). */
const listChildSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('text'), text: z.string().max(20_000), style: textStyle }),
  z.object({ ...base, type: z.literal('image'), src: z.string().max(800_000).regex(/^data:image\/(png|jpe?g|svg\+xml);base64,/, 'Images must be uploaded (data URI)'), width: z.number().int().min(16).max(1000).default(160), align }),
  z.object({ ...base, type: z.literal('divider') }),
]);
export type ListChild = z.infer<typeof listChildSchema>;

export const itemSchema = z.discriminatedUnion('type', [
    z.object({ ...base, type: z.literal('text'), text: z.string().max(20_000), style: textStyle }),
    z.object({ ...base, type: z.literal('list'), dataset: name, items: z.array(listChildSchema).min(1).max(20), maxRows: z.number().int().min(1).max(1000).default(100) }),
    z.object({
      ...base,
      type: z.literal('table'),
      dataset: name,
      columns: z.array(columnSchema).min(1).max(100),
      groups: z.array(groupSchema).max(5).default([]),
      details: z.boolean().default(true),
      totals: z.boolean().default(true),
      repeatHeader: z.boolean().default(true),
      noRowsMessage: z.string().max(500).optional(),
      sort: z.array(z.object({ field: z.string().max(128), dir: z.enum(['asc', 'desc']).default('asc') })).max(5).default([]),
      filter: z.string().max(2000).optional(),
      zebra: z.boolean().default(true),
    }),
    z.object({
      ...base,
      type: z.literal('matrix'),
      dataset: name,
      rows: z.array(z.string().min(1).max(128)).min(1).max(3),
      column: z.string().min(1).max(128),
      value: z.string().min(1).max(128),
      aggregate: z.enum(AGGREGATES).default('sum'),
      format,
      rowTotals: z.boolean().default(true),
      columnTotals: z.boolean().default(true),
      columnSort: z.enum(['none', 'asc', 'desc']).default('asc'),
      maxColumns: z.number().int().min(1).max(200).default(50),
    }),
    z.object({
      ...base,
      type: z.literal('chart'),
      dataset: name,
      chartType: z.enum(['bar', 'column', 'line', 'area', 'pie', 'donut', 'stacked']).default('column'),
      category: z.string().min(1).max(128),
      series: z.array(z.string().min(1).max(128)).min(1).max(12),
      /** Pivot series by this field instead (one series per distinct value of `seriesField`) */
      seriesField: z.string().max(128).optional(),
      height: z.number().int().min(120).max(900).default(300),
      format,
      legend: z.boolean().default(true),
      labels: z.boolean().default(false),
    }),
    z.object({
      ...base,
      type: z.literal('kpi'),
      cards: z
        .array(
          z.object({
            label: z.string().max(120),
            value: z.string().max(500), // expression, e.g. {{Sum(sales.amount, C0)}}
            color,
            note: z.string().max(300).optional(),
          }),
        )
        .min(1)
        .max(8),
    }),
    z.object({ ...base, type: z.literal('image'), src: z.string().max(800_000).regex(/^data:image\/(png|jpe?g|svg\+xml);base64,/, 'Images must be uploaded (data URI)'), width: z.number().int().min(16).max(1000).default(160), align }),
    z.object({ ...base, type: z.literal('pageBreak') }),
    z.object({ ...base, type: z.literal('divider') }),
    z.object({
      ...base,
      type: z.literal('subreport'),
      reportId: z.string().uuid(),
      /** sub-report parameter → "=literal" or "{{Parameters.x}}" expression */
      params: z.record(z.string().max(500)).default({}),
    }),
]);

export type ReportItem = z.infer<typeof itemSchema>;

export const reportDefinitionSchema = z.object({
  page: z
    .object({
      size: z.enum(['A4', 'A3', 'A5', 'LETTER', 'LEGAL']).default('A4'),
      orientation: z.enum(['portrait', 'landscape']).default('portrait'),
      /** millimetres: top, right, bottom, left */
      margins: z.tuple([z.number().min(0).max(80), z.number().min(0).max(80), z.number().min(0).max(80), z.number().min(0).max(80)]).default([15, 12, 15, 12]),
      fontSize: z.number().min(6).max(16).default(9),
    })
    .default({}),
  currency: z.string().max(8).default('$'),
  locale: z.string().max(20).default('en-US'),
  timezone: z.string().max(64).default('UTC'),
  parameters: z.array(parameterSchema).max(30).default([]),
  datasets: z.array(datasetSchema).max(20).default([]),
  header: z.object({ left: z.string().max(500).default(''), center: z.string().max(500).default(''), right: z.string().max(500).default('') }).default({}),
  footer: z
    .object({ left: z.string().max(500).default('{{Globals.ReportName}}'), center: z.string().max(500).default(''), right: z.string().max(500).default('Page {{Globals.PageNumber}} of {{Globals.TotalPages}}') })
    .default({}),
  /** Show the report title + parameter summary at the top of page 1 */
  showTitle: z.boolean().default(true),
  showParameters: z.boolean().default(true),
  body: z.array(itemSchema).max(100).default([]),
});

export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportParameter = z.infer<typeof parameterSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type TableItem = Extract<ReportItem, { type: 'table' }>;
export type MatrixItem = Extract<ReportItem, { type: 'matrix' }>;
export type ChartItem = Extract<ReportItem, { type: 'chart' }>;

export const reportInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  folder: z
    .string()
    .max(300)
    .regex(/^\/([^/]+(\/[^/]+)*)?$/, 'Folder must look like /Finance/Monthly')
    .default('/'),
  cacheMinutes: z.number().int().min(0).max(1440).default(0),
  snapshotRetention: z.number().int().min(1).max(1000).default(30),
  definition: reportDefinitionSchema,
});
export const reportUpdateSchema = reportInputSchema.partial().extend({ version: z.number().int().positive() });

export const paramValue = z.union([z.string().max(4000), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(4000), z.number()])).max(1000)]);
export const renderRequestSchema = z.object({
  parameters: z.record(paramValue).default({}),
  /** Bypass report cache */
  fresh: z.boolean().default(false),
});

export const subscriptionInputSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  cron: z.string().min(9).max(100),
  timezone: z.string().max(64).default('UTC'),
  format: z.enum(['PDF', 'EXCEL', 'WORD', 'CSV', 'HTML', 'JSON']).default('PDF'),
  delivery: z.enum(['email', 'snapshot']).default('email'),
  recipients: z.array(z.string().email()).max(200).default([]),
  cc: z.array(z.string().email()).max(200).default([]),
  subject: z.string().max(300).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  includeLink: z.boolean().default(true),
  onlyIfData: z.boolean().default(false),
  parameters: z.record(paramValue).default({}),
  dataDriven: z
    .object({
      dataSourceId: z.string().uuid(),
      query: z.string().min(1).max(20_000),
      emailColumn: z.string().min(1).max(128),
      ccColumn: z.string().max(128).optional(),
      formatColumn: z.string().max(128).optional(),
      /** report parameter → column of the subscriber query */
      paramColumns: z.record(z.string().max(128)).default({}),
    })
    .nullable()
    .optional(),
});
