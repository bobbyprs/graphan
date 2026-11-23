import { z } from 'zod';
import { transformSchema } from '../queries/transforms';

export const PANEL_TYPES = [
  'line',
  'bar',
  'area',
  'pie',
  'scatter',
  'heatmap',
  'gauge',
  'kpi',
  'table',
  'treemap',
  'geomap',
  'text',
] as const;

export const gridPosSchema = z.object({
  x: z.number().int().min(0).max(23),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(24),
  h: z.number().int().min(1).max(100),
});

export const panelSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200).default(''),
  description: z.string().max(2000).optional(),
  type: z.enum(PANEL_TYPES),
  gridPos: gridPosSchema,
  dataSourceId: z.string().uuid().optional().nullable(),
  query: z.string().max(100_000).optional(),
  transforms: transformSchema.partial().optional(),
  /** Visualization options; validated loosely so the UI can evolve without migrations. */
  options: z.record(z.unknown()).default({}),
  /** Drill-down: clicking a datum sets dashboard variable `variable` to the value of `field`. */
  drilldown: z.object({ field: z.string(), variable: z.string() }).optional(),
  /** Per-panel override of dashboard refresh */
  cacheTtlSeconds: z.number().int().min(0).max(86_400).optional(),
});

export const variableSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/, 'Variable names must be identifiers'),
  label: z.string().max(100).optional(),
  type: z.enum(['custom', 'query', 'textbox', 'interval']),
  /** For "custom"/"interval": comma separated values */
  options: z.array(z.string().max(500)).max(1000).optional(),
  dataSourceId: z.string().uuid().optional().nullable(),
  query: z.string().max(20_000).optional(),
  multi: z.boolean().default(false),
  includeAll: z.boolean().default(false),
  default: z.union([z.string(), z.array(z.string())]).optional(),
});

export const dashboardDefinitionSchema = z.object({
  panels: z.array(panelSchema).max(200).default([]),
  variables: z.array(variableSchema).max(50).default([]),
  time: z.object({ from: z.string().max(64), to: z.string().max(64) }).default({ from: 'now-24h', to: 'now' }),
  timezone: z.string().max(64).default('browser'),
  graphTooltip: z.enum(['default', 'shared']).default('shared'),
});

export type DashboardDefinition = z.infer<typeof dashboardDefinitionSchema>;
export type Panel = z.infer<typeof panelSchema>;

export const dashboardInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).default([]),
  folderId: z.string().uuid().optional().nullable(),
  refreshInterval: z
    .string()
    .regex(/^\d+(s|m|h)$/)
    .optional()
    .nullable(),
  scheduleCron: z.string().max(100).optional().nullable(),
  isPrivate: z.boolean().default(false),
  isTemplate: z.boolean().default(false),
  definition: dashboardDefinitionSchema,
});

export const dashboardUpdateSchema = dashboardInputSchema.partial().extend({
  /** Optimistic concurrency: the version the client edited */
  version: z.number().int().positive(),
  message: z.string().max(500).optional(),
});

export const panelDataRequestSchema = z.object({
  timeRange: z.object({ from: z.string().max(64), to: z.string().max(64) }).optional(),
  variables: z.record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))])).default({}),
  /** Ad-hoc drill-down filters applied on top of the panel's transforms */
  filters: transformSchema.shape.filters.optional(),
  /** Bypass cache */
  fresh: z.boolean().default(false),
});
