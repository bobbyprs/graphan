import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import ReactECharts from 'echarts-for-react';
import { useTheme } from '@mui/material';
import type { Panel, QueryResult } from '@/api/types';
import { formatValue } from '@/utils/format';

/**
 * World map. GeoJSON is loaded from /world.json (place one in apps/web/public for air-gapped
 * installs) with a CDN fallback; if neither is reachable the points render on a plain lat/lon grid.
 */
const SOURCES = [import.meta.env.VITE_WORLD_GEOJSON_URL as string | undefined, '/world.json', 'https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json'].filter(
  Boolean,
) as string[];

let mapPromise: Promise<boolean> | null = null;
function ensureWorldMap(): Promise<boolean> {
  mapPromise ??= (async () => {
    for (const url of SOURCES) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        echarts.registerMap('world', await res.json());
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  })();
  return mapPromise;
}

export function GeoMapPanel({ panel, result, onDrill }: { panel: Panel; result: QueryResult; onDrill?: (row: Record<string, unknown>) => void }) {
  const theme = useTheme();
  const [hasMap, setHasMap] = useState<boolean | null>(null);
  useEffect(() => {
    void ensureWorldMap().then(setHasMap);
  }, []);

  const o = panel.options;
  const lat = o.latField ?? 'lat';
  const lon = o.lonField ?? 'lon';
  const val = o.valueField ?? 'value';
  const label = o.labelField ?? 'name';

  const option = useMemo(() => {
    const values = result.rows.map((r) => Number(r[val]) || 0);
    const max = Math.max(1, ...values);
    const data = result.rows.map((r) => ({ name: String(r[label] ?? ''), value: [Number(r[lon]), Number(r[lat]), Number(r[val]) || 0], row: r }));
    const series = {
      type: 'effectScatter' as const,
      coordinateSystem: hasMap ? ('geo' as const) : ('cartesian2d' as const),
      data,
      symbolSize: (v: number[]) => 8 + 28 * Math.sqrt((v[2] || 0) / max),
      rippleEffect: { scale: 2.5, brushType: 'stroke' as const },
      itemStyle: { color: '#F2CC0C', shadowBlur: 8, shadowColor: 'rgba(0,0,0,.4)' },
      label: { show: data.length <= 15, formatter: '{b}', position: 'right' as const, color: theme.palette.text.primary, fontSize: 11 },
    };
    const tooltip = { trigger: 'item' as const, formatter: (p: any) => `${p.name}<br/><b>${formatValue(p.value[2], o.unit, o.decimals)}</b>` };
    if (hasMap) {
      return {
        backgroundColor: 'transparent',
        tooltip,
        geo: {
          map: 'world',
          roam: true,
          zoom: 1.2,
          itemStyle: { areaColor: theme.palette.mode === 'dark' ? '#22252b' : '#e6e9ef', borderColor: theme.palette.divider },
          emphasis: { itemStyle: { areaColor: theme.palette.mode === 'dark' ? '#2c3038' : '#d5dae3' }, label: { show: false } },
        },
        series: [series],
      };
    }
    return {
      backgroundColor: 'transparent',
      tooltip,
      grid: { left: 40, right: 16, top: 16, bottom: 32 },
      xAxis: { type: 'value', min: -180, max: 180, name: 'lon', splitLine: { lineStyle: { color: theme.palette.divider } } },
      yAxis: { type: 'value', min: -90, max: 90, name: 'lat', splitLine: { lineStyle: { color: theme.palette.divider } } },
      series: [series],
    };
  }, [result, hasMap, theme, lat, lon, val, label, o.unit, o.decimals]);

  if (hasMap === null) return null;
  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ height: '100%', width: '100%' }}
      onEvents={{ click: (p: { data?: { row?: Record<string, unknown> } }) => p.data?.row && onDrill?.(p.data.row) }}
    />
  );
}
