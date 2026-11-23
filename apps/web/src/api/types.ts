export type Role = 'ADMIN' | 'DEVELOPER' | 'ANALYST' | 'VIEWER';
export type DataSourceType = 'POSTGRES' | 'MYSQL' | 'MSSQL' | 'ORACLE' | 'MONGODB' | 'SQLITE';
export type ConnectionStatus = 'UNKNOWN' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type PermissionLevel = 'VIEW' | 'EDIT' | 'ADMIN';
export type AlertState = 'OK' | 'PENDING' | 'FIRING' | 'NO_DATA' | 'ERROR';

export interface Me {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  memberships: { role: Role; workspace: { id: string; name: string; slug: string } }[];
}

export interface DataSourceOptions {
  ssl?: boolean;
  sslRejectUnauthorized?: boolean;
  poolMin?: number;
  poolMax?: number;
  idleTimeoutMs?: number;
  filePath?: string;
  defaultSchema?: string;
  serviceName?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  instanceName?: string;
  authSource?: string;
}

export interface DataSource {
  id: string;
  name: string;
  type: DataSourceType;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  readOnly: boolean;
  options: DataSourceOptions;
  status: ConnectionStatus;
  lastCheckedAt?: string | null;
  lastLatencyMs?: number | null;
  lastError?: string | null;
  hasPassword: boolean;
  hasConnectionString: boolean;
  updatedAt: string;
}

export interface DataSourceInput {
  name: string;
  type: DataSourceType;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string;
  connectionString?: string;
  readOnly: boolean;
  options: DataSourceOptions;
}

export interface ColumnMeta {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  affectedRows?: number;
  cached?: boolean;
  meta?: { forecast?: ForecastMeta[]; warnings?: string[] };
}

// ───────────── Forecasting & ML ─────────────

export type TsModelId = 'naive' | 'drift' | 'seasonal_naive' | 'ses' | 'holt' | 'holt_winters' | 'holt_winters_mul' | 'theta' | 'fourier' | 'ar' | 'ensemble';

export interface ForecastConfig {
  enabled: boolean;
  xField?: string;
  fields?: string[];
  horizon: number;
  model: 'auto' | TsModelId;
  seasonality: 'auto' | 'none' | number;
  confidence: number;
  anomalies: boolean;
  sensitivity: 'low' | 'medium' | 'high';
}

export interface ForecastMeta {
  field: string;
  xField: string;
  model: string;
  label: string;
  period: number | null;
  seasonalStrength: number | null;
  horizon: number;
  confidence: number;
  metrics: { mase: number; smape: number; rmse: number };
  leaderboard: { id: string; label: string; mase: number; smape: number; rmse: number }[];
  backtest: { horizon: number; origins: number };
  trendPct: number | null;
  next: { x: unknown; yhat: number; lower: number; upper: number } | null;
  last: number | null;
  anomalyCount: number;
  step: string;
  partial?: boolean;
  error?: string;
}

export type RegressionModelId =
  | 'baseline'
  | 'linear'
  | 'ridge'
  | 'lasso'
  | 'elastic_net'
  | 'polynomial'
  | 'knn'
  | 'decision_tree'
  | 'random_forest'
  | 'gradient_boosting';

export type ColumnKind = 'numeric' | 'categorical' | 'datetime' | 'boolean' | 'text' | 'identifier' | 'empty';

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  completeness: number;
  distinct: number;
  stats?: { mean: number; std: number; min: number; p25: number; median: number; p75: number; max: number; zeros: number };
  top?: { value: string; count: number }[];
  range?: { from: string; to: string };
  histogram?: { x0: number; x1: number; count: number }[];
  note?: string;
}

export interface ProfileResult {
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  columns: ColumnProfile[];
  correlations: { fields: string[]; matrix: number[][] };
  suggestions: { targets: string[]; timeField: string | null; forecastFields: string[] };
  preview: { columns: ColumnMeta[]; rows: Record<string, unknown>[] };
}

export interface LeaderboardEntry {
  id: RegressionModelId;
  label: string;
  family: string;
  description: string;
  r2: number;
  rmse: number;
  mae: number;
  mape: number | null;
  trainMs: number;
  params?: Record<string, number>;
  liftPct: number | null;
}

export interface FeatureInput {
  name: string;
  kind: ColumnKind;
  default: string | number | null;
  min?: number;
  max?: number;
  options?: string[];
}

export interface TrainResult {
  model: { id: string; name: string; createdAt: string };
  target: string;
  rows: { total: number; used: number; cv: number };
  folds: number;
  features: FeatureInput[];
  excluded: { name: string; reason: string }[];
  warnings: string[];
  leaderboard: LeaderboardEntry[];
  best: RegressionModelId;
  importance: { feature: string; importance: number; rmseIncrease: number }[];
  partialDependence: { feature: string; kind: 'numeric' | 'categorical'; points: { x: string | number; y: number }[] }[];
  coefficients: { name: string; coef: number }[] | null;
  diagnostics: { actualVsPredicted: [number, number][]; residualHistogram: { x0: number; x1: number; count: number }[] };
  targetStats: { mean: number; median: number; min: number; max: number };
  durationMs: number;
  /** present when re-opened from the registry */
  sql?: string;
  dataSourceId?: string | null;
}

export interface MlModelSummary {
  id: string;
  name: string;
  target: string;
  algorithm: RegressionModelId;
  metrics: { r2: number; rmse: number; mae: number; mape: number | null };
  createdAt: string;
  dataSource?: { id: string; name: string; type: DataSourceType } | null;
  owner: { id: string; name: string };
}

export interface Prediction {
  prediction: number;
  lower: number;
  upper: number;
}

export interface SuggestedDashboard {
  title: string;
  description: string;
  definition: DashboardDefinition;
  insights: string[];
}

export interface DbObject {
  schema: string;
  name: string;
  kind: DbObjectKind;
  rowEstimate?: number | null;
}

export type DbObjectKind = 'table' | 'view' | 'materialized_view' | 'procedure' | 'function' | 'sequence' | 'collection';

export interface QueryErrorDetails {
  position?: number;
  hint?: string;
  detail?: string;
  code?: string;
  where?: string;
}

export interface ExplainResult {
  format: 'postgres-json' | 'text';
  plan?: unknown;
  text?: string;
  durationMs: number;
}

export interface TableDetails {
  schema: string;
  name: string;
  columns: { name: string; dataType: string; nullable: boolean; defaultValue?: string | null; isPrimaryKey: boolean; maxLength?: number | null; ordinal: number }[];
  indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[];
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[] }[];
  referencedBy: { schema: string; table: string; name: string }[];
  stats: { rowCount: number | null; totalBytes?: number | null; lastAnalyzed?: string | null };
}

export type PanelType = 'line' | 'bar' | 'area' | 'pie' | 'scatter' | 'heatmap' | 'gauge' | 'kpi' | 'table' | 'treemap' | 'geomap' | 'text';

export interface Filter {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  value: string | number | boolean | (string | number)[];
}

export interface Transforms {
  filters?: Filter[];
  calculatedFields?: { name: string; expression: string }[];
  groupBy?: { fields: string[]; aggregations: { field: string; fn: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct' | 'first' | 'last'; as?: string }[] };
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  forecast?: ForecastConfig;
}

export interface PanelOptions {
  xField?: string;
  yField?: string;
  yFields?: string[];
  rightAxisFields?: string[];
  seriesField?: string;
  valueField?: string;
  labelField?: string;
  latField?: string;
  lonField?: string;
  groupFields?: string[];
  stacked?: boolean;
  smooth?: boolean;
  horizontal?: boolean;
  donut?: boolean;
  unit?: 'none' | 'short' | 'percent' | 'currency' | 'bytes' | 'ms' | 's';
  decimals?: number;
  min?: number;
  max?: number;
  color?: string;
  sparkline?: boolean;
  reducer?: 'last' | 'first' | 'sum' | 'avg' | 'min' | 'max';
  thresholds?: { value: number; color: string }[];
  content?: string;
  pageSize?: number;
  showLegend?: boolean;
  /** Render with holograph-3d (WebGL2) instead of ECharts. */
  render3d?: boolean;
  [key: string]: unknown;
}

export interface Panel {
  id: string;
  title: string;
  description?: string;
  type: PanelType;
  gridPos: { x: number; y: number; w: number; h: number };
  dataSourceId?: string | null;
  query?: string;
  transforms?: Transforms;
  options: PanelOptions;
  drilldown?: { field: string; variable: string };
  cacheTtlSeconds?: number;
}

export interface Variable {
  name: string;
  label?: string;
  type: 'custom' | 'query' | 'textbox' | 'interval';
  options?: string[];
  dataSourceId?: string | null;
  query?: string;
  multi: boolean;
  includeAll: boolean;
  default?: string | string[];
}

export interface DashboardDefinition {
  panels: Panel[];
  variables: Variable[];
  time: { from: string; to: string };
  timezone: string;
  graphTooltip: 'default' | 'shared';
}

export interface DashboardSummary {
  id: string;
  title: string;
  description?: string | null;
  tags: string[];
  isPrivate: boolean;
  isTemplate: boolean;
  refreshInterval?: string | null;
  version: number;
  updatedAt: string;
  shareToken?: string | null;
  embedEnabled?: boolean;
  owner: { id: string; name: string };
  folder?: { id: string; name: string } | null;
}

export interface Dashboard extends Omit<DashboardSummary, 'owner' | 'folder'> {
  definition: DashboardDefinition;
  scheduleCron?: string | null;
  access: PermissionLevel;
  /** Embedded view only: variables fixed by the host application's signed token */
  lockedParams?: string[];
  permissions?: { id: string; userId?: string | null; teamId?: string | null; level: PermissionLevel }[];
}

export interface DashboardTemplate {
  id: string;
  title: string;
  description: string;
  tags: string[];
  dataSourceType: 'POSTGRES' | 'ANY';
  panelCount: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  sql: string;
  isFavorite: boolean;
  tags: string[];
  dataSourceId: string;
  dataSource: { id: string; name: string; type: DataSourceType };
  updatedAt: string;
}

export interface QueryHistoryItem {
  id: string;
  sql: string;
  durationMs: number;
  rowCount?: number | null;
  success: boolean;
  error?: string | null;
  createdAt: string;
  dataSource: { id: string; name: string; type: DataSourceType };
}

export interface AlertCondition {
  field: string;
  reducer: 'last' | 'avg' | 'min' | 'max' | 'sum' | 'count';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  lookback: string;
  noDataState: 'OK' | 'NO_DATA' | 'FIRING';
}

export interface AlertRule {
  id: string;
  name: string;
  description?: string | null;
  dataSourceId: string;
  query: string;
  condition: AlertCondition;
  intervalSeconds: number;
  forSeconds: number;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
  state: AlertState;
  lastEvaluatedAt?: string | null;
  lastValue?: number | null;
  dataSource: { id: string; name: string; type: DataSourceType };
  channels: { channel: { id: string; name: string; type: 'EMAIL' | 'TEAMS' } }[];
}

export interface AlertEvent {
  id: string;
  fromState: AlertState;
  toState: AlertState;
  value?: number | null;
  message: string;
  acknowledgedAt?: string | null;
  createdAt: string;
  rule: { id: string; name: string; severity: string };
  ackUser?: { id: string; name: string } | null;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'EMAIL' | 'TEAMS';
  config: { recipients?: string[]; webhookHost?: string };
}

export interface Member {
  id: string;
  role: Role;
  createdAt: string;
  user: { id: string; email: string; name: string; isActive: boolean; lastLoginAt?: string | null };
}

export interface Team {
  id: string;
  name: string;
  description?: string | null;
  members: { user: { id: string; name: string; email: string } }[];
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: unknown;
  ip?: string | null;
  createdAt: string;
  user?: { id: string; name: string; email: string } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}
