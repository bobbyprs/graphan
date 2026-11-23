export const TIME_PRESETS = [
  { label: 'Last 5 minutes', from: 'now-5m', to: 'now' },
  { label: 'Last 15 minutes', from: 'now-15m', to: 'now' },
  { label: 'Last 1 hour', from: 'now-1h', to: 'now' },
  { label: 'Last 6 hours', from: 'now-6h', to: 'now' },
  { label: 'Last 24 hours', from: 'now-24h', to: 'now' },
  { label: 'Last 7 days', from: 'now-7d', to: 'now' },
  { label: 'Last 30 days', from: 'now-30d', to: 'now' },
  { label: 'Last 90 days', from: 'now-90d', to: 'now' },
  { label: 'Today so far', from: 'now/d', to: 'now' },
  { label: 'Yesterday', from: 'now-1d/d', to: 'now-1d/d' },
  { label: 'This month', from: 'now/M', to: 'now' },
];

export const REFRESH_OPTIONS = ['off', '5s', '10s', '30s', '1m', '5m', '15m', '30m', '1h'];

export function describeRange(r: { from: string; to: string }) {
  const p = TIME_PRESETS.find((x) => x.from === r.from && x.to === r.to);
  if (p) return p.label;
  const fmt = (s: string) => (s.startsWith('now') ? s : new Date(s).toLocaleString());
  return `${fmt(r.from)} → ${fmt(r.to)}`;
}

export function refreshToMs(r?: string | null): number | false {
  if (!r || r === 'off') return false;
  const m = /^(\d+)(s|m|h)$/.exec(r);
  if (!m) return false;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's'];
}
