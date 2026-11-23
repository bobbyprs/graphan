import ReactECharts from 'echarts-for-react';
import { Box, Chip, LinearProgress, Paper, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import NumbersIcon from '@mui/icons-material/Numbers';
import CategoryIcon from '@mui/icons-material/CategoryOutlined';
import EventIcon from '@mui/icons-material/EventOutlined';
import ToggleOnIcon from '@mui/icons-material/ToggleOnOutlined';
import NotesIcon from '@mui/icons-material/Notes';
import KeyIcon from '@mui/icons-material/KeyOutlined';
import BlockIcon from '@mui/icons-material/Block';
import type { ColumnKind, ColumnProfile, ProfileResult } from '@/api/types';
import { formatValue } from '@/utils/format';
import { correlationChart } from './charts';

export const KIND_META: Record<ColumnKind, { label: string; icon: JSX.Element }> = {
  numeric: { label: 'Numeric', icon: <NumbersIcon sx={{ fontSize: 16 }} /> },
  categorical: { label: 'Category', icon: <CategoryIcon sx={{ fontSize: 16 }} /> },
  datetime: { label: 'Date/time', icon: <EventIcon sx={{ fontSize: 16 }} /> },
  boolean: { label: 'Boolean', icon: <ToggleOnIcon sx={{ fontSize: 16 }} /> },
  text: { label: 'Text', icon: <NotesIcon sx={{ fontSize: 16 }} /> },
  identifier: { label: 'Identifier', icon: <KeyIcon sx={{ fontSize: 16 }} /> },
  empty: { label: 'Empty', icon: <BlockIcon sx={{ fontSize: 16 }} /> },
};

function MiniBars({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values);
  return (
    <Stack direction="row" alignItems="flex-end" spacing="2px" sx={{ height: 36 }}>
      {values.map((v, i) => (
        <Tooltip key={i} title={`${labels[i]}: ${v.toLocaleString()}`}>
          <Box sx={{ flex: 1, height: `${Math.max(4, (v / max) * 100)}%`, bgcolor: 'primary.main', opacity: 0.75, borderRadius: '2px 2px 0 0', minWidth: 3 }} />
        </Tooltip>
      ))}
    </Stack>
  );
}

function ColumnCard({ c, selected, onClick }: { c: ColumnProfile; selected?: boolean; onClick?: () => void }) {
  const k = KIND_META[c.kind];
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      sx={{
        p: 1.25,
        cursor: onClick ? 'pointer' : 'default',
        borderColor: selected ? 'primary.main' : undefined,
        borderWidth: selected ? 2 : 1,
        bgcolor: 'surface.panel',
        transition: 'border-color .15s',
        '&:hover': onClick ? { borderColor: 'primary.main' } : undefined,
      }}
    >
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.75 }}>
        <Box sx={{ color: 'text.secondary', display: 'flex' }}>{k.icon}</Box>
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, fontSize: 13 }} title={c.name}>
          {c.name}
        </Typography>
        <Chip size="small" label={k.label} sx={{ height: 18, fontSize: 10 }} />
      </Stack>
      {c.kind === 'numeric' && c.histogram && (
        <MiniBars values={c.histogram.map((h) => h.count)} labels={c.histogram.map((h) => `${formatValue(h.x0, 'short')}–${formatValue(h.x1, 'short')}`)} />
      )}
      {(c.kind === 'categorical' || c.kind === 'boolean') && c.top && (
        <MiniBars values={c.top.map((t) => t.count)} labels={c.top.map((t) => t.value)} />
      )}
      {c.kind === 'datetime' && c.range && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ height: 36 }}>
          {new Date(c.range.from).toLocaleDateString()} → {new Date(c.range.to).toLocaleDateString()}
        </Typography>
      )}
      {!['numeric', 'categorical', 'boolean', 'datetime'].includes(c.kind) && <Box sx={{ height: 36 }} />}
      <Typography variant="caption" color="text.secondary" component="div" noWrap sx={{ mt: 0.5 }}>
        {c.stats
          ? `μ ${formatValue(c.stats.mean, 'short', 2)} · σ ${formatValue(c.stats.std, 'short', 2)} · ${formatValue(c.stats.min, 'short')}–${formatValue(c.stats.max, 'short')}`
          : `${c.distinct.toLocaleString()} distinct`}
      </Typography>
      <Tooltip title={`${Math.round(c.completeness * 100)}% of rows have a value`}>
        <LinearProgress variant="determinate" value={c.completeness * 100} color={c.completeness < 0.8 ? 'warning' : 'success'} sx={{ mt: 0.75, height: 3, borderRadius: 2 }} />
      </Tooltip>
      {c.note && (
        <Typography variant="caption" color="warning.main" component="div" noWrap title={c.note} sx={{ mt: 0.5 }}>
          {c.note}
        </Typography>
      )}
    </Paper>
  );
}

export function ProfileView({ profile, target, onPickTarget }: { profile: ProfileResult; target?: string; onPickTarget?: (name: string) => void }) {
  const theme = useTheme();
  const { fields, matrix } = profile.correlations;
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Data profile
        </Typography>
        <Chip size="small" label={`${profile.rowCount.toLocaleString()} rows${profile.truncated ? ' (capped)' : ''}`} />
        <Chip size="small" label={`${profile.columns.length} columns`} />
        <Chip size="small" variant="outlined" label={`${profile.durationMs} ms`} />
        {onPickTarget && (
          <Typography variant="caption" color="text.secondary">
            Click a numeric column to predict it.
          </Typography>
        )}
      </Stack>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {profile.columns.map((c) => (
          <ColumnCard key={c.name} c={c} selected={c.name === target} onClick={onPickTarget && ['numeric', 'boolean'].includes(c.kind) ? () => onPickTarget(c.name) : undefined} />
        ))}
      </Box>
      {fields.length >= 2 && (
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel' }}>
          <Typography variant="subtitle2">Correlations</Typography>
          <Typography variant="caption" color="text.secondary">
            Pearson r between numeric columns — orange moves together, blue moves opposite.
          </Typography>
          <ReactECharts option={correlationChart(fields, matrix, theme)} style={{ height: Math.min(460, 120 + fields.length * 28) }} notMerge />
        </Paper>
      )}
    </Stack>
  );
}
