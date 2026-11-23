import type { EChartsOption } from 'echarts';
import type { Theme } from '@mui/material';
import type { TrainResult } from '@/api/types';
import { SERIES_COLORS } from '@/theme/theme';
import { formatValue } from '@/utils/format';

const PRIMARY = SERIES_COLORS[2]; // blue
const SECONDARY = SERIES_COLORS[3]; // orange

function base(theme: Theme): EChartsOption {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.typography.fontFamily as string, color: theme.palette.text.secondary },
    animationDuration: 300,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      confine: true,
      backgroundColor: theme.palette.background.paper,
      borderColor: theme.palette.divider,
      textStyle: { color: theme.palette.text.primary, fontSize: 12 },
    },
  };
}

const axis = (theme: Theme) => ({
  axisLine: { lineStyle: { color: theme.palette.divider } },
  axisLabel: { color: theme.palette.text.secondary, hideOverlap: true, fontSize: 11 },
  splitLine: { lineStyle: { color: theme.palette.divider, type: 'dashed' as const } },
  nameTextStyle: { color: theme.palette.text.secondary, fontSize: 11 },
});

const compact = (v: number) => formatValue(v, 'short', 2);

export function importanceChart(r: TrainResult, theme: Theme): EChartsOption {
  const items = r.importance.slice(0, 15).reverse();
  return {
    ...base(theme),
    tooltip: { ...(base(theme).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${v}%` },
    xAxis: { type: 'value', max: 100, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, formatter: '{value}%' } },
    yAxis: { type: 'category', data: items.map((i) => i.feature), ...axis(theme), splitLine: { show: false } },
    series: [{ type: 'bar', data: items.map((i) => i.importance), itemStyle: { color: PRIMARY, borderRadius: [0, 4, 4, 0] }, barMaxWidth: 18, name: 'Importance' }],
  };
}

export function actualVsPredictedChart(r: TrainResult, theme: Theme): EChartsOption {
  const pts = r.diagnostics.actualVsPredicted;
  const all = pts.flat();
  // round the shared bounds outward to a "nice" step so both axes match and read cleanly
  const span = Math.max(...all) - Math.min(...all) || 1;
  const stepSize = 10 ** Math.floor(Math.log10(span));
  const lo = Math.floor(Math.min(...all) / stepSize) * stepSize;
  const hi = Math.ceil(Math.max(...all) / stepSize) * stepSize;
  return {
    ...base(theme),
    tooltip: { ...(base(theme).tooltip as object), trigger: 'item', formatter: (p: any) => (p.seriesIndex === 0 ? `Actual <b>${compact(p.value[0])}</b><br/>Predicted <b>${compact(p.value[1])}</b>` : 'Perfect prediction') },
    xAxis: { type: 'value', name: `Actual ${r.target}`, nameLocation: 'middle', nameGap: 26, min: lo, max: hi, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, formatter: compact } },
    yAxis: { type: 'value', name: 'Predicted', min: lo, max: hi, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, formatter: compact } },
    grid: { left: 8, right: 16, top: 24, bottom: 28, containLabel: true },
    series: [
      { type: 'scatter', data: pts, symbolSize: 8, itemStyle: { color: PRIMARY, opacity: 0.55, borderColor: theme.palette.background.paper, borderWidth: 1 } },
      { type: 'line', data: [[lo, lo], [hi, hi]], symbol: 'none', lineStyle: { color: theme.palette.text.secondary, type: 'dashed', width: 1 }, silent: true },
    ],
  };
}

export function residualChart(r: TrainResult, theme: Theme): EChartsOption {
  const h = r.diagnostics.residualHistogram;
  return {
    ...base(theme),
    tooltip: { ...(base(theme).tooltip as object), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: any) => `Error ${compact(h[p[0].dataIndex].x0)} – ${compact(h[p[0].dataIndex].x1)}<br/><b>${p[0].value}</b> rows` },
    xAxis: { type: 'category', data: h.map((b) => compact((b.x0 + b.x1) / 2)), name: 'Actual − predicted', nameLocation: 'middle', nameGap: 26, ...axis(theme), splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(theme) },
    grid: { left: 8, right: 16, top: 16, bottom: 28, containLabel: true },
    series: [{ type: 'bar', data: h.map((b) => b.count), barCategoryGap: '8%', itemStyle: { color: PRIMARY, borderRadius: [4, 4, 0, 0] } }],
  };
}

export function partialDependenceChart(pd: TrainResult['partialDependence'][number], target: string, theme: Theme): EChartsOption {
  const isCat = pd.kind === 'categorical';
  return {
    ...base(theme),
    tooltip: { ...(base(theme).tooltip as object), trigger: 'axis', valueFormatter: (v) => compact(v as number) },
    xAxis: isCat
      ? { type: 'category', data: pd.points.map((p) => String(p.x)), ...axis(theme), splitLine: { show: false } }
      : { type: 'value', scale: true, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, formatter: compact } },
    yAxis: { type: 'value', scale: true, name: `avg ${target}`, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, formatter: compact } },
    grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
    series: [
      isCat
        ? { type: 'bar', data: pd.points.map((p) => p.y), itemStyle: { color: SECONDARY, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 28, name: target }
        : { type: 'line', data: pd.points.map((p) => [p.x, p.y]), smooth: true, showSymbol: false, lineStyle: { width: 2, color: SECONDARY }, itemStyle: { color: SECONDARY }, name: target },
    ],
  };
}

export function correlationChart(fields: string[], matrix: number[][], theme: Theme): EChartsOption {
  const dark = theme.palette.mode === 'dark';
  const data = matrix.flatMap((row, i) => row.map((v, j) => [j, i, v]));
  return {
    ...base(theme),
    tooltip: { ...(base(theme).tooltip as object), trigger: 'item', formatter: (p: any) => `${fields[p.value[1]]} × ${fields[p.value[0]]}<br/>r = <b>${p.value[2].toFixed(2)}</b>` },
    grid: { left: 8, right: 16, top: 8, bottom: 40, containLabel: true },
    xAxis: { type: 'category', data: fields, ...axis(theme), axisLabel: { ...axis(theme).axisLabel, rotate: 35 }, splitLine: { show: false } },
    yAxis: { type: 'category', data: fields, inverse: true, ...axis(theme), splitLine: { show: false } },
    visualMap: {
      min: -1,
      max: 1,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 140,
      itemWidth: 10,
      calculable: false,
      textStyle: { color: theme.palette.text.secondary, fontSize: 10 },
      // diverging: blue (negative) → neutral grey → orange (positive)
      inRange: { color: ['#3274D9', dark ? '#3a3d44' : '#e9e9ee', '#FF780A'] },
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: fields.length <= 10, formatter: (p: any) => p.value[2].toFixed(1), fontSize: 10, color: theme.palette.text.primary },
        itemStyle: { borderColor: theme.palette.background.paper, borderWidth: 2 },
      },
    ],
  };
}
