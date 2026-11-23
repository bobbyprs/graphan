import type { EChartsOption, SeriesOption } from 'echarts';
import type { Theme } from '@mui/material';
import type { Annotation, Panel, QueryResult } from '@/api/types';
import { SERIES_COLORS } from '@/theme/theme';
import { formatValue, thresholdColor } from '@/utils/format';

type Row = Record<string, unknown>;
type Cell = string | number | null;
const cell = (v: unknown): Cell => (v === undefined ? null : (v as Cell));

const TIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;

/** Columns produced by the forecast transform (never picked as regular fields). */
export const isForecastColumn = (n: string) => n === '__future' || /__(forecast|lower|upper|anomaly)$/.test(n);
export const FC = {
  forecast: (f: string) => `${f}__forecast`,
  lower: (f: string) => `${f}__lower`,
  upper: (f: string) => `${f}__upper`,
  anomaly: (f: string) => `${f}__anomaly`,
};
/** Status "critical" - reserved for anomalies, never used as a series colour. */
export const ANOMALY_COLOR = '#F2495C';

/** Strips forecast rows/columns so non time-series visualisations only see real data. */
export function historyOnly(result: QueryResult): QueryResult {
  if (!result.meta?.forecast?.length) return result;
  const rows = result.rows.filter((r) => !r.__future);
  return { ...result, rows, rowCount: rows.length, columns: result.columns.filter((c) => !isForecastColumn(c.name)) };
}

function isTimeColumn(rows: Row[], field: string) {
  const v = rows.find((r) => r[field] != null)?.[field];
  return typeof v === 'string' && TIME_RE.test(v);
}

function firstNumericField(result: QueryResult, exclude: string[] = []): string | undefined {
  return result.columns.find((c) => !exclude.includes(c.name) && !isForecastColumn(c.name) && result.rows.some((r) => typeof r[c.name] === 'number'))?.name;
}

function firstField(result: QueryResult, exclude: string[] = []) {
  return result.columns.find((c) => !exclude.includes(c.name) && !isForecastColumn(c.name))?.name;
}

/** Resolves sensible defaults when options are not configured. */
export function resolveFields(panel: Panel, result: QueryResult) {
  const o = panel.options;
  const xField = o.xField ?? result.columns.find((c) => !isForecastColumn(c.name) && isTimeColumn(result.rows, c.name))?.name ?? firstField(result);
  const yFields =
    o.yFields?.length
      ? o.yFields
      : result.columns
          .filter((c) => c.name !== xField && c.name !== o.seriesField && !isForecastColumn(c.name) && result.rows.some((r) => typeof r[c.name] === 'number'))
          .map((c) => c.name);
  const valueField = o.valueField ?? firstNumericField(result) ?? result.columns[0]?.name;
  const labelField = o.labelField ?? firstField(result, valueField ? [valueField] : []);
  return { xField, yFields, valueField, labelField };
}

function baseOption(theme: Theme, panel: Panel): EChartsOption {
  const text = theme.palette.text.secondary;
  const grid = theme.palette.divider;
  return {
    color: SERIES_COLORS,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.typography.fontFamily as string, color: text },
    animationDuration: 300,
    legend: panel.options.showLegend === false ? undefined : { bottom: 0, type: 'scroll', textStyle: { color: text }, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: theme.palette.background.paper,
      borderColor: grid,
      textStyle: { color: theme.palette.text.primary },
      valueFormatter: (v) => formatValue(v as number, panel.options.unit, panel.options.decimals),
    },
    grid: { left: 8, right: 16, top: 16, bottom: panel.options.showLegend === false ? 8 : 32, containLabel: true },
  };
}

function axisStyle(theme: Theme) {
  return {
    axisLine: { lineStyle: { color: theme.palette.divider } },
    axisLabel: { color: theme.palette.text.secondary, hideOverlap: true },
    splitLine: { lineStyle: { color: theme.palette.divider, type: 'dashed' as const } },
  };
}

/** Converts long-format rows (x, series, value) into one series per distinct series value. */
function pivot(rows: Row[], x: string, seriesField: string, y: string) {
  const series = new Map<string, [Cell, Cell][]>();
  for (const r of rows) {
    const key = String(r[seriesField] ?? 'null');
    if (!series.has(key)) series.set(key, []);
    series.get(key)!.push([cell(r[x]), cell(r[y])]);
  }
  return series;
}

export function buildCartesian(panel: Panel, result: QueryResult, theme: Theme, annotations: Annotation[] = []): EChartsOption {
  const o = panel.options;
  const { xField, yFields } = resolveFields(panel, result);
  if (!xField) return {};
  const isTime = isTimeColumn(result.rows, xField);
  const type = panel.type === 'bar' ? 'bar' : 'line';
  const area = panel.type === 'area';
  const horizontal = panel.type === 'bar' && o.horizontal;
  const right = new Set(o.rightAxisFields ?? []);

  const mk = (name: string, data: [Cell, Cell][], useRight: boolean): SeriesOption => ({
    name,
    type,
    data: horizontal ? data.map(([a, b]) => [b, a]) : data,
    smooth: o.smooth ?? false,
    showSymbol: data.length < 60,
    symbolSize: 5,
    stack: o.stacked ? 'total' : undefined,
    areaStyle: area ? { opacity: 0.25 } : undefined,
    lineStyle: { width: 2 },
    barMaxWidth: 48,
    yAxisIndex: useRight && !horizontal ? 1 : 0,
    emphasis: { focus: 'series' },
  });

  const series: SeriesOption[] = [];
  const fcMeta = new Map((result.meta?.forecast ?? []).filter((m) => !m.error).map((m) => [m.field, m]));
  const withForecast = !o.seriesField && !horizontal && yFields.some((y) => fcMeta.has(y));
  const legendNames: string[] = [];
  if (o.seriesField) {
    const y = yFields[0];
    pivot(result.rows, xField, o.seriesField, y).forEach((data, name) => series.push(mk(name, data, false)));
  } else {
    yFields.forEach((y, i) => {
      // colour follows the entity: the forecast, band and base series share one hue
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const hasFc = withForecast && fcMeta.has(y);
      const base = mk(y, result.rows.map((r) => [cell(r[xField]), r.__future || (hasFc && r.__partial) ? null : cell(r[y])]), right.has(y));
      series.push(withForecast ? ({ ...base, color } as SeriesOption) : base);
      legendNames.push(y);
      const inProgress = hasFc ? result.rows.filter((r) => r.__partial && r[y] != null) : [];
      if (inProgress.length && panel.type !== 'bar')
        // the incomplete current period: shown as a hollow point, not as a cliff in the line
        series.push({ name: y, id: `partial-${y}`, type: 'scatter', yAxisIndex: right.has(y) ? 1 : 0, data: inProgress.map((r) => [cell(r[xField]), cell(r[y])]), symbol: 'emptyCircle', symbolSize: 8, color, z: 4 } as SeriesOption);
      if (!withForecast || !fcMeta.has(y)) return;
      series.push(...forecastSeries(panel, result, xField, y, color, right.has(y), theme));
      legendNames.push(`${y} forecast`);
    });
    if (withForecast && result.rows.some((r) => yFields.some((y) => r[FC.anomaly(y)] != null))) legendNames.push('Anomaly');
  }

  const catAxis = { type: isTime ? ('time' as const) : ('category' as const), ...axisStyle(theme), splitLine: { show: false } };
  const valAxis = { type: 'value' as const, ...axisStyle(theme), axisLabel: { ...axisStyle(theme).axisLabel, formatter: (v: number) => formatValue(v, o.unit, 0) } };

  // Grafana-style annotations: dashed vertical markers (and shaded regions) on time axes.
  if (isTime && annotations.length && series.length) {
    const s0 = series[0] as SeriesOption & { markLine?: unknown; markArea?: unknown };
    const points = annotations.filter((a) => !a.timeEnd).map((a) => ({ xAxis: new Date(a.time).getTime(), name: a.text }));
    const regions = annotations
      .filter((a) => a.timeEnd)
      .map((a) => [{ xAxis: new Date(a.time).getTime(), name: a.text }, { xAxis: new Date(a.timeEnd as string).getTime() }]);
    if (points.length) {
      s0.markLine = {
        symbol: ['none', 'none'],
        silent: false,
        lineStyle: { color: theme.palette.text.disabled, type: 'dashed', width: 1 },
        label: { show: true, formatter: (pp: { name?: string }) => pp.name ?? '', color: theme.palette.text.secondary, fontSize: 10, position: 'insideEndTop' },
        data: points,
      };
    }
    if (regions.length) {
      s0.markArea = { silent: true, itemStyle: { color: theme.palette.action.hover }, data: regions };
    }
  }

  const base = baseOption(theme, panel);
  return {
    ...base,
    ...(withForecast
      ? {
          legend: base.legend ? { ...(base.legend as object), data: legendNames } : undefined,
          tooltip: { ...(base.tooltip as object), formatter: forecastTooltip(panel, result, theme) },
        }
      : {}),
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal
      ? { ...catAxis, type: 'category', inverse: true }
      : right.size
        ? [valAxis, { ...valAxis, splitLine: { show: false }, axisLabel: { color: theme.palette.text.secondary } }]
        : valAxis,
    series,
    dataZoom: isTime && result.rows.length > 50 ? [{ type: 'inside' }] : undefined,
  };
}

/** Forecast line + prediction band + anomaly markers for one field. */
function forecastSeries(panel: Panel, result: QueryResult, xField: string, y: string, color: string, useRight: boolean, theme: Theme): SeriesOption[] {
  const rows = result.rows;
  const name = `${y} forecast`;
  const isBar = panel.type === 'bar';
  const x = (r: Record<string, unknown>) => cell(r[xField]);
  const firstFuture = rows.find((r) => r.__future || r.__partial);
  const lastFuture = [...rows].reverse().find((r) => r.__future);
  const yAxisIndex = useRight ? 1 : 0;
  const out: SeriesOption[] = [];
  out.push({
    name,
    id: `fc-${y}`,
    type: isBar ? 'bar' : 'line',
    yAxisIndex,
    data: rows.map((r) => [x(r), isBar && !r.__future ? null : cell(r[FC.forecast(y)])]),
    color,
    showSymbol: false,
    symbolSize: 5,
    smooth: panel.options.smooth ?? false,
    lineStyle: { width: 2, type: [6, 4] },
    itemStyle: isBar ? { color, opacity: 0.45, borderColor: color, borderType: 'dashed', borderWidth: 1 } : { color },
    barMaxWidth: 48,
    z: 3,
    emphasis: { focus: 'series' },
    markArea:
      firstFuture && lastFuture
        ? {
            silent: true,
            itemStyle: { color: theme.palette.mode === 'dark' ? 'rgba(204,204,220,0.04)' : 'rgba(36,41,46,0.035)' },
            label: { show: true, position: 'insideTopLeft', color: theme.palette.text.secondary, fontSize: 10, formatter: 'Forecast' },
            data: [[{ xAxis: x(firstFuture) as string | number }, { xAxis: x(lastFuture) as string | number }]],
          }
        : undefined,
  } as SeriesOption);
  if (!isBar) {
    const lower = rows.map((r) => [x(r), cell(r[FC.lower(y)])] as [Cell, Cell]);
    const width = rows.map((r) => {
      const lo = r[FC.lower(y)];
      const hi = r[FC.upper(y)];
      return [x(r), typeof lo === 'number' && typeof hi === 'number' ? hi - lo : null] as [Cell, Cell];
    });
    // the band is "lower" + stacked "width"; stackStrategy 'all' keeps it right when it crosses zero
    const band = { name, type: 'line' as const, yAxisIndex, stack: `band-${y}`, stackStrategy: 'all' as const, symbol: 'none', silent: true, lineStyle: { opacity: 0 }, z: 1, smooth: panel.options.smooth ?? false };
    out.push({ ...band, id: `band-lo-${y}`, data: lower, color } as SeriesOption);
    out.push({ ...band, id: `band-hi-${y}`, data: width, color, areaStyle: { color, opacity: 0.16 } } as SeriesOption);
  }
  const anomalies = rows.filter((r) => r[FC.anomaly(y)] != null).map((r) => [x(r), cell(r[FC.anomaly(y)])]);
  if (anomalies.length) {
    out.push({
      name: 'Anomaly',
      id: `anom-${y}`,
      type: 'scatter',
      yAxisIndex,
      data: anomalies,
      symbolSize: 10,
      z: 5,
      itemStyle: { color: ANOMALY_COLOR, borderColor: theme.palette.background.paper, borderWidth: 2 },
    } as SeriesOption);
  }
  return out;
}

function forecastTooltip(panel: Panel, result: QueryResult, theme: Theme) {
  const fmt = (v: unknown) => formatValue(v as number, panel.options.unit, panel.options.decimals);
  const muted = theme.palette.text.secondary;
  return (raw: unknown) => {
    const params = (Array.isArray(raw) ? raw : [raw]) as { seriesId?: string; seriesName: string; marker: string; value: unknown; dataIndex: number; axisValueLabel?: string }[];
    if (!params.length) return '';
    const main = params.find((p) => !p.seriesId?.startsWith('anom-')) ?? params[0];
    const row = result.rows[main.dataIndex] ?? {};
    const lines: string[] = [];
    for (const p of params) {
      if (p.seriesId?.startsWith('band-')) continue;
      const v = Array.isArray(p.value) ? p.value[1] : p.value;
      if (v == null) continue;
      if (p.seriesId?.startsWith('fc-')) {
        const y = p.seriesId.slice(3);
        const lo = row[FC.lower(y)];
        const hi = row[FC.upper(y)];
        if (!row.__future && !row.__partial) continue; // the bridge point repeats the actual value
        lines.push(`${p.marker}${p.seriesName}: <b>${fmt(v)}</b>${lo != null ? ` <span style="color:${muted}">${fmt(lo)} – ${fmt(hi)}</span>` : ''}`);
      } else if (p.seriesId?.startsWith('anom-')) lines.push(`${p.marker}<b>Anomaly</b> ${fmt(v)}`);
      else if (p.seriesId?.startsWith('partial-')) lines.push(`${p.marker}${p.seriesName} so far: <b>${fmt(v)}</b> <span style="color:${muted}">(period in progress)</span>`);
      else lines.push(`${p.marker}${p.seriesName}: <b>${fmt(v)}</b>`);
    }
    const header = main.axisValueLabel ?? '';
    const tag = row.__future ? ' · forecast' : row.__partial ? ' · in progress' : '';
    return `<div style="font-size:12px;margin-bottom:2px">${header}${tag ? ` <span style="color:${muted}">${tag}</span>` : ''}</div>${lines.join('<br/>')}`;
  };
}

export function buildPie(panel: Panel, result: QueryResult, theme: Theme): EChartsOption {
  const { valueField, labelField } = resolveFields(panel, result);
  if (!valueField || !labelField) return {};
  return {
    ...baseOption(theme, panel),
    tooltip: { trigger: 'item', valueFormatter: (v) => formatValue(v as number, panel.options.unit, panel.options.decimals) },
    legend: { orient: 'vertical', right: 0, top: 'middle', type: 'scroll', textStyle: { color: theme.palette.text.secondary } },
    series: [
      {
        type: 'pie',
        radius: panel.options.donut ? ['45%', '75%'] : '75%',
        center: ['40%', '50%'],
        itemStyle: { borderColor: theme.palette.background.paper, borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontWeight: 'bold', color: theme.palette.text.primary } },
        data: result.rows.map((r) => ({ name: String(r[labelField]), value: Number(r[valueField]) })),
      },
    ],
  };
}

export function buildScatter(panel: Panel, result: QueryResult, theme: Theme): EChartsOption {
  const o = panel.options;
  const nums = result.columns.filter((c) => result.rows.some((r) => typeof r[c.name] === 'number')).map((c) => c.name);
  const x = o.xField ?? nums[0];
  const y = o.yField ?? nums[1];
  if (!x || !y) return {};
  const groups = o.seriesField ? pivot(result.rows, x, o.seriesField, y) : new Map([[y, result.rows.map((r) => [cell(r[x]), cell(r[y])] as [Cell, Cell])]]);
  return {
    ...baseOption(theme, panel),
    tooltip: { trigger: 'item', formatter: (p: any) => `${p.seriesName}<br/>${x}: ${p.value[0]}<br/>${y}: ${p.value[1]}` },
    grid: { left: 8, right: 16, top: 16, bottom: panel.options.showLegend === false ? 28 : 52, containLabel: true },
    xAxis: { type: 'value', name: x, nameLocation: 'middle', nameGap: 24, ...axisStyle(theme) },
    yAxis: { type: 'value', name: y, ...axisStyle(theme) },
    series: [...groups].map(([name, data]) => ({ name, type: "scatter" as const, data, symbolSize: 6, itemStyle: { opacity: 0.7 } })),
  };
}

export function buildHeatmap(panel: Panel, result: QueryResult, theme: Theme): EChartsOption {
  const o = panel.options;
  const cols = result.columns.map((c) => c.name);
  const x = o.xField ?? cols[0];
  const y = o.yField ?? cols[1];
  const v = o.valueField ?? cols[2];
  if (!x || !y || !v) return {};
  const xs = [...new Set(result.rows.map((r) => String(r[x])))];
  const ys = [...new Set(result.rows.map((r) => String(r[y])))];
  const xi = new Map(xs.map((k, i) => [k, i]));
  const yi = new Map(ys.map((k, i) => [k, i]));
  const values = result.rows.map((r) => Number(r[v]) || 0);
  return {
    ...baseOption(theme, panel),
    legend: undefined,
    tooltip: { position: 'top', formatter: (p: any) => `${xs[p.value[0]]} · ${ys[p.value[1]]}<br/><b>${formatValue(p.value[2], o.unit)}</b>` },
    grid: { left: 8, right: 16, top: 8, bottom: 48, containLabel: true },
    xAxis: { type: 'category', data: xs, ...axisStyle(theme), splitArea: { show: false } },
    yAxis: { type: 'category', data: ys, ...axisStyle(theme) },
    visualMap: {
      min: Math.min(0, ...values),
      max: Math.max(1, ...values),
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      textStyle: { color: theme.palette.text.secondary },
      inRange: { color: theme.palette.mode === 'dark' ? ['#1f2a37', '#3274D9', '#F2CC0C', '#E02F44'] : ['#eef4ff', '#5794F2', '#F2CC0C', '#E02F44'] },
    },
    series: [{ type: 'heatmap', data: result.rows.map((r) => [xi.get(String(r[x])), yi.get(String(r[y])), Number(r[v]) || 0]), emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } } }],
  };
}

export function buildGauge(panel: Panel, value: number, theme: Theme): EChartsOption {
  const o = panel.options;
  const min = o.min ?? 0;
  const max = o.max ?? 100;
  const th = (o.thresholds?.length ? o.thresholds : [{ value: min, color: '#73BF69' }]).slice().sort((a, b) => a.value - b.value);
  const stops: [number, string][] = th.map((t, i) => [i + 1 < th.length ? (th[i + 1].value - min) / (max - min) : 1, t.color]);
  return {
    series: [
      {
        type: 'gauge',
        min,
        max,
        startAngle: 210,
        endAngle: -30,
        radius: '95%',
        center: ['50%', '58%'],
        progress: { show: true, width: 10, itemStyle: { color: thresholdColor(value, o.thresholds) } },
        axisLine: { lineStyle: { width: 10, color: stops.map(([p, c]) => [Math.min(1, Math.max(0, p)), `${c}55`]) } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '0%'],
          fontSize: 26,
          fontWeight: 600,
          color: thresholdColor(value, o.thresholds, theme.palette.text.primary),
          formatter: (v: number) => formatValue(v, o.unit, o.decimals),
        },
        data: [{ value: Number.isFinite(value) ? value : 0 }],
      },
    ],
  };
}

export function buildTreemap(panel: Panel, result: QueryResult, theme: Theme): EChartsOption {
  const o = panel.options;
  const { valueField } = resolveFields(panel, result);
  const groups = o.groupFields?.length ? o.groupFields : result.columns.filter((c) => c.name !== valueField).slice(0, 2).map((c) => c.name);
  if (!valueField || !groups.length) return {};
  type Node = { name: string; value: number; children?: Node[] };
  const root: Node = { name: 'root', value: 0, children: [] };
  for (const r of result.rows) {
    let node = root;
    const val = Number(r[valueField]) || 0;
    for (const g of groups) {
      const name = String(r[g]);
      node.children ??= [];
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, value: 0 };
        node.children.push(child);
      }
      child.value += val;
      node = child;
    }
  }
  return {
    color: SERIES_COLORS,
    tooltip: { formatter: (p: any) => `${p.treePathInfo?.slice(1).map((t: any) => t.name).join(' › ')}<br/><b>${formatValue(p.value, o.unit)}</b>` },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: 'zoomToNode',
        width: '100%',
        height: '88%',
        top: 0,
        breadcrumb: { show: true, bottom: 0, itemStyle: { color: theme.palette.background.paper, textStyle: { color: theme.palette.text.primary } } },
        label: { show: true, formatter: '{b}' },
        upperLabel: { show: true, height: 20, color: '#fff' },
        levels: [
          { itemStyle: { borderColor: theme.palette.background.paper, borderWidth: 2, gapWidth: 2 } },
          { colorSaturation: [0.35, 0.6], itemStyle: { borderColorSaturation: 0.6, gapWidth: 1, borderWidth: 1 } },
        ],
        data: root.children,
      },
    ],
  };
}
