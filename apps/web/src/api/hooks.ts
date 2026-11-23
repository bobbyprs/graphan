import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, EMBED_TOKEN, workspaceStore } from './client';
import type {
  AlertEvent,
  AlertRule,
  AuditEntry,
  Dashboard,
  DashboardDefinition,
  DashboardSummary,
  DashboardTemplate,
  DataSource,
  DataSourceInput,
  DbObject,
  DbObjectKind,
  Filter,
  Member,
  MlModelSummary,
  Prediction,
  ProfileResult,
  RegressionModelId,
  SuggestedDashboard,
  TrainResult,
  ForecastConfig,
  NotificationChannel,
  Paged,
  QueryHistoryItem,
  QueryResult,
  Role,
  SavedQuery,
  TableDetails,
  Team,
  Transforms,
} from './types';

/** Workspace-scoped query keys so switching workspaces never shows stale data. */
const k = (...parts: unknown[]) => [workspaceStore.get(), ...parts];

// ───────────── Data sources ─────────────
export const useDataSources = () =>
  useQuery({ queryKey: k('datasources'), queryFn: async () => (await api.get<DataSource[]>('/datasources')).data });

export function useSaveDataSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: Partial<DataSourceInput> }) =>
      (id ? await api.put<DataSource>(`/datasources/${id}`, input) : await api.post<DataSource>('/datasources', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('datasources') }),
  });
}

export function useDeleteDataSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/datasources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: k('datasources') }),
  });
}

export const useTestDataSource = () =>
  useMutation({
    mutationFn: async (input: DataSourceInput & { id?: string }) =>
      (await api.post<{ ok: boolean; latencyMs?: number; error?: string }>('/datasources/test', input)).data,
  });

// ───────────── Explorer ─────────────
export const useSchemas = (dsId?: string) =>
  useQuery({
    queryKey: k('schemas', dsId),
    enabled: !!dsId,
    queryFn: async () => (await api.get<{ schemas: string[] }>(`/explorer/${dsId}/schemas`)).data.schemas,
    staleTime: 60_000,
  });

export const useObjects = (dsId?: string, schema?: string) =>
  useQuery({
    queryKey: k('objects', dsId, schema),
    enabled: !!dsId && !!schema,
    queryFn: async () => (await api.get<{ objects: DbObject[] }>(`/explorer/${dsId}/schemas/${encodeURIComponent(schema!)}/objects`)).data.objects,
    staleTime: 60_000,
  });

export const useTableDetails = (dsId?: string, schema?: string, table?: string) =>
  useQuery({
    queryKey: k('table', dsId, schema, table),
    enabled: !!dsId && !!schema && !!table,
    queryFn: async () =>
      (await api.get<TableDetails>(`/explorer/${dsId}/schemas/${encodeURIComponent(schema!)}/tables/${encodeURIComponent(table!)}`)).data,
  });

export const useTablePreview = (dsId?: string, schema?: string, table?: string, page = 0, pageSize = 100) =>
  useQuery({
    queryKey: k('preview', dsId, schema, table, page, pageSize),
    enabled: !!dsId && !!schema && !!table,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await api.get<QueryResult>(`/explorer/${dsId}/schemas/${encodeURIComponent(schema!)}/tables/${encodeURIComponent(table!)}/preview`, {
          params: { limit: pageSize, offset: page * pageSize },
        })
      ).data,
  });

export const useDdl = (dsId?: string, schema?: string, name?: string, kind: DbObjectKind = 'table') =>
  useQuery({
    queryKey: k('ddl', dsId, schema, name, kind),
    enabled: !!dsId && !!schema && !!name,
    queryFn: async () =>
      (await api.get<{ ddl: string }>(`/explorer/${dsId}/schemas/${encodeURIComponent(schema!)}/ddl`, { params: { name, kind } })).data.ddl,
  });

export const useCompletion = (dsId?: string) =>
  useQuery({
    queryKey: k('completion', dsId),
    enabled: !!dsId,
    staleTime: 5 * 60_000,
    queryFn: async () => (await api.get<{ tables: { schema: string; table: string; columns: string[] }[] }>(`/explorer/${dsId}/completion`)).data.tables,
  });

export const useExplorerSearch = (dsId?: string, q?: string) =>
  useQuery({
    queryKey: k('search', dsId, q),
    enabled: !!dsId && (q?.length ?? 0) >= 2,
    queryFn: async () =>
      (await api.get<{ results: { kind: 'table' | 'column'; schema: string; table: string; column?: string }[] }>(`/explorer/${dsId}/search`, { params: { q } })).data
        .results,
  });

// ───────────── Queries ─────────────
export interface ExecuteInput {
  dataSourceId: string;
  sql: string;
  timeRange?: { from: string; to: string };
  variables?: Record<string, unknown>;
  transforms?: Transforms;
  maxRows?: number;
}

export function useExecuteQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ExecuteInput) => (await api.post<QueryResult>('/queries/execute', input)).data,
    onSettled: () => qc.invalidateQueries({ queryKey: k('history') }),
  });
}

export const useQueryHistory = (dataSourceId?: string) =>
  useQuery({
    queryKey: k('history', dataSourceId),
    queryFn: async () => (await api.get<{ items: QueryHistoryItem[] }>('/queries/history', { params: { dataSourceId, limit: 100 } })).data.items,
  });

export const useSavedQueries = () =>
  useQuery({ queryKey: k('saved'), queryFn: async () => (await api.get<SavedQuery[]>('/queries/saved')).data });

export function useSaveQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: Partial<SavedQuery> & { id?: string }) =>
      (id ? await api.put(`/queries/saved/${id}`, body) : await api.post('/queries/saved', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('saved') }),
  });
}

export function useDeleteSavedQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/queries/saved/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: k('saved') }),
  });
}

// ───────────── Dashboards ─────────────
export const useDashboards = (search?: string) =>
  useQuery({ queryKey: k('dashboards', search), queryFn: async () => (await api.get<DashboardSummary[]>('/dashboards', { params: { search } })).data });

/** Read-only dashboard API base: anonymous share link or signed embed session */
const viewBase = (token: string) => (token === EMBED_TOKEN ? '/embed/dashboard' : `/public/dashboards/${token}`);

export const useDashboard = (id?: string, publicToken?: string) =>
  useQuery({
    queryKey: k('dashboard', id ?? publicToken),
    enabled: !!(id || publicToken),
    queryFn: async () => (await api.get<Dashboard>(publicToken ? viewBase(publicToken) : `/dashboards/${id}`)).data,
  });

export const useTemplates = () =>
  useQuery({ queryKey: ['templates'], staleTime: Infinity, queryFn: async () => (await api.get<DashboardTemplate[]>('/dashboards/templates')).data });

export function useCreateDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title: string; description?: string; definition: DashboardDefinition; tags?: string[]; refreshInterval?: string | null }) =>
      (await api.post<Dashboard>('/dashboards', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('dashboards') }),
  });
}

export function useCreateFromTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { templateId: string; dataSourceId: string | null; title?: string }) =>
      (await api.post<Dashboard>('/dashboards/from-template', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('dashboards') }),
  });
}

export function useUpdateDashboard(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<Omit<Dashboard, 'access'>> & { version: number; message?: string }) =>
      (await api.put<Dashboard>(`/dashboards/${id}`, body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: k('dashboard', id) });
      qc.invalidateQueries({ queryKey: k('dashboards') });
    },
  });
}

export function useDeleteDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/dashboards/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: k('dashboards') }),
  });
}

export function useDuplicateDashboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<Dashboard>(`/dashboards/${id}/duplicate`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('dashboards') }),
  });
}

export const useDashboardVersions = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: k('dashboard-versions', id),
    enabled,
    queryFn: async () => (await api.get<{ id: string; version: number; message?: string; createdAt: string }[]>(`/dashboards/${id}/versions`)).data,
  });

export interface PanelDataArgs {
  dashboardId: string;
  panelId: string;
  version: number;
  timeRange: { from: string; to: string };
  variables: Record<string, unknown>;
  filters?: Filter[];
  publicToken?: string;
  refreshMs?: number | false;
  enabled?: boolean;
  /** Unsaved panel (edit mode): run the draft query through the ad-hoc execute endpoint */
  adhoc?: { dataSourceId: string; sql: string; transforms?: Transforms };
}

export const usePanelData = (a: PanelDataArgs) =>
  useQuery({
    queryKey: k('panel', a.publicToken ?? a.dashboardId, a.panelId, a.version, a.timeRange, a.variables, a.filters, a.adhoc),
    enabled: a.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: a.refreshMs ?? false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) =>
      a.adhoc
        ? (
            await api.post<QueryResult>(
              '/queries/execute',
              { ...a.adhoc, timeRange: a.timeRange, variables: a.variables, transforms: { ...a.adhoc.transforms, filters: [...(a.adhoc.transforms?.filters ?? []), ...(a.filters ?? [])] } },
              { signal },
            )
          ).data
        : (
        await api.post<QueryResult>(
          a.publicToken ? `${viewBase(a.publicToken)}/panels/${a.panelId}/data` : `/dashboards/${a.dashboardId}/panels/${a.panelId}/data`,
          { timeRange: a.timeRange, variables: a.variables, filters: a.filters },
          { signal },
        )
      ).data,
  });

export const useVariableOptions = (dashboardId: string, name: string, enabled: boolean, publicToken?: string) =>
  useQuery({
    queryKey: k('var-options', publicToken ?? dashboardId, name),
    enabled,
    staleTime: 60_000,
    queryFn: async () =>
      (await api.get<{ values: string[] }>(publicToken ? `${viewBase(publicToken)}/variables/${name}/options` : `/dashboards/${dashboardId}/variables/${name}/options`))
        .data.values,
  });

// ───────────── Alerts ─────────────
export const useAlertRules = () => useQuery({ queryKey: k('alert-rules'), queryFn: async () => (await api.get<AlertRule[]>('/alerts/rules')).data });
export const useAlertEvents = (opts: { ruleId?: string; unacknowledged?: boolean } = {}) =>
  useQuery({
    queryKey: k('alert-events', opts),
    queryFn: async () =>
      (await api.get<Paged<AlertEvent>>('/alerts/events', { params: { ruleId: opts.ruleId, unacknowledged: opts.unacknowledged ? '1' : undefined, limit: 200 } })).data,
  });
export const useChannels = () => useQuery({ queryKey: k('channels'), queryFn: async () => (await api.get<NotificationChannel[]>('/alerts/channels')).data });

export function useAlertMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: k('alert-rules') });
    qc.invalidateQueries({ queryKey: k('alert-events') });
    qc.invalidateQueries({ queryKey: k('channels') });
  };
  return {
    saveRule: useMutation({
      mutationFn: async ({ id, ...body }: Record<string, unknown> & { id?: string }) =>
        (id ? await api.put(`/alerts/rules/${id}`, body) : await api.post('/alerts/rules', body)).data,
      onSuccess: inv,
    }),
    deleteRule: useMutation({ mutationFn: (id: string) => api.delete(`/alerts/rules/${id}`), onSuccess: inv }),
    testRule: useMutation({
      mutationFn: async (body: Record<string, unknown>) => (await api.post<{ state: string; value: number | null; message: string }>('/alerts/rules/test', body)).data,
    }),
    evaluate: useMutation({ mutationFn: (id: string) => api.post(`/alerts/rules/${id}/evaluate`), onSuccess: inv }),
    ack: useMutation({ mutationFn: (id: string) => api.post(`/alerts/events/${id}/ack`), onSuccess: inv }),
    saveChannel: useMutation({ mutationFn: (body: Record<string, unknown>) => api.post('/alerts/channels', body), onSuccess: inv }),
    deleteChannel: useMutation({ mutationFn: (id: string) => api.delete(`/alerts/channels/${id}`), onSuccess: inv }),
    testChannel: useMutation({ mutationFn: async (id: string) => (await api.post<{ ok: boolean; error?: string }>(`/alerts/channels/${id}/test`)).data }),
  };
}

// ───────────── Admin ─────────────
export const useMembers = () => useQuery({ queryKey: k('members'), queryFn: async () => (await api.get<Member[]>('/members')).data });
export const useTeams = () => useQuery({ queryKey: k('teams'), queryFn: async () => (await api.get<Team[]>('/teams')).data });

export function useAdminMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: k('members') });
    qc.invalidateQueries({ queryKey: k('teams') });
  };
  return {
    addMember: useMutation({
      mutationFn: async (b: { email: string; name: string; role: Role; password?: string }) =>
        (await api.post<{ tempPassword?: string }>('/members', b)).data,
      onSuccess: inv,
    }),
    setRole: useMutation({ mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.patch(`/members/${userId}`, { role }), onSuccess: inv }),
    removeMember: useMutation({ mutationFn: (userId: string) => api.delete(`/members/${userId}`), onSuccess: inv }),
    createTeam: useMutation({ mutationFn: (b: { name: string; description?: string }) => api.post('/teams', b), onSuccess: inv }),
    deleteTeam: useMutation({ mutationFn: (id: string) => api.delete(`/teams/${id}`), onSuccess: inv }),
    setTeamMembers: useMutation({ mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) => api.put(`/teams/${id}/members`, { userIds }), onSuccess: inv }),
  };
}

export const useAudit = (params: { action?: string; page: number; pageSize: number }) =>
  useQuery({
    queryKey: k('audit', params),
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (await api.get<Paged<AuditEntry>>('/audit', { params: { action: params.action || undefined, limit: params.pageSize, offset: params.page * params.pageSize } })).data,
  });

// ───────────── ML Studio ─────────────
export interface MlSource {
  dataSourceId: string;
  sql: string;
  timeRange?: { from: string; to: string };
  variables?: Record<string, unknown>;
}

export const useMlProfile = () => useMutation({ mutationFn: async (b: MlSource) => (await api.post<ProfileResult>('/ml/profile', b)).data });

export function useMlTrain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: MlSource & { target: string; features?: string[]; models?: RegressionModelId[]; folds?: number; name?: string }) =>
      (await api.post<TrainResult>('/ml/train', b, { timeout: 180_000 })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: k('ml-models') }),
  });
}

export const useMlForecast = () => useMutation({ mutationFn: async (b: MlSource & { forecast: ForecastConfig }) => (await api.post<QueryResult>('/ml/forecast', b)).data });

export const useMlModels = () => useQuery({ queryKey: k('ml-models'), queryFn: async () => (await api.get<MlModelSummary[]>('/ml/models')).data });

export const useMlModel = (id?: string) =>
  useQuery({ queryKey: k('ml-model', id), enabled: !!id, staleTime: Infinity, queryFn: async () => (await api.get<TrainResult>(`/ml/models/${id}`)).data });

export function useDeleteMlModel() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/ml/models/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: k('ml-models') }) });
}

export const useMlPredict = () =>
  useMutation({
    mutationFn: async ({ id, inputs, confidence }: { id: string; inputs: Record<string, unknown>[]; confidence: 0.8 | 0.9 | 0.95 }) =>
      (await api.post<{ target: string; predictions: Prediction[] }>(`/ml/models/${id}/predict`, { inputs, confidence })).data,
  });

export const useAutoDashboard = () =>
  useMutation({ mutationFn: async (b: { dataSourceId: string; schema: string; table: string }) => (await api.post<SuggestedDashboard>('/ml/auto-dashboard', b)).data });
