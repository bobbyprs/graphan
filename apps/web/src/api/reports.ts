import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, workspaceStore } from './client';

// ───────────── Definition (mirror of server report.schema.ts) ─────────────
export type ReportFormat = 'PDF' | 'EXCEL' | 'WORD' | 'CSV' | 'HTML' | 'JSON';
export type ParamType = 'string' | 'integer' | 'float' | 'date' | 'datetime' | 'boolean';
export type Align = 'left' | 'center' | 'right';
export const AGGREGATES = ['sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'first', 'last'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export type ParamOptions =
  | { kind: 'none' }
  | { kind: 'static'; values: { value: string | number; label?: string }[] }
  | { kind: 'query'; dataSourceId: string; query: string; valueField?: string; labelField?: string; defaultFirst?: boolean };

export interface ReportParameter {
  name: string;
  label?: string;
  type: ParamType;
  multi: boolean;
  required: boolean;
  hidden: boolean;
  default?: string | number | boolean | (string | number)[] | null;
  options: ParamOptions;
}

export interface Dataset {
  name: string;
  dataSourceId: string;
  query: string;
  maxRows?: number;
  calculated: { name: string; expression: string }[];
}

export interface Rule {
  op: '<' | '<=' | '>' | '>=' | '=' | '!=' | 'contains' | 'empty' | 'notEmpty';
  value?: string | number;
  color?: string;
  background?: string;
  bold?: boolean;
}

export interface Column {
  field: string;
  header?: string;
  format?: string;
  align?: Align;
  width?: number;
  aggregate?: 'none' | Aggregate;
  rules: Rule[];
  drillthrough?: { reportId: string; params: Record<string, string> };
  hideDuplicates?: boolean;
}

export interface Group {
  field: string;
  label?: string;
  sort: 'none' | 'asc' | 'desc';
  header: boolean;
  subtotal: boolean;
  pageBreak: boolean;
  collapsed: boolean;
}

export interface TextStyle {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  background?: string;
  align?: Align;
}

type ItemBase = { id: string; title?: string; bookmark?: string };

export type ListChild =
  | (ItemBase & { type: 'text'; text: string; style: TextStyle })
  | (ItemBase & { type: 'image'; src: string; width: number; align?: Align })
  | (ItemBase & { type: 'divider' });

export type ReportItem =
  | (ItemBase & { type: 'text'; text: string; style: TextStyle })
  | (ItemBase & { type: 'list'; dataset: string; items: ListChild[]; maxRows: number })
  | {
      id: string;
      title?: string;
      bookmark?: string;
      type: 'table';
      dataset: string;
      columns: Column[];
      groups: Group[];
      details: boolean;
      totals: boolean;
      repeatHeader: boolean;
      noRowsMessage?: string;
      sort: { field: string; dir: 'asc' | 'desc' }[];
      filter?: string;
      zebra: boolean;
    }
  | {
      id: string;
      title?: string;
      bookmark?: string;
      type: 'matrix';
      dataset: string;
      rows: string[];
      column: string;
      value: string;
      aggregate: Aggregate;
      format?: string;
      rowTotals: boolean;
      columnTotals: boolean;
      columnSort: 'none' | 'asc' | 'desc';
      maxColumns: number;
    }
  | {
      id: string;
      title?: string;
      bookmark?: string;
      type: 'chart';
      dataset: string;
      chartType: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'stacked';
      category: string;
      series: string[];
      seriesField?: string;
      height: number;
      format?: string;
      legend: boolean;
      labels: boolean;
    }
  | { id: string; title?: string; bookmark?: string; type: 'kpi'; cards: { label: string; value: string; color?: string; note?: string }[] }
  | { id: string; title?: string; bookmark?: string; type: 'image'; src: string; width: number; align?: Align }
  | { id: string; title?: string; bookmark?: string; type: 'pageBreak' }
  | { id: string; title?: string; bookmark?: string; type: 'divider' }
  | { id: string; title?: string; bookmark?: string; type: 'subreport'; reportId: string; params: Record<string, string> };

export type ItemType = ReportItem['type'];

export interface ReportDefinition {
  page: { size: 'A4' | 'A3' | 'A5' | 'LETTER' | 'LEGAL'; orientation: 'portrait' | 'landscape'; margins: [number, number, number, number]; fontSize: number };
  currency: string;
  locale: string;
  timezone: string;
  parameters: ReportParameter[];
  datasets: Dataset[];
  header: { left: string; center: string; right: string };
  footer: { left: string; center: string; right: string };
  showTitle: boolean;
  showParameters: boolean;
  body: ReportItem[];
}

export interface ReportSummary {
  id: string;
  title: string;
  description?: string | null;
  folder: string;
  version: number;
  ownerId: string;
  cacheMinutes: number;
  embedEnabled: boolean;
  updatedAt: string;
  owner: { id: string; name: string };
  _count: { subscriptions: number; snapshots: number };
  canEdit: boolean;
}

export interface Report extends Omit<ReportSummary, '_count'> {
  definition: ReportDefinition;
  snapshotRetention: number;
}

// ───────────── Rendered output (mirror of server rendered.ts) ─────────────
export interface DrillLink {
  reportId: string;
  params: Record<string, unknown>;
}
export interface RCell {
  v: unknown;
  t: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  link?: DrillLink;
}
export interface RTableRow {
  kind: 'group' | 'data' | 'subtotal' | 'total';
  level: number;
  cells: RCell[];
  label?: string;
  key?: string;
  anc: string[];
  pageBreakBefore?: boolean;
  collapsed?: boolean;
  count?: number;
}
export type RItem =
  | { type: 'text'; id: string; text: string; style: TextStyle }
  | { type: 'table'; id: string; title?: string; columns: { field: string; header: string; align: Align; width: number; format?: string }[]; rows: RTableRow[]; repeatHeader: boolean; zebra: boolean; empty?: string; dataRows: number; groupLevels: number }
  | { type: 'matrix'; id: string; title?: string; rowHeaders: string[]; columns: string[]; rows: { labels: string[]; cells: RCell[]; total?: RCell }[]; columnTotals?: RCell[]; grandTotal?: RCell; rowTotals: boolean; format?: string; truncatedColumns?: number; empty?: string }
  | { type: 'chart'; id: string; title?: string; height: number; option: Record<string, unknown>; svg: string; empty?: string }
  | { type: 'kpi'; id: string; title?: string; cards: { label: string; value: string; color?: string; note?: string }[] }
  | { type: 'image'; id: string; title?: string; src: string; width: number; align: Align }
  | { type: 'pageBreak'; id: string }
  | { type: 'divider'; id: string }
  | { type: 'error'; id: string; title?: string; message: string };

export interface RenderedReport {
  reportId: string;
  title: string;
  description?: string | null;
  page: ReportDefinition['page'];
  header: { left: string; center: string; right: string };
  footer: { left: string; center: string; right: string };
  showTitle: boolean;
  showParameters: boolean;
  executedAt: string;
  user: string;
  parameters: { name: string; label: string; display: string; hidden: boolean }[];
  documentMap: { id: string; label: string; level: number }[];
  items: RItem[];
  datasets: { name: string; rowCount: number; truncated: boolean; durationMs: number }[];
  rowCount: number;
  durationMs: number;
}

export interface ParamOption {
  value: string | number;
  label: string;
}

export interface Subscription {
  id: string;
  reportId: string;
  ownerId: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  format: ReportFormat;
  delivery: 'email' | 'snapshot';
  recipients: string[];
  cc: string[];
  subject?: string | null;
  comment?: string | null;
  includeLink: boolean;
  onlyIfData: boolean;
  parameters: Record<string, unknown>;
  dataDriven?: { dataSourceId: string; query: string; emailColumn: string; ccColumn?: string; formatColumn?: string; paramColumns: Record<string, string> } | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  report?: { id: string; title: string };
}

export interface Delivery {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  delivered: number;
  failed: number;
  error?: string | null;
}

export interface Snapshot {
  id: string;
  label?: string | null;
  createdAt: string;
  rowCount: number;
  sizeBytes: number;
  parameters: Record<string, unknown>;
  subscriptionId?: string | null;
}

export interface Execution {
  id: string;
  reportId: string;
  userId?: string | null;
  source: string;
  format: string;
  parameters: Record<string, unknown>;
  durationMs: number;
  rowCount: number;
  cached: boolean;
  status: string;
  error?: string | null;
  createdAt: string;
}

export type ParamValues = Record<string, unknown>;

// ───────────── Hooks ─────────────
const k = (...parts: unknown[]) => [workspaceStore.get(), 'reports', ...parts];

export const useReports = (search?: string) => useQuery({ queryKey: k('list', search), queryFn: async () => (await api.get<ReportSummary[]>('/reports', { params: { search } })).data });
export const useReport = (id?: string) => useQuery({ queryKey: k('one', id), enabled: !!id, queryFn: async () => (await api.get<Report>(`/reports/${id}`)).data });
export const useReportTemplates = () => useQuery({ queryKey: ['report-templates'], staleTime: Infinity, queryFn: async () => (await api.get<{ id: string; title: string; description: string; reports: number }[]>('/reports/templates')).data });
export const useSnapshots = (id?: string, enabled = true) => useQuery({ queryKey: k('snapshots', id), enabled: !!id && enabled, queryFn: async () => (await api.get<Snapshot[]>(`/reports/${id}/snapshots`)).data });
export const useReportSubscriptions = (id?: string) => useQuery({ queryKey: k('subs', id), enabled: !!id, queryFn: async () => (await api.get<Subscription[]>(`/reports/${id}/subscriptions`)).data });
export const useMySubscriptions = (all = false) => useQuery({ queryKey: k('subs', 'mine', all), queryFn: async () => (await api.get<Subscription[]>('/reports/subscriptions', { params: { all: all ? 1 : undefined } })).data });
export const useDeliveries = (sid?: string) => useQuery({ queryKey: k('deliveries', sid), enabled: !!sid, queryFn: async () => (await api.get<Delivery[]>(`/reports/subscriptions/${sid}/deliveries`)).data });
export const useExecutions = (enabled: boolean, reportId?: string) =>
  useQuery({ queryKey: k('executions', reportId), enabled, placeholderData: keepPreviousData, queryFn: async () => (await api.get<Execution[]>('/reports/executions', { params: { reportId, take: 500 } })).data });

/** basePath: `/reports/<id>` (signed-in) or `/embed/report` (embedded viewer) */
export const useParamOptions = (basePath: string, name: string, current: ParamValues, enabled: boolean, definition?: ReportDefinition) =>
  useQuery({
    queryKey: k('param-options', basePath, name, current, definition ? JSON.stringify(definition.parameters) : null),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => (await api.post<ParamOption[]>(`${basePath}/parameters/${name}/options`, { parameters: current, definition })).data,
  });

export function useReportMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'reports'] });
  return {
    create: useMutation({ mutationFn: async (body: { title: string; description?: string | null; folder: string; definition: ReportDefinition | Record<string, unknown> }) => (await api.post<Report>('/reports', body)).data, onSuccess: inv }),
    update: useMutation({ mutationFn: async ({ id, ...body }: { id: string; version: number } & Partial<Pick<Report, 'title' | 'description' | 'folder' | 'cacheMinutes' | 'snapshotRetention' | 'definition'>>) => (await api.put<Report>(`/reports/${id}`, body)).data, onSuccess: inv }),
    remove: useMutation({ mutationFn: async (id: string) => api.delete(`/reports/${id}`), onSuccess: inv }),
    duplicate: useMutation({ mutationFn: async (id: string) => (await api.post<Report>(`/reports/${id}/duplicate`)).data, onSuccess: inv }),
    fromTemplate: useMutation({ mutationFn: async (body: { templateId: string; dataSourceId: string; folder: string }) => (await api.post<{ id: string; title: string }[]>('/reports/from-template', body)).data, onSuccess: inv }),
    snapshot: useMutation({ mutationFn: async ({ id, ...body }: { id: string; parameters: ParamValues; label?: string }) => (await api.post(`/reports/${id}/snapshots`, body)).data, onSuccess: inv }),
    deleteSnapshot: useMutation({ mutationFn: async ({ id, sid }: { id: string; sid: string }) => api.delete(`/reports/${id}/snapshots/${sid}`), onSuccess: inv }),
    saveSubscription: useMutation({
      mutationFn: async ({ id, reportId, ...body }: Partial<Subscription> & { reportId: string }) =>
        (id ? await api.put<Subscription>(`/reports/subscriptions/${id}`, body) : await api.post<Subscription>(`/reports/${reportId}/subscriptions`, body)).data,
      onSuccess: inv,
    }),
    deleteSubscription: useMutation({ mutationFn: async (sid: string) => api.delete(`/reports/subscriptions/${sid}`), onSuccess: inv }),
    runSubscription: useMutation({ mutationFn: async (sid: string) => (await api.post<{ status: string; delivered: number; failed: number; error?: string }>(`/reports/subscriptions/${sid}/run`)).data, onSuccess: inv }),
    setEmbed: useMutation({ mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => (await api.post<{ embedEnabled: boolean }>(`/reports/${id}/embed`, { enabled })).data, onSuccess: inv }),
  };
}

export const FORMAT_LABELS: Record<ReportFormat, string> = { PDF: 'PDF', EXCEL: 'Excel', WORD: 'Word', CSV: 'CSV (comma delimited)', HTML: 'Web archive (HTML)', JSON: 'JSON (data)' };

/** Reads p.<name> URL parameters (SSRS-style URL access) */
export function paramsFromSearch(sp: URLSearchParams): ParamValues {
  const out: ParamValues = {};
  for (const key of new Set([...sp.keys()].filter((k2) => k2.startsWith('p.')))) {
    const all = sp.getAll(key);
    out[key.slice(2)] = all.length > 1 ? all : all[0];
  }
  return out;
}

export function paramsToSearch(values: ParamValues, sp = new URLSearchParams()): URLSearchParams {
  for (const key of [...sp.keys()]) if (key.startsWith('p.')) sp.delete(key);
  for (const [name, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    (Array.isArray(v) ? v : [v]).forEach((x) => sp.append(`p.${name}`, String(x)));
  }
  return sp;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export const BLANK_DEFINITION: ReportDefinition = {
  page: { size: 'A4', orientation: 'portrait', margins: [15, 12, 15, 12], fontSize: 9 },
  currency: '$',
  locale: 'en-US',
  timezone: 'UTC',
  parameters: [],
  datasets: [],
  header: { left: '', center: '', right: '' },
  footer: { left: '{{Globals.ReportName}}', center: '', right: 'Page {{Globals.PageNumber}} of {{Globals.TotalPages}}' },
  showTitle: true,
  showParameters: true,
  body: [],
};
