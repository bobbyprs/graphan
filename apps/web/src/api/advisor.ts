import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, workspaceStore } from './client';
import type { DashboardDefinition } from './types';

export type ColumnRole = 'primaryKey' | 'foreignKey' | 'time' | 'auditTime' | 'measure' | 'dimension' | 'flag' | 'label' | 'identifier' | 'text' | 'empty';

export interface AColumn {
  name: string;
  dataType: string;
  kind: string;
  role: ColumnRole;
  roleConfidence: number;
  reason: string;
  nullPct: number;
  uniquePct: number;
  distinct: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  top?: { value: string; count: number }[];
  label?: string;
  synonyms?: string[];
  overridden?: boolean;
}

export interface ATable {
  key: string;
  schema: string;
  name: string;
  rowCount: number;
  sampled: boolean;
  sampleSize: number;
  kind: 'fact' | 'dimension' | 'bridge' | 'entity' | 'empty';
  importance: number;
  primaryKey?: string;
  labelColumn?: string;
  timeColumn?: string;
  timeRange?: { from: string; to: string };
  columns: AColumn[];
  notes: string[];
  label?: string;
  synonyms?: string[];
  overridden?: boolean;
}

export interface AJoin {
  id: string;
  left: { schema: string; table: string; column: string };
  right: { schema: string; table: string; column: string };
  confidence: number;
  source: 'declared' | 'inferred' | 'manual';
  scores?: { name: number; datatype: number; overlap: number };
}

export interface AKpi {
  id: string;
  name: string;
  table: string;
  column?: string;
  category: string;
  unit: string;
  format: string;
  score: number;
  reason: string;
}

export interface AInsight {
  id: string;
  kind: 'trend' | 'growth' | 'seasonality' | 'outlier' | 'contributors' | 'correlation' | 'quality';
  title: string;
  detail: string;
  score: number;
  table: string;
  direction?: 'up' | 'down' | 'flat';
  series?: { t: string; v: number }[];
}

export type SuggestionKind = 'kpi' | 'trend' | 'trendBy' | 'breakdown' | 'share' | 'failures' | 'heatmap' | 'detail' | 'relationship';

export interface ASuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  viz: 'kpi' | 'line' | 'area' | 'bar' | 'pie' | 'heatmap' | 'table' | 'scatter';
  table: string;
  tables: string[];
  joinIds: string[];
  score: number;
  recommended: boolean;
  fields: { category?: string; value?: string; values?: string[]; series?: string; x?: string; y?: string };
  unit: string;
  format?: string;
  dimension?: { id: string; label: string };
  question?: string;
  timeUnit?: 'day' | 'week' | 'month';
  preview?: { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] };
}

export interface QualityScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  parts: { name: string; score: number; max: number; tip?: string }[];
}

export interface Analysis {
  id: string;
  dataSourceId: string;
  dataSourceName: string;
  schemas: string[];
  createdAt: string;
  durationMs: number;
  summary: { tables: number; analysed: number; emptyTables: number; rows: number; joins: number; declaredJoins: number; inferredJoins: number; kpis: number; suggestions: number; insights: number };
  tables: ATable[];
  joins: AJoin[];
  kpis: AKpi[];
  insights: AInsight[];
  suggestions: ASuggestion[];
  dimensions: { id: string; label: string; uses: number; distinct: number; table: { schema: string; table: string }; col: string }[];
  recommended: string[];
  quality: QualityScore;
  warnings: string[];
  model: { overrides: ModelOverrides; corrections: number; updatedAt: string | null };
  examples: string[];
}

// ───────────── Data model (corrections) ─────────────

export interface TableOverride {
  label?: string;
  synonyms?: string[];
  timeColumn?: string | null;
  labelColumn?: string | null;
  hidden?: boolean;
}
export interface ColumnOverride {
  role?: ColumnRole;
  label?: string;
  synonyms?: string[];
}
export interface ManualJoin {
  left: { schema: string; table: string; column: string };
  right: { schema: string; table: string; column: string };
}
export interface ModelOverrides {
  tables?: Record<string, TableOverride>;
  /** keyed by `${schema}.${table}|${column}` */
  columns?: Record<string, ColumnOverride>;
  joins?: { add?: ManualJoin[]; remove?: string[] };
  kpis?: Record<string, { name?: string; hidden?: boolean }>;
}
export interface DataModel {
  dataSourceId: string;
  overrides: ModelOverrides;
  corrections: number;
  joins: { left: AJoin['left']; right: AJoin['right']; confidence: number; source: AJoin['source'] }[];
  updatedAt: string | null;
}

const mk = (...parts: unknown[]) => [workspaceStore.get(), 'advisor-model', ...parts];

/** Saved data model of a data source; its joins also drive SQL editor join completion. */
export const useDataModel = (dataSourceId?: string, enabled = true) =>
  useQuery({
    queryKey: mk(dataSourceId),
    enabled: !!dataSourceId && enabled,
    queryFn: async () => (await api.get<DataModel>(`/advisor/model/${dataSourceId}`)).data,
    staleTime: 5 * 60_000,
    retry: false,
  });

export const useSaveModel = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ dataSourceId, overrides }: { dataSourceId: string; overrides: ModelOverrides }) => (await api.put<DataModel>(`/advisor/model/${dataSourceId}`, { overrides })).data,
    onSuccess: (d) => qc.setQueryData(mk(d.dataSourceId), d),
  });
};

// ───────────── Questions ─────────────

export interface Understood {
  kind: 'table' | 'measure' | 'by' | 'time' | 'filter' | 'sort';
  text: string;
}
export type AskAnswer =
  | { ok: true; suggestion: ASuggestion; understood: Understood[]; ignored: string[]; confidence: number; alternatives: { table: string; label: string }[]; notes: string[]; sql: string }
  | { ok: false; message: string; hints: string[]; sql?: string };

export const useAsk = () =>
  useMutation({
    mutationFn: async ({ id, ...b }: { id: string; question: string; table?: string }) => (await api.post<AskAnswer>(`/advisor/${id}/ask`, b, { timeout: 60_000 })).data,
  });

export interface Composed {
  target: 'dashboard' | 'report';
  title: string;
  description: string;
  definition: DashboardDefinition | Record<string, unknown>;
  quality: QualityScore;
  notes: string[];
}

export const useAnalyze = () =>
  useMutation({
    mutationFn: async (b: { dataSourceId: string; schemas?: string[]; fresh?: boolean }) => (await api.post<Analysis>('/advisor/analyze', b, { timeout: 300_000 })).data,
  });

export const useCompose = () =>
  useMutation({
    mutationFn: async ({ id, ...b }: { id: string; suggestionIds: string[]; target: 'dashboard' | 'report'; title?: string; filter?: string | null }) =>
      (await api.post<Composed>(`/advisor/${id}/compose`, b)).data,
  });

export const ROLE_META: Record<ColumnRole, { label: string; color: 'primary' | 'secondary' | 'success' | 'warning' | 'info' | 'default' | 'error' }> = {
  primaryKey: { label: 'Primary key', color: 'warning' },
  foreignKey: { label: 'Foreign key', color: 'secondary' },
  time: { label: 'Time', color: 'info' },
  auditTime: { label: 'Audit time', color: 'default' },
  measure: { label: 'Measure', color: 'success' },
  dimension: { label: 'Dimension', color: 'primary' },
  flag: { label: 'Flag', color: 'default' },
  label: { label: 'Label', color: 'primary' },
  identifier: { label: 'Identifier', color: 'default' },
  text: { label: 'Text', color: 'default' },
  empty: { label: 'Empty', color: 'default' },
};
