import { lazy, Suspense, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { Box, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import Markdown from 'react-markdown';
import type { Annotation, Panel, QueryResult } from '@/api/types';
import { formatValue, thresholdColor } from '@/utils/format';
import { HOLOGRAPH_TYPES, supportsWebGL2 } from './holographSupport';
import { buildCartesian, buildGauge, buildHeatmap, buildPie, buildScatter, buildTreemap, historyOnly, resolveFields } from './echartsOptions';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';

const ResultsGrid = lazy(() => import('@/components/common/ResultsGrid').then((m) => ({ default: m.ResultsGrid })));
const Holograph3DPanel = lazy(() => import('./Holograph3DPanel').then((m) => ({ default: m.Holograph3DPanel })));
const GeoMapPanel = lazy(() => import('./GeoMapPanel').then((m) => ({ default: m.GeoMapPanel })));

type Row = Record<string, unknown>;

function reduceValues(values: number[], reducer: Panel['options']['reducer'] = 'last'): number {
  if (!values.length) return NaN;
  switch (reducer) {
    case 'first':
      return values[0];
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return values[values.length - 1];
  }
}

function KpiPanel({ panel, result: full }: { panel: Panel; result: QueryResult }) {
  const theme = useTheme();
  const o = panel.options;
  const result = historyOnly(full);
  const { valueField, xField } = resolveFields(panel, result);
  const values = result.rows.map((r) => Number(r[valueField!])).filter((n) => Number.isFinite(n));
  const value = reduceValues(values, o.reducer);
  const color = o.thresholds?.length ? thresholdColor(value, o.thresholds) : (o.color ?? theme.palette.text.primary);
  const sparkOption = useMemo(
    () =>
      o.sparkline && values.length > 1
        ? {
            grid: { left: 0, right: 0, top: 0, bottom: 0 },
            xAxis: { type: 'category' as const, show: false, data: result.rows.map((r) => r[xField ?? '']) },
            yAxis: { type: 'value' as const, show: false },
            series: [{ type: 'line' as const, data: values, showSymbol: false, smooth: true, lineStyle: { color, width: 1.5 }, areaStyle: { color, opacity: 0.15 } }],
          }
        : null,
    [o.sparkline, values, result.rows, xField, color],
  );
  return (
    <Stack sx={{ height: '100%', position: 'relative' }} justifyContent="center" alignItems="center">
      <Typography sx={{ fontSize: 'clamp(22px, 4.2vw, 46px)', fontWeight: 600, color, zIndex: 1, lineHeight: 1.1 }}>
        {formatValue(value, o.unit, o.decimals)}
      </Typography>
      <KpiForecast panel={panel} result={full} valueField={valueField} />
      {sparkOption && (
        <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '45%' }}>
          <ReactECharts option={sparkOption} style={{ height: '100%' }} />
        </Box>
      )}
    </Stack>
  );
}

/** "Next: 1.2k ▲ 4.1%" under a KPI when the panel has a forecast for its value field. */
function KpiForecast({ panel, result, valueField }: { panel: Panel; result: QueryResult; valueField?: string }) {
  const m = result.meta?.forecast?.find((f) => f.field === valueField && !f.error && f.next);
  if (!m?.next) return null;
  const last = m.last ?? 0;
  const pct = last ? ((m.next.yhat - last) / Math.abs(last)) * 100 : 0;
  const Icon = Math.abs(pct) < 0.5 ? TrendingFlatIcon : pct > 0 ? TrendingUpIcon : TrendingDownIcon;
  const fmt = (v: number) => formatValue(v, panel.options.unit, panel.options.decimals);
  return (
    <Tooltip
      title={`${m.label} forecast for ${m.partial ? 'the current (incomplete)' : 'the next'} ${m.step}: ${fmt(m.next.yhat)} (${Math.round(m.confidence * 100)}% interval ${fmt(m.next.lower)} – ${fmt(m.next.upper)}), compared with the last complete period (${fmt(last)})`}
    >
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ zIndex: 1, color: 'text.secondary', mt: 0.5, cursor: 'help', bgcolor: 'surface.panel', px: 0.75, py: 0.125, borderRadius: 1, border: 1, borderColor: 'divider' }}
      >
        <Icon sx={{ fontSize: 16 }} />
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {m.partial ? 'Tracking to' : 'Next'} {fmt(m.next.yhat)} · {pct >= 0 ? '+' : ''}
          {pct.toFixed(1)}%
        </Typography>
      </Stack>
    </Tooltip>
  );
}

interface Props {
  panel: Panel;
  result: QueryResult;
  annotations?: Annotation[];
  onDrill?: (row: Row) => void;
}

/** Renders a panel's data with the configured visualization. */
export function PanelRenderer({ panel, result: full, annotations, onDrill }: Props) {
  const theme = useTheme();
  // Only time-series charts and tables render forecast rows; everything else sees real data
  const result = useMemo(() => (['line', 'area', 'bar', 'kpi', 'table'].includes(panel.type) ? full : historyOnly(full)), [panel.type, full]);

  const option = useMemo(() => {
    switch (panel.type) {
      case 'line':
      case 'area':
      case 'bar':
        return buildCartesian(panel, result, theme, annotations);
      case 'pie':
        return buildPie(panel, result, theme);
      case 'scatter':
        return buildScatter(panel, result, theme);
      case 'heatmap':
        return buildHeatmap(panel, result, theme);
      case 'treemap':
        return buildTreemap(panel, result, theme);
      case 'gauge': {
        const { valueField } = resolveFields(panel, result);
        const vals = result.rows.map((r) => Number(r[valueField!])).filter(Number.isFinite);
        return buildGauge(panel, reduceValues(vals, panel.options.reducer), theme);
      }
      default:
        return null;
    }
  }, [panel, result, theme, annotations]);

  if (panel.type === 'text') {
    return (
      <Box sx={{ p: 1, overflow: 'auto', height: '100%', '& h1,& h2,& h3': { mt: 0 }, '& a': { color: 'primary.main' }, fontSize: 14 }}>
        <Markdown>{String(panel.options.content ?? '')}</Markdown>
      </Box>
    );
  }

  if (!result.rows.length) {
    return (
      <Stack height="100%" alignItems="center" justifyContent="center">
        <Typography variant="body2" color="text.secondary">
          No data
        </Typography>
      </Stack>
    );
  }

  if (panel.type === 'kpi') return <KpiPanel panel={panel} result={result} />;
  if (panel.type === 'table')
    return (
      <Suspense fallback={null}>
        <ResultsGrid result={result} pageSize={panel.options.pageSize ?? 20} onRowClick={onDrill} />
      </Suspense>
    );
  if (panel.type === 'geomap')
    return (
      <Suspense fallback={null}>
        <GeoMapPanel panel={panel} result={result} onDrill={onDrill} />
      </Suspense>
    );

  if (panel.options.render3d && HOLOGRAPH_TYPES.includes(panel.type) && supportsWebGL2())
    return (
      <Suspense fallback={null}>
        <Holograph3DPanel panel={panel} result={result} />
      </Suspense>
    );

  // Click → drill-down: map the clicked datum back to its source row
  const onClick = (p: { name?: string; seriesName?: string; dataIndex?: number; value?: unknown }) => {
    if (!onDrill || !panel.drilldown) return;
    const f = panel.drilldown.field;
    const candidate = [p.name, p.seriesName, Array.isArray(p.value) ? p.value[0] : undefined].map((x) => (x == null ? x : String(x)));
    const row = result.rows.find((r) => candidate.includes(String(r[f]))) ?? (p.dataIndex != null ? result.rows[p.dataIndex] : undefined);
    if (row) onDrill(row);
  };

  return (
    <ReactECharts
      option={option ?? {}}
      notMerge
      lazyUpdate
      style={{ height: '100%', width: '100%', cursor: panel.drilldown ? 'pointer' : undefined }}
      onEvents={{ click: onClick }}
      opts={{ renderer: 'canvas' }}
    />
  );
}
