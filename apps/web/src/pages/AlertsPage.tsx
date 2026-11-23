import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckIcon from '@mui/icons-material/Check';
import SendIcon from '@mui/icons-material/Send';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import { errorMessage, workspaceStore } from '@/api/client';
import { useAlertEvents, useAlertMutations, useAlertRules, useChannels, useDataSources } from '@/api/hooks';
import { useSocketEvent } from '@/api/socket';
import type { AlertCondition, AlertRule } from '@/api/types';
import { useCan } from '@/auth/AuthContext';
import { AlertStateChip, EmptyState, PageHeader, useConfirm } from '@/components/common/misc';
import { SqlEditor } from '@/components/common/SqlEditor';
import { relativeTime } from '@/utils/format';

const OPS: { v: AlertCondition['operator']; l: string }[] = [
  { v: 'gt', l: '>' }, { v: 'gte', l: '≥' }, { v: 'lt', l: '<' }, { v: 'lte', l: '≤' }, { v: 'eq', l: '=' }, { v: 'neq', l: '≠' },
];

interface RuleForm {
  id?: string;
  name: string;
  description?: string | null;
  dataSourceId: string;
  query: string;
  condition: AlertCondition;
  intervalSeconds: number;
  forSeconds: number;
  severity: AlertRule['severity'];
  enabled: boolean;
  channelIds: string[];
}

const blankRule = (dsId: string): RuleForm => ({
  name: '',
  dataSourceId: dsId,
  query: 'SELECT AVG(value) AS value FROM metrics WHERE ts BETWEEN $__timeFrom AND $__timeTo',
  condition: { field: 'value', reducer: 'last', operator: 'gt', threshold: 80, lookback: 'now-15m', noDataState: 'NO_DATA' },
  intervalSeconds: 60,
  forSeconds: 0,
  severity: 'warning',
  enabled: true,
  channelIds: [],
});

function RuleDialog({ initial, onClose }: { initial: RuleForm; onClose: () => void }) {
  const [f, setF] = useState(initial);
  const { data: dataSources = [] } = useDataSources();
  const { data: channels = [] } = useChannels();
  const m = useAlertMutations();
  const set = (p: Partial<RuleForm>) => setF((x) => ({ ...x, ...p }));
  const setC = (p: Partial<AlertCondition>) => setF((x) => ({ ...x, condition: { ...x.condition, ...p } }));
  const body = () => {
    const { id, ...rest } = f;
    return { ...rest, id };
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{f.id ? 'Edit alert rule' : 'New alert rule'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} sx={{ flex: 1 }} />
            <TextField select label="Severity" value={f.severity} onChange={(e) => set({ severity: e.target.value as RuleForm['severity'] })} sx={{ width: 150 }}>
              <MenuItem value="info">Info</MenuItem>
              <MenuItem value="warning">Warning</MenuItem>
              <MenuItem value="critical">Critical</MenuItem>
            </TextField>
          </Stack>
          <TextField label="Description" value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
          <TextField select label="Data source" value={f.dataSourceId} onChange={(e) => set({ dataSourceId: e.target.value })}>
            {dataSources.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
          </TextField>
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <SqlEditor value={f.query} onChange={(v) => set({ query: v })} height={140} language={dataSources.find((d) => d.id === f.dataSourceId)?.type === 'MONGODB' ? 'json' : 'sql'} />
          </Box>
          <Typography variant="subtitle2">Condition</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <TextField select label="Reducer" value={f.condition.reducer} onChange={(e) => setC({ reducer: e.target.value as AlertCondition['reducer'] })} sx={{ width: 120 }}>
              {['last', 'avg', 'min', 'max', 'sum', 'count'].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </TextField>
            <Typography>of</Typography>
            <TextField label="Field" value={f.condition.field} onChange={(e) => setC({ field: e.target.value })} sx={{ width: 160 }} />
            <TextField select label="Is" value={f.condition.operator} onChange={(e) => setC({ operator: e.target.value as AlertCondition['operator'] })} sx={{ width: 90 }}>
              {OPS.map((o) => <MenuItem key={o.v} value={o.v}>{o.l}</MenuItem>)}
            </TextField>
            <TextField type="number" label="Threshold" value={f.condition.threshold} onChange={(e) => setC({ threshold: Number(e.target.value) })} sx={{ width: 140 }} />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField select label="Look-back window" value={f.condition.lookback} onChange={(e) => setC({ lookback: e.target.value })} sx={{ flex: 1 }}>
              {['now-5m', 'now-15m', 'now-30m', 'now-1h', 'now-6h', 'now-24h'].map((l) => <MenuItem key={l} value={l}>{l.replace('now-', 'last ')}</MenuItem>)}
            </TextField>
            <TextField type="number" label="Evaluate every (s)" value={f.intervalSeconds} onChange={(e) => set({ intervalSeconds: Number(e.target.value) })} sx={{ flex: 1 }} />
            <TextField type="number" label="Pending for (s)" helperText="Must hold before firing" value={f.forSeconds} onChange={(e) => set({ forSeconds: Number(e.target.value) })} sx={{ flex: 1 }} />
            <TextField select label="When no data" value={f.condition.noDataState} onChange={(e) => setC({ noDataState: e.target.value as AlertCondition['noDataState'] })} sx={{ flex: 1 }}>
              <MenuItem value="NO_DATA">No data</MenuItem>
              <MenuItem value="OK">OK</MenuItem>
              <MenuItem value="FIRING">Firing</MenuItem>
            </TextField>
          </Stack>
          <Autocomplete
            multiple
            options={channels}
            getOptionLabel={(c) => `${c.name} (${c.type})`}
            value={channels.filter((c) => f.channelIds.includes(c.id))}
            onChange={(_e, v) => set({ channelIds: v.map((c) => c.id) })}
            renderInput={(p) => <TextField {...p} label="Notify channels" />}
          />
          <FormControlLabel control={<Switch checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />} label="Enabled" />
          {m.testRule.data && (
            <Alert severity={m.testRule.data.state === 'FIRING' ? 'warning' : m.testRule.data.state === 'OK' ? 'success' : 'info'}>
              Test result: <b>{m.testRule.data.state}</b> — {m.testRule.data.message}
            </Alert>
          )}
          {(m.testRule.error || m.saveRule.error) && <Alert severity="error">{errorMessage(m.testRule.error ?? m.saveRule.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<PlayArrowIcon />} onClick={() => { const { id: _id, ...b } = body(); m.testRule.mutate(b); }}>Test rule</Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!f.name || !f.dataSourceId} onClick={async () => { await m.saveRule.mutateAsync(body()); onClose(); }}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

function ChannelDialog({ onClose }: { onClose: () => void }) {
  const m = useAlertMutations();
  const [type, setType] = useState<'EMAIL' | 'TEAMS'>('EMAIL');
  const [name, setName] = useState('');
  const [recipients, setRecipients] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New notification channel</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField select label="Type" value={type} onChange={(e) => setType(e.target.value as 'EMAIL')}>
            <MenuItem value="EMAIL">Email (SMTP)</MenuItem>
            <MenuItem value="TEAMS">Microsoft Teams (webhook / workflow)</MenuItem>
          </TextField>
          {type === 'EMAIL' ? (
            <TextField label="Recipients (comma separated)" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
          ) : (
            <TextField label="Webhook URL" type="password" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} helperText="Stored encrypted. Must be an https Teams / Power Automate URL." />
          )}
          {m.saveChannel.error && <Alert severity="error">{errorMessage(m.saveChannel.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={async () => {
            await m.saveChannel.mutateAsync(
              type === 'EMAIL' ? { name, type, recipients: recipients.split(',').map((s) => s.trim()).filter(Boolean) } : { name, type, webhookUrl },
            );
            onClose();
          }}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AlertsPage() {
  const [tab, setTab] = useState(0);
  const [editing, setEditing] = useState<RuleForm | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [unackedOnly, setUnackedOnly] = useState(false);
  const can = useCan();
  const qc = useQueryClient();
  const { data: rules = [] } = useAlertRules();
  const { data: events } = useAlertEvents({ unacknowledged: unackedOnly });
  const { data: channels = [] } = useChannels();
  const { data: dataSources = [] } = useDataSources();
  const m = useAlertMutations();
  const { confirm, dialog } = useConfirm();
  const [toast, setToast] = useState<string | null>(null);

  useSocketEvent(
    'alert:state',
    useCallback(() => {
      qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'alert-rules'] });
      qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'alert-events'] });
    }, [qc]),
  );

  const firing = rules.filter((r) => r.state === 'FIRING').length;

  return (
    <Box>
      <PageHeader
        title="Alerting"
        subtitle={`${rules.length} rules · ${firing} firing`}
        actions={
          can.manageAlerts && (
            <>
              <Button variant="outlined" onClick={() => setChannelOpen(true)}>New channel</Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing(blankRule(dataSources[0]?.id ?? ''))} disabled={!dataSources.length}>
                New alert rule
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Rules" />
        <Tab label="History" />
        <Tab label={`Channels (${channels.length})`} />
      </Tabs>

      {tab === 0 &&
        (rules.length === 0 ? (
          <EmptyState icon={<NotificationsActiveIcon sx={{ fontSize: 48 }} />} title="No alert rules" description="Alert when a query result crosses a threshold; notify via email or Teams." />
        ) : (
          <Paper sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>State</TableCell><TableCell>Name</TableCell><TableCell>Condition</TableCell><TableCell>Last value</TableCell><TableCell>Evaluated</TableCell><TableCell align="right" />
                </TableRow>
              </TableHead>
              <TableBody>
                {rules.map((r) => (
                  <TableRow key={r.id} hover sx={{ opacity: r.enabled ? 1 : 0.5 }}>
                    <TableCell><AlertStateChip state={r.state} /></TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{r.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.dataSource.name} · {r.severity} · every {r.intervalSeconds}s</Typography>
                    </TableCell>
                    <TableCell><code>{r.condition.reducer}({r.condition.field}) {OPS.find((o) => o.v === r.condition.operator)?.l} {r.condition.threshold}</code></TableCell>
                    <TableCell>{r.lastValue != null ? Number(r.lastValue.toFixed(3)) : '–'}</TableCell>
                    <TableCell>{relativeTime(r.lastEvaluatedAt)}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {can.manageAlerts && (
                        <>
                          <Tooltip title="Evaluate now"><IconButton onClick={() => m.evaluate.mutate(r.id)} aria-label="Evaluate"><PlayArrowIcon fontSize="small" /></IconButton></Tooltip>
                          <IconButton
                            aria-label="Edit"
                            onClick={() =>
                              setEditing({
                                id: r.id, name: r.name, description: r.description, dataSourceId: r.dataSourceId, query: r.query, condition: r.condition,
                                intervalSeconds: r.intervalSeconds, forSeconds: r.forSeconds, severity: r.severity, enabled: r.enabled, channelIds: r.channels.map((c) => c.channel.id),
                              })
                            }
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton aria-label="Delete" onClick={async () => (await confirm(`Delete alert "${r.name}"?`)) && m.deleteRule.mutate(r.id)}><DeleteIcon fontSize="small" /></IconButton>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        ))}

      {tab === 1 && (
        <Paper sx={{ overflowX: 'auto' }}>
          <Stack direction="row" sx={{ p: 1 }}>
            <FormControlLabel control={<Switch checked={unackedOnly} onChange={(e) => setUnackedOnly(e.target.checked)} />} label="Unacknowledged only" />
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow><TableCell>Time</TableCell><TableCell>Rule</TableCell><TableCell>Transition</TableCell><TableCell>Message</TableCell><TableCell>Ack</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {events?.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{e.rule.name}</TableCell>
                  <TableCell><Stack direction="row" spacing={0.5} alignItems="center"><AlertStateChip state={e.fromState} /><span>→</span><AlertStateChip state={e.toState} /></Stack></TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>{e.message}</TableCell>
                  <TableCell>
                    {e.acknowledgedAt ? (
                      <Tooltip title={new Date(e.acknowledgedAt).toLocaleString()}><Chip size="small" icon={<CheckIcon />} label={e.ackUser?.name ?? 'ack'} /></Tooltip>
                    ) : ['FIRING', 'ERROR'].includes(e.toState) && can.ackAlerts ? (
                      <Button size="small" onClick={() => m.ack.mutate(e.id)}>Acknowledge</Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!events?.items.length && <Typography sx={{ p: 2 }} color="text.secondary">No alert events.</Typography>}
        </Paper>
      )}

      {tab === 2 && (
        <Paper>
          <Table size="small">
            <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Type</TableCell><TableCell>Target</TableCell><TableCell align="right" /></TableRow></TableHead>
            <TableBody>
              {channels.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell><Chip size="small" label={c.type} /></TableCell>
                  <TableCell>{c.type === 'EMAIL' ? c.config.recipients?.join(', ') : c.config.webhookHost}</TableCell>
                  <TableCell align="right">
                    {can.manageAlerts && (
                      <>
                        <Tooltip title="Send test">
                          <IconButton
                            aria-label="Send test"
                            onClick={async () => {
                              const r = await m.testChannel.mutateAsync(c.id);
                              setToast(r.ok ? 'Test notification sent' : `Failed: ${r.error}`);
                            }}
                          >
                            <SendIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <IconButton aria-label="Delete" onClick={async () => (await confirm(`Delete channel "${c.name}"?`)) && m.deleteChannel.mutate(c.id)}><DeleteIcon fontSize="small" /></IconButton>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {toast && <Alert severity="info" onClose={() => setToast(null)} sx={{ m: 1 }}>{toast}</Alert>}
        </Paper>
      )}

      {editing && <RuleDialog initial={editing} onClose={() => setEditing(null)} />}
      {channelOpen && <ChannelDialog onClose={() => setChannelOpen(false)} />}
      {dialog}
    </Box>
  );
}
