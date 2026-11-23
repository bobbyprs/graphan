import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid2 as Grid,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import StorageIcon from '@mui/icons-material/Storage';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage, workspaceStore } from '@/api/client';
import { useDataSources, useDeleteDataSource, useSaveDataSource, useTestDataSource } from '@/api/hooks';
import { useSocketEvent } from '@/api/socket';
import type { ConnectionStatus, DataSource, DataSourceInput, DataSourceType } from '@/api/types';
import { useCan } from '@/auth/AuthContext';
import { DS_META, DsIcon, EmptyState, PageHeader, StatusChip, useConfirm } from '@/components/common/misc';

const EMPTY: DataSourceInput = { name: '', type: 'POSTGRES', host: 'localhost', port: 5432, database: '', username: '', password: '', readOnly: true, options: {} };

function DataSourceDialog({ initial, onClose }: { initial?: DataSource; onClose: () => void }) {
  const [f, setF] = useState<DataSourceInput & { useConnString?: boolean }>(
    initial
      ? { name: initial.name, type: initial.type, host: initial.host, port: initial.port, database: initial.database, username: initial.username, readOnly: initial.readOnly, options: initial.options, useConnString: initial.hasConnectionString }
      : EMPTY,
  );
  const [advanced, setAdvanced] = useState(false);
  const save = useSaveDataSource();
  const test = useTestDataSource();
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const setOpt = (p: Partial<DataSourceInput['options']>) => setF((x) => ({ ...x, options: { ...x.options, ...p } }));
  const isSqlite = f.type === 'SQLITE';

  const payload = (): DataSourceInput => {
    const { useConnString, ...rest } = f;
    const out: DataSourceInput = { ...rest, port: rest.port ? Number(rest.port) : null };
    // Omit secrets the user did not touch so stored values are preserved on edit
    if (!out.password) delete out.password;
    if (!useConnString || !out.connectionString) delete out.connectionString;
    return out;
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial ? `Edit ${initial.name}` : 'Add data source'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Grid container spacing={1}>
            {(Object.keys(DS_META) as DataSourceType[]).map((t) => (
              <Grid key={t} size={{ xs: 4, sm: 2 }}>
                <Card
                  variant="outlined"
                  onClick={() => !initial && set({ type: t, port: DS_META[t].defaultPort ?? null })}
                  sx={{ cursor: initial ? 'default' : 'pointer', p: 1, textAlign: 'center', borderColor: f.type === t ? 'primary.main' : 'divider', borderWidth: f.type === t ? 2 : 1, opacity: initial && f.type !== t ? 0.4 : 1 }}
                >
                  <Stack alignItems="center" spacing={0.5}>
                    <DsIcon type={t} />
                    <Typography variant="caption" noWrap>{DS_META[t].label}</Typography>
                  </Stack>
                </Card>
              </Grid>
            ))}
          </Grid>
          <TextField label="Name" required value={f.name} onChange={(e) => set({ name: e.target.value })} />
          {isSqlite ? (
            <TextField label="Database file (relative to SQLITE_BASE_DIR)" value={f.options.filePath ?? ''} onChange={(e) => setOpt({ filePath: e.target.value })} placeholder="analytics.db" />
          ) : (
            <>
              <FormControlLabel control={<Switch checked={!!f.useConnString} onChange={(e) => set({ useConnString: e.target.checked })} />} label="Use connection string" />
              {f.useConnString ? (
                <TextField
                  label="Connection string"
                  type="password"
                  value={f.connectionString ?? ''}
                  onChange={(e) => set({ connectionString: e.target.value })}
                  placeholder={initial?.hasConnectionString ? '•••••• (stored — leave blank to keep)' : f.type === 'MONGODB' ? 'mongodb+srv://user:pass@cluster/db' : ''}
                  helperText="Stored encrypted (AES-256-GCM); never returned by the API"
                />
              ) : (
                <>
                  <Stack direction="row" spacing={1}>
                    <TextField label="Host" value={f.host ?? ''} onChange={(e) => set({ host: e.target.value })} sx={{ flex: 1 }} />
                    <TextField label="Port" type="number" value={f.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : null })} sx={{ width: 110 }} />
                  </Stack>
                  <TextField label={f.type === 'ORACLE' ? 'Service name' : 'Database'} value={f.type === 'ORACLE' ? (f.options.serviceName ?? '') : (f.database ?? '')} onChange={(e) => (f.type === 'ORACLE' ? setOpt({ serviceName: e.target.value }) : set({ database: e.target.value }))} />
                  <Stack direction="row" spacing={1}>
                    <TextField label="Username" value={f.username ?? ''} onChange={(e) => set({ username: e.target.value })} sx={{ flex: 1 }} autoComplete="off" />
                    <TextField
                      label="Password"
                      type="password"
                      value={f.password ?? ''}
                      onChange={(e) => set({ password: e.target.value })}
                      placeholder={initial?.hasPassword ? '•••••• (unchanged)' : ''}
                      sx={{ flex: 1 }}
                      autoComplete="new-password"
                    />
                  </Stack>
                </>
              )}
            </>
          )}
          <FormControlLabel
            control={<Switch checked={f.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />}
            label={
              <Box>
                <Typography variant="body2">Read-only</Typography>
                <Typography variant="caption" color="text.secondary">Blocks writes in Graphan. Also use a read-only database account.</Typography>
              </Box>
            }
          />
          <Button size="small" onClick={() => setAdvanced((a) => !a)} sx={{ alignSelf: 'flex-start' }}>
            {advanced ? 'Hide' : 'Show'} advanced options
          </Button>
          <Collapse in={advanced}>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1}>
                <TextField label="Pool min" type="number" value={f.options.poolMin ?? ''} onChange={(e) => setOpt({ poolMin: e.target.value ? Number(e.target.value) : undefined })} />
                <TextField label="Pool max" type="number" value={f.options.poolMax ?? ''} onChange={(e) => setOpt({ poolMax: e.target.value ? Number(e.target.value) : undefined })} />
                <TextField label="Idle timeout (ms)" type="number" value={f.options.idleTimeoutMs ?? ''} onChange={(e) => setOpt({ idleTimeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
              </Stack>
              {['POSTGRES', 'MSSQL', 'ORACLE'].includes(f.type) && <TextField label="Default schema" value={f.options.defaultSchema ?? ''} onChange={(e) => setOpt({ defaultSchema: e.target.value || undefined })} />}
              {['POSTGRES', 'MYSQL', 'MONGODB'].includes(f.type) && (
                <FormControlLabel control={<Switch checked={!!f.options.ssl} onChange={(e) => setOpt({ ssl: e.target.checked })} />} label="SSL / TLS" />
              )}
              {f.type === 'MSSQL' && (
                <>
                  <FormControlLabel control={<Switch checked={f.options.encrypt ?? true} onChange={(e) => setOpt({ encrypt: e.target.checked })} />} label="Encrypt" />
                  <FormControlLabel control={<Switch checked={!!f.options.trustServerCertificate} onChange={(e) => setOpt({ trustServerCertificate: e.target.checked })} />} label="Trust server certificate" />
                </>
              )}
              {f.type === 'MONGODB' && <TextField label="Auth source" value={f.options.authSource ?? ''} onChange={(e) => setOpt({ authSource: e.target.value || undefined })} />}
            </Stack>
          </Collapse>
          {test.data && (test.data.ok ? <Alert severity="success">Connected in {test.data.latencyMs} ms</Alert> : <Alert severity="error">{test.data.error}</Alert>)}
          {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<NetworkCheckIcon />} onClick={() => test.mutate({ ...payload(), id: initial?.id })} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!f.name || save.isPending} onClick={async () => { await save.mutateAsync({ id: initial?.id, input: payload() }); onClose(); }}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DataSourcesPage() {
  const { data = [], isLoading } = useDataSources();
  const can = useCan();
  const del = useDeleteDataSource();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<DataSource | 'new' | null>(null);
  const { confirm, dialog } = useConfirm();

  // Real-time status pushed from the server health monitor
  useSocketEvent<{ id: string; status: ConnectionStatus; latencyMs: number | null; error: string | null; checkedAt: string }>(
    'datasource:status',
    useCallback(
      (e) =>
        qc.setQueryData<DataSource[]>([workspaceStore.get(), 'datasources'], (old) =>
          old?.map((d) => (d.id === e.id ? { ...d, status: e.status, lastLatencyMs: e.latencyMs, lastError: e.error, lastCheckedAt: e.checkedAt } : d)),
        ),
      [qc],
    ),
  );

  return (
    <Box>
      <PageHeader
        title="Data sources"
        subtitle="Connections are pooled, health-checked every 30s and credentials are encrypted at rest"
        actions={can.manageDataSources && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>Add data source</Button>}
      />
      {!isLoading && !data.length ? (
        <EmptyState icon={<StorageIcon sx={{ fontSize: 48 }} />} title="No data sources" description="Connect PostgreSQL, MySQL, SQL Server, Oracle, MongoDB or SQLite." />
      ) : (
        <Grid container spacing={2}>
          {data.map((d) => (
            <Grid key={d.id} size={{ xs: 12, md: 6, xl: 4 }}>
              <Card>
                <CardContent>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <DsIcon type={d.type} size={36} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle1" fontWeight={600} noWrap>{d.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        {DS_META[d.type].label} · {d.type === 'SQLITE' ? d.options.filePath : `${d.host ?? '(connection string)'}${d.port ? `:${d.port}` : ''}${d.database ? `/${d.database}` : ''}`}
                      </Typography>
                    </Box>
                    <StatusChip status={d.status} latency={d.lastLatencyMs} checkedAt={d.lastCheckedAt} error={d.lastError} />
                  </Stack>
                  {d.lastError && d.status === 'OFFLINE' && <Alert severity="error" sx={{ mt: 1.5, py: 0, fontSize: 12 }}>{d.lastError}</Alert>}
                  <Stack direction="row" spacing={1} sx={{ mt: 2 }} alignItems="center">
                    {d.readOnly && <Typography variant="caption" color="text.secondary">🔒 read-only</Typography>}
                    <Box sx={{ flex: 1 }} />
                    {can.explore && <Button size="small" startIcon={<TravelExploreIcon />} onClick={() => navigate(`/explore?ds=${d.id}`)}>Explore</Button>}
                    <Tooltip title="Check now">
                      <IconButton onClick={() => api.post(`/datasources/${d.id}/health`)} aria-label="Check health"><NetworkCheckIcon fontSize="small" /></IconButton>
                    </Tooltip>
                    {can.manageDataSources && (
                      <>
                        <IconButton onClick={() => setEditing(d)} aria-label="Edit"><EditIcon fontSize="small" /></IconButton>
                        <IconButton
                          onClick={async () => (await confirm(`Delete "${d.name}"?`, 'Dashboards and alerts using it will stop working.')) && del.mutate(d.id)}
                          aria-label="Delete"
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
      {editing && <DataSourceDialog initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {dialog}
    </Box>
  );
}
