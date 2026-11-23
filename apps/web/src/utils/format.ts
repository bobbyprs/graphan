import type { PanelOptions } from '@/api/types';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function formatValue(v: unknown, unit: PanelOptions['unit'] = 'none', decimals?: number): string {
  if (v === null || v === undefined || v === '') return '–';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  const fixed = (x: number, d = decimals ?? 2) => x.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  switch (unit) {
    case 'short':
      return Math.abs(n) >= 10_000 ? compact.format(n) : fixed(n, decimals ?? 0);
    case 'percent':
      return `${fixed(n, decimals ?? 1)}%`;
    case 'currency':
      return Math.abs(n) >= 1_000_000
        ? `$${compact.format(n)}`
        : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: decimals ?? 0 });
    case 'bytes': {
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let i = 0;
      let x = Math.abs(n);
      while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
      }
      return `${fixed(Math.sign(n) * x, decimals ?? 1)} ${units[i]}`;
    }
    case 'ms':
      return n >= 1000 ? `${fixed(n / 1000, 2)} s` : `${fixed(n, decimals ?? 0)} ms`;
    case 's':
      return n >= 3600 ? `${fixed(n / 3600, 1)} h` : n >= 60 ? `${fixed(n / 60, 1)} min` : `${fixed(n, decimals ?? 1)} s`;
    default:
      return fixed(n);
  }
}

export function formatBytes(n?: number | null) {
  return n == null ? '–' : formatValue(n, 'bytes');
}

export function formatNumber(n?: number | null) {
  return n == null ? '–' : n.toLocaleString();
}

export function relativeTime(iso?: string | null) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export function thresholdColor(value: number, thresholds?: { value: number; color: string }[], fallback = '#73BF69') {
  if (!thresholds?.length) return fallback;
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);
  let c = sorted[0].color;
  for (const t of sorted) if (value >= t.value) c = t.color;
  return c;
}

export function uid(prefix = 'p') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
