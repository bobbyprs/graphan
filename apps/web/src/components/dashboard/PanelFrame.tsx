import { memo, useState } from 'react';
import { Alert, Box, Chip, IconButton, LinearProgress, ListItemIcon, Menu, MenuItem, Paper, Stack, Tooltip, Typography } from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import EditIcon from '@mui/icons-material/Edit';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import DownloadIcon from '@mui/icons-material/Download';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { usePanelData } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { Panel, QueryResult } from '@/api/types';
import { PanelRenderer } from '@/components/viz/PanelRenderer';
import { ForecastChip } from '@/components/ml/ForecastChip';

interface Props {
  dashboardId: string;
  version: number;
  panel: Panel;
  timeRange: { from: string; to: string };
  variables: Record<string, unknown>;
  refreshMs: number | false;
  publicToken?: string;
  editing: boolean;
  /** Ready = variable options resolved; avoids firing queries with incomplete params */
  ready: boolean;
  /** True when the panel's query differs from the saved dashboard version */
  dirty?: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onView?: () => void;
  onDrill?: (panel: Panel, row: Record<string, unknown>) => void;
}

function toCsv(r: QueryResult) {
  const cols = r.columns.map((c) => c.name);
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...r.rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n');
}

function PanelFrameInner(p: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const isText = p.panel.type === 'text';
  const q = usePanelData({
    dashboardId: p.dashboardId,
    panelId: p.panel.id,
    version: p.version,
    timeRange: p.timeRange,
    variables: p.variables,
    publicToken: p.publicToken,
    refreshMs: p.refreshMs,
    enabled: p.ready && !isText && !!p.panel.query && !!p.panel.dataSourceId,
    adhoc:
      p.dirty && p.panel.dataSourceId && p.panel.query
        ? { dataSourceId: p.panel.dataSourceId, sql: p.panel.query, transforms: p.panel.transforms }
        : undefined,
  });

  const exportCsv = () => {
    if (!q.data) return;
    const url = URL.createObjectURL(new Blob(['﻿' + toCsv(q.data)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.panel.title || p.panel.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const result: QueryResult = q.data ?? { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 };

  return (
    <Paper sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'surface.panel', overflow: 'hidden', '&:hover .panel-actions': { opacity: 1 } }}>
      <Stack
        direction="row"
        alignItems="center"
        className={p.editing ? 'panel-drag-handle' : undefined}
        sx={{ px: 1, minHeight: 32, cursor: p.editing ? 'move' : 'default', userSelect: 'none' }}
      >
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, fontSize: 13 }} title={p.panel.title}>
          {p.panel.title}
        </Typography>
        {p.panel.description && (
          <Tooltip title={p.panel.description}>
            <InfoOutlinedIcon sx={{ fontSize: 15, mr: 0.5, color: 'text.secondary' }} />
          </Tooltip>
        )}
        {q.data?.truncated && <Chip size="small" color="warning" label="truncated" sx={{ height: 18, mr: 0.5 }} />}
        {q.data?.meta && <ForecastChip meta={q.data.meta} unit={p.panel.options.unit} />}
        {q.data && !isText && (
          <Tooltip title={`${q.data.rowCount} rows · ${q.data.durationMs} ms${q.data.cached ? ' · cached' : ''}`}>
            <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5, display: { xs: 'none', md: 'block' } }}>
              {q.data.durationMs}ms
            </Typography>
          </Tooltip>
        )}
        <IconButton
          className="panel-actions"
          aria-label="Panel menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ opacity: { xs: 1, md: 0 }, transition: 'opacity .15s' }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Box sx={{ height: 2 }}>{q.isFetching && <LinearProgress sx={{ height: 2 }} />}</Box>
      <Box sx={{ flex: 1, minHeight: 0, px: 1, pb: 1 }}>
        {q.error ? (
          <Alert severity="error" variant="outlined" sx={{ fontSize: 12, '& .MuiAlert-message': { overflow: 'auto', maxHeight: '100%' } }}>
            {errorMessage(q.error)}
          </Alert>
        ) : (
          <PanelRenderer panel={p.panel} result={result} onDrill={p.onDrill && p.panel.drilldown ? (row) => p.onDrill!(p.panel, row) : undefined} />
        )}
      </Box>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={() => setAnchor(null)}>
        <MenuItem onClick={p.onView}>
          <ListItemIcon><FullscreenIcon fontSize="small" /></ListItemIcon>View
        </MenuItem>
        {!isText && (
          <MenuItem onClick={() => q.refetch()}>
            <ListItemIcon><RefreshIcon fontSize="small" /></ListItemIcon>Refresh
          </MenuItem>
        )}
        {!isText && (
          <MenuItem onClick={exportCsv} disabled={!q.data}>
            <ListItemIcon><DownloadIcon fontSize="small" /></ListItemIcon>Export CSV
          </MenuItem>
        )}
        {p.onEdit && (
          <MenuItem onClick={p.onEdit}>
            <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>Edit
          </MenuItem>
        )}
        {p.onDuplicate && (
          <MenuItem onClick={p.onDuplicate}>
            <ListItemIcon><ContentCopyIcon fontSize="small" /></ListItemIcon>Duplicate
          </MenuItem>
        )}
        {p.onRemove && (
          <MenuItem onClick={p.onRemove} sx={{ color: 'error.main' }}>
            <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>Remove
          </MenuItem>
        )}
      </Menu>
    </Paper>
  );
}

export const PanelFrame = memo(PanelFrameInner);
