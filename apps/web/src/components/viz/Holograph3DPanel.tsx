import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Typography, useTheme } from '@mui/material';
import {
  BarChart3D,
  DonutChart3D,
  HBarChart3D,
  HeatmapChart3D,
  RibbonChart3D,
  ScatterChart3D,
  TreemapChart3D,
  type BaseOptions,
  type Chart3D,
  type ThemeInput,
} from 'holograph-3d';
import type { Panel, QueryResult } from '@/api/types';
import { SERIES_COLORS } from '@/theme/theme';
import { formatValue } from '@/utils/format';
import { resolveFields } from './echartsOptions';

type Row = Record<string, unknown>;
type AnyChart = Chart3D<any, any, any>;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const uniq = (rows: Row[], f: string) => [...new Set(rows.map((r) => String(r[f])))];

/** A chart spec: which class to build and the data to give it (data changes go through setData). */
interface Spec {
  kind: string;
  create: (el: HTMLElement, base: BaseOptions) => AnyChart;
  data: unknown;
}

function reduce(values: number[], reducer: Panel['options']['reducer'] = 'last') {
  if (!values.length) return 0;
  if (reducer === 'first') return values[0];
  if (reducer === 'sum') return values.reduce((a, b) => a + b, 0);
  if (reducer === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
  if (reducer === 'min') return Math.min(...values);
  if (reducer === 'max') return Math.max(...values);
  return values[values.length - 1];
}

/** Turns a panel's query result into a holograph-3d chart spec, using the same fields as the ECharts builders. */
function buildSpec(panel: Panel, result: QueryResult): Spec | null {
  const o = panel.options;
  const rows = result.rows.filter((r) => !r.__future);
  const { xField, yFields, valueField, labelField } = resolveFields(panel, result);

  switch (panel.type) {
    case 'bar':
    case 'line':
    case 'area': {
      if (!xField) return null;
      const labels = uniq(rows, xField);
      const xi = new Map(labels.map((l, i) => [l, i]));
      let series: { name: string; values: number[] }[];
      if (o.seriesField) {
        const y = yFields[0];
        const by = new Map<string, number[]>();
        for (const r of rows) {
          const k = String(r[o.seriesField] ?? 'null');
          if (!by.has(k)) by.set(k, new Array(labels.length).fill(0));
          by.get(k)![xi.get(String(r[xField]))!] += num(r[y]);
        }
        series = [...by].map(([name, values]) => ({ name, values }));
      } else {
        series = yFields.map((y) => {
          const values = new Array(labels.length).fill(0);
          for (const r of rows) values[xi.get(String(r[xField]))!] += num(r[y]);
          return { name: y, values };
        });
      }
      if (!series.length) return null;
      if (panel.type === 'bar' && o.horizontal && series.length === 1) {
        const data = { bars: labels.map((label, i) => ({ label, value: series[0].values[i] })) };
        return { kind: 'hbar', data, create: (el, b) => new HBarChart3D(el, { ...b, data, sort: 'desc' }) };
      }
      if (panel.type === 'bar') {
        const data = { values: series.map((s) => s.values), rows: series.map((s) => s.name), columns: labels };
        return { kind: 'bar', data, create: (el, b) => new BarChart3D(el, { ...b, data, colorBy: series.length > 1 ? 'row' : 'value' }) };
      }
      const data = { series, labels };
      return { kind: 'ribbon', data, create: (el, b) => new RibbonChart3D(el, { ...b, data, smooth: o.smooth ?? false }) };
    }
    case 'pie': {
      if (!valueField || !labelField) return null;
      const data = { slices: rows.map((r) => ({ label: String(r[labelField]), value: num(r[valueField]) })) };
      return { kind: 'donut', data, create: (el, b) => new DonutChart3D(el, { ...b, data, innerRadius: o.donut ? 0.5 : 0, colors: SERIES_COLORS }) };
    }
    case 'gauge': {
      if (!valueField) return null;
      const min = o.min ?? 0;
      const value = reduce(rows.map((r) => Number(r[valueField])).filter(Number.isFinite), o.reducer);
      const data = { slices: [{ label: valueField, value: Math.max(0, value - min) }] };
      return {
        kind: `gauge:${o.max ?? 100}`,
        data,
        create: (el, b) => new DonutChart3D(el, { ...b, data, sweep: 240, max: (o.max ?? 100) - min, innerRadius: 0.6, centerLabel: true, legend: false }),
      };
    }
    case 'scatter': {
      const nums = result.columns.filter((c) => rows.some((r) => typeof r[c.name] === 'number')).map((c) => c.name);
      const x = o.xField ?? nums[0];
      const y = o.yField ?? nums[1];
      if (!x || !y) return null;
      // z: the series as depth lanes, else a third numeric column, else flat
      const z = o.seriesField ? undefined : nums.find((n) => n !== x && n !== y);
      const lanes = o.seriesField ? uniq(rows, o.seriesField) : [];
      const data = {
        points: rows.map((r) => ({
          x: num(r[x]),
          y: num(r[y]),
          z: o.seriesField ? lanes.indexOf(String(r[o.seriesField])) : z ? num(r[z]) : 0,
          label: o.seriesField ? String(r[o.seriesField]) : labelField && labelField !== x && labelField !== y ? String(r[labelField]) : undefined,
        })),
      };
      return { kind: 'scatter', data, create: (el, b) => new ScatterChart3D(el, { ...b, data, axes: { x, y, z: o.seriesField ?? z } }) };
    }
    case 'heatmap': {
      const cols = result.columns.map((c) => c.name);
      const x = o.xField ?? cols[0];
      const y = o.yField ?? cols[1];
      const v = o.valueField ?? cols[2];
      if (!x || !y || !v) return null;
      const xs = uniq(rows, x);
      const ys = uniq(rows, y);
      const values = ys.map(() => new Array(xs.length).fill(NaN));
      for (const r of rows) values[ys.indexOf(String(r[y]))][xs.indexOf(String(r[x]))] = num(r[v]);
      const data = { values, rows: ys, columns: xs };
      return { kind: 'heatmap', data, create: (el, b) => new HeatmapChart3D(el, { ...b, data, axes: { x, z: y } }) };
    }
    case 'treemap': {
      const groups = o.groupFields?.length ? o.groupFields : result.columns.filter((c) => c.name !== valueField).slice(0, 2).map((c) => c.name);
      if (!valueField || !groups.length) return null;
      type Node = { label: string; value?: number; children?: Node[] };
      const root: Node = { label: 'root', children: [] };
      for (const r of rows) {
        let node = root;
        groups.forEach((g, depth) => {
          node.children ??= [];
          const label = String(r[g]);
          let child = node.children.find((c) => c.label === label);
          if (!child) node.children.push((child = depth === groups.length - 1 ? { label, value: 0 } : { label, children: [] }));
          if (depth === groups.length - 1) child.value = (child.value ?? 0) + num(r[valueField]);
          node = child;
        });
      }
      const data = { nodes: root.children! };
      return { kind: 'treemap', data, create: (el, b) => new TreemapChart3D(el, { ...b, data, colors: SERIES_COLORS }) };
    }
    default:
      return null;
  }
}

/** Renders a panel as an interactive WebGL2 3D chart (holograph-3d). */
export function Holograph3DPanel({ panel, result }: { panel: Panel; result: QueryResult }) {
  const muiTheme = useTheme();
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<AnyChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = useMemo(() => buildSpec(panel, result), [panel, result]);

  const theme = useMemo<ThemeInput>(() => {
    const bg = muiTheme.palette.background.paper;
    return { extends: muiTheme.palette.mode === 'dark' ? 'aurora' : 'glacier', bgInner: bg, bgOuter: bg, font: muiTheme.typography.fontFamily };
  }, [muiTheme]);

  const { unit, decimals } = panel.options;
  const kind = spec?.kind;

  // (Re)create the chart only when its type or display options change; data updates morph in place below.
  useEffect(() => {
    if (!el.current || !spec) return;
    try {
      chart.current = spec.create(el.current, {
        theme,
        legend: panel.options.showLegend !== false,
        hint: false,
        format: (v) => formatValue(v, unit, decimals),
        ariaLabel: panel.title,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, theme, unit, decimals, panel.options.showLegend, panel.options.horizontal, panel.options.donut, panel.options.smooth]);

  useEffect(() => {
    if (chart.current && spec) chart.current.setData(spec.data);
  }, [spec]);

  if (!spec || error)
    return (
      <Stack height="100%" alignItems="center" justifyContent="center">
        <Typography variant="body2" color="text.secondary">
          {error ? `3D chart failed: ${error}` : 'Not enough fields for a 3D chart'}
        </Typography>
      </Stack>
    );

  return <div ref={el} style={{ position: 'relative', width: '100%', height: '100%' }} />;
}
