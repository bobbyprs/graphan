import { useState, type ReactNode } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Tooltip, Typography } from '@mui/material';
import type { AlertState, ConnectionStatus, DataSourceType } from '@/api/types';
import { relativeTime } from '@/utils/format';

export function PageHeader({ title, subtitle, actions, icon }: { title: string; subtitle?: string; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={2} sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        {icon}
        <Box>
          <Typography variant="h5">{title}</Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          )}
        </Box>
      </Stack>
      {actions && <Stack direction="row" spacing={1}>{actions}</Stack>}
    </Stack>
  );
}

const STATUS_COLOR: Record<ConnectionStatus, 'success' | 'warning' | 'error' | 'default'> = {
  ONLINE: 'success',
  DEGRADED: 'warning',
  OFFLINE: 'error',
  UNKNOWN: 'default',
};

export function StatusChip({ status, latency, checkedAt, error }: { status: ConnectionStatus; latency?: number | null; checkedAt?: string | null; error?: string | null }) {
  return (
    <Tooltip title={error ?? `Checked ${relativeTime(checkedAt)}${latency != null ? ` · ${latency} ms` : ''}`}>
      <Chip
        size="small"
        color={STATUS_COLOR[status]}
        variant={status === 'UNKNOWN' ? 'outlined' : 'filled'}
        label={status === 'ONLINE' && latency != null ? `Online · ${latency}ms` : status.charAt(0) + status.slice(1).toLowerCase()}
        sx={{ fontWeight: 600 }}
      />
    </Tooltip>
  );
}

const ALERT_COLOR: Record<AlertState, string> = { OK: '#56A64B', PENDING: '#FF9830', FIRING: '#E02F44', NO_DATA: '#8E8E8E', ERROR: '#FF9830' };

export function AlertStateChip({ state }: { state: AlertState }) {
  return <Chip size="small" label={state.replace('_', ' ')} sx={{ bgcolor: ALERT_COLOR[state], color: '#fff', fontWeight: 600 }} />;
}

export const DS_META: Record<DataSourceType, { label: string; color: string; short: string; defaultPort?: number }> = {
  POSTGRES: { label: 'PostgreSQL', color: '#336791', short: 'PG', defaultPort: 5432 },
  MYSQL: { label: 'MySQL', color: '#00758F', short: 'MY', defaultPort: 3306 },
  MSSQL: { label: 'SQL Server', color: '#CC2927', short: 'MS', defaultPort: 1433 },
  ORACLE: { label: 'Oracle', color: '#F80000', short: 'OR', defaultPort: 1521 },
  MONGODB: { label: 'MongoDB', color: '#47A248', short: 'MG', defaultPort: 27017 },
  SQLITE: { label: 'SQLite', color: '#0F80CC', short: 'SL' },
};

export function DsIcon({ type, size = 28 }: { type: DataSourceType; size?: number }) {
  const m = DS_META[type];
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: 1,
        bgcolor: m.color,
        color: '#fff',
        fontSize: size * 0.38,
        fontWeight: 700,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      {m.short}
    </Box>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ py: 8, px: 2, textAlign: 'center', color: 'text.secondary' }}>
      {icon}
      <Typography variant="h6" color="text.primary">
        {title}
      </Typography>
      {description && <Typography variant="body2" sx={{ maxWidth: 480 }}>{description}</Typography>}
      {action}
    </Stack>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body?: string; resolve: (ok: boolean) => void } | null>(null);
  const confirm = (title: string, body?: string) => new Promise<boolean>((resolve) => setState({ title, body, resolve }));
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const dialog = (
    <Dialog open={!!state} onClose={() => close(false)} maxWidth="xs" fullWidth>
      <DialogTitle>{state?.title}</DialogTitle>
      {state?.body && <DialogContent><Typography variant="body2">{state.body}</Typography></DialogContent>}
      <DialogActions>
        <Button onClick={() => close(false)}>Cancel</Button>
        <Button color="error" variant="contained" onClick={() => close(true)}>
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
  return { confirm, dialog };
}
