import { useMemo, useState } from 'react';
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import HistoryIcon from '@mui/icons-material/History';
import AddIcon from '@mui/icons-material/Add';
import { errorMessage } from '@/api/client';
import { useDataSources } from '@/api/hooks';
import { FORMAT_LABELS, useDeliveries, useReportMutations, useReportSubscriptions, type ParamValues, type Report, type ReportFormat, type Subscription } from '@/api/reports';
import { useCan } from '@/auth/AuthContext';
import { useConfirm } from '@/components/common/misc';
import { SqlEditor } from '@/components/common/SqlEditor';
import { ParameterPane } from './ParameterPane';

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];
  }
})();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Freq = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
interface Schedule {
  freq: Freq;
  time: string;
  days: number[];
  monthDay: number;
  minute: number;
  cron: string;
}

function toCron(s: Schedule): string {
  const [h, m] = s.time.split(':').map(Number);
  switch (s.freq) {
    case 'hourly': return `${s.minute} * * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekly': return `${m} ${h} * * ${(s.days.length ? s.days : [1]).sort().join(',')}`;
    case 'monthly': return `${m} ${h} ${s.monthDay} * *`;
    default: return s.cron;
  }
}

function fromCron(cron: string): Schedule {
  const base: Schedule = { freq: 'custom', time: '08:00', days: [1], monthDay: 1, minute: 0, cron };
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return base;
  const [mi, h, dom, mon, dow] = p;
  const time = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : base.time;
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return { ...base, freq: 'hourly', minute: +mi };
  if (/^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return { ...base, freq: 'daily', time };
  if (/^\d+$/.test(h) && dom === '*' && mon === '*' && /^[\d,]+$/.test(dow)) return { ...base, freq: 'weekly', time, days: dow.split(',').map(Number) };
  if (/^\d+$/.test(h) && /^\d+$/.test(dom) && mon === '*' && dow === '*') return { ...base, freq: 'monthly', time, monthDay: +dom };
  return base;
}

export function describeCron(cron: string, tz: string) {
  const s = fromCron(cron);
  const at = `at ${s.time} (${tz})`;
  switch (s.freq) {
    case 'hourly': return `Every hour at :${String(s.minute).padStart(2, '0')}`;
    case 'daily': return `Every day ${at}`;
    case 'weekly': return `Every ${s.days.map((d) => DAYS[d % 7]).join(', ')} ${at}`;
    case 'monthly': return `Day ${s.monthDay} of every month ${at}`;
    default: return `cron "${cron}" (${tz})`;
  }
}

const statusColor = (s?: string | null) => (s === 'success' ? 'success' : s === 'failed' ? 'error' : s === 'partial' ? 'warning' : 'default');

function SubscriptionForm({ report, initial, values, onDone }: { report: Report; initial?: Subscription; values: ParamValues; onDone: () => void }) {
  const can = useCan();
  const { data: dataSources = [] } = useDataSources();
  const m = useReportMutations();
  const [name, setName] = useState(initial?.name ?? `${report.title} — weekly`);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [schedule, setSchedule] = useState<Schedule>(() => fromCron(initial?.cron ?? '0 8 * * 1'));
  const [timezone, setTimezone] = useState(initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [format, setFormat] = useState<ReportFormat>(initial?.format ?? 'PDF');
  const [delivery, setDelivery] = useState<'email' | 'snapshot'>(initial?.delivery ?? 'email');
  const [recipients, setRecipients] = useState<string[]>(initial?.recipients ?? []);
  const [cc, setCc] = useState<string[]>(initial?.cc ?? []);
  const [subject, setSubject] = useState(initial?.subject ?? '{{Globals.ReportName}} — {{Globals.ExecutionTime}}');
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [includeLink, setIncludeLink] = useState(initial?.includeLink ?? true);
  const [onlyIfData, setOnlyIfData] = useState(initial?.onlyIfData ?? false);
  const [params, setParams] = useState<ParamValues>(initial?.parameters ?? values);
  // SSRS "Use Default": omitted parameters are resolved at run time (rolling dates such as today-7d keep moving)
  const [useDefault, setUseDefault] = useState<Set<string>>(
    () =>
      new Set(
        report.definition.parameters
          .filter((p) => (initial ? !(p.name in (initial.parameters ?? {})) : p.default !== undefined && p.default !== null) || (!initial && p.options.kind === 'query' && p.options.defaultFirst))
          .map((p) => p.name),
      ),
  );
  const [dataDriven, setDataDriven] = useState(!!initial?.dataDriven);
  const [dd, setDd] = useState(initial?.dataDriven ?? { dataSourceId: dataSources[0]?.id ?? '', query: 'SELECT email, region\nFROM report_subscribers\nWHERE active', emailColumn: 'email', paramColumns: {} as Record<string, string> });
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    try {
      await m.saveSubscription.mutateAsync({
        id: initial?.id,
        reportId: report.id,
        name,
        enabled,
        cron: toCron(schedule),
        timezone,
        format,
        delivery,
        recipients: dataDriven ? [] : recipients,
        cc: dataDriven ? [] : cc,
        subject,
        comment: comment || null,
        includeLink,
        onlyIfData,
        parameters: Object.fromEntries(Object.entries(params).filter(([k]) => !useDefault.has(k))),
        dataDriven: dataDriven ? { ...dd, ccColumn: dd.ccColumn || undefined, formatColumn: dd.formatColumn || undefined } : null,
      });
      onDone();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const emailInput = (label: string, v: string[], set: (x: string[]) => void) => (
    <Autocomplete
      multiple
      freeSolo
      options={[] as string[]}
      value={v}
      onChange={(_e, x) => set(x.flatMap((s) => s.split(/[;,\s]+/)).filter(Boolean))}
      renderTags={(vals, getTagProps) => vals.map((o, i) => <Chip {...getTagProps({ index: i })} key={o} size="small" label={o} color={/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o) ? 'default' : 'error'} />)}
      renderInput={(p) => <TextField {...p} size="small" label={label} placeholder="name@company.com, Enter" />}
    />
  );

  return (
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} sx={{ flex: 1 }} />
        <FormControlLabel control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} label="Enabled" />
      </Stack>

      <Typography variant="subtitle2">Schedule</Typography>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
        <ToggleButtonGroup size="small" exclusive value={schedule.freq} onChange={(_e, v) => v && setSchedule((s) => ({ ...s, freq: v }))}>
          {(['hourly', 'daily', 'weekly', 'monthly', 'custom'] as Freq[]).map((f) => (
            <ToggleButton key={f} value={f} sx={{ textTransform: 'capitalize', px: 1.5 }}>
              {f}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {schedule.freq === 'hourly' && <TextField size="small" type="number" label="Minute" value={schedule.minute} onChange={(e) => setSchedule((s) => ({ ...s, minute: Math.min(59, Math.max(0, +e.target.value)) }))} sx={{ width: 100 }} />}
        {['daily', 'weekly', 'monthly'].includes(schedule.freq) && <TextField size="small" type="time" label="Time" value={schedule.time} onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value || '08:00' }))} InputLabelProps={{ shrink: true }} sx={{ width: 130 }} />}
        {schedule.freq === 'monthly' && <TextField size="small" type="number" label="Day of month" value={schedule.monthDay} onChange={(e) => setSchedule((s) => ({ ...s, monthDay: Math.min(28, Math.max(1, +e.target.value)) }))} sx={{ width: 130 }} />}
        {schedule.freq === 'custom' && <TextField size="small" label="Cron (min hour day month weekday)" value={schedule.cron} onChange={(e) => setSchedule((s) => ({ ...s, cron: e.target.value }))} sx={{ width: 260 }} />}
        <Autocomplete size="small" options={TIMEZONES} value={timezone} onChange={(_e, v) => v && setTimezone(v)} sx={{ width: 230 }} renderInput={(p) => <TextField {...p} label="Time zone" />} disableClearable />
      </Stack>
      {schedule.freq === 'weekly' && (
        <ToggleButtonGroup size="small" value={schedule.days} onChange={(_e, v: number[]) => setSchedule((s) => ({ ...s, days: v.length ? v : s.days }))}>
          {DAYS.map((d, i) => (
            <ToggleButton key={d} value={i} sx={{ px: 1.5 }}>
              {d}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      )}
      <Typography variant="caption" color="text.secondary">
        {describeCron(toCron(schedule), timezone)}
      </Typography>

      <Typography variant="subtitle2">Delivery</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select size="small" label="Deliver by" value={delivery} onChange={(e) => setDelivery(e.target.value as 'email')} sx={{ minWidth: 200 }}>
          <MenuItem value="email">E-mail</MenuItem>
          <MenuItem value="snapshot">Save to report history (snapshot)</MenuItem>
        </TextField>
        {delivery === 'email' && (
          <TextField select size="small" label="Render format" value={format} onChange={(e) => setFormat(e.target.value as ReportFormat)} sx={{ minWidth: 220 }} helperText={format === 'HTML' ? 'Report is shown in the e-mail body' : 'Attached to the e-mail'}>
            {(Object.keys(FORMAT_LABELS) as ReportFormat[]).map((f) => (
              <MenuItem key={f} value={f}>
                {FORMAT_LABELS[f]}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Stack>

      {can.manageAlerts && (
        <FormControlLabel
          control={<Switch checked={dataDriven} onChange={(e) => setDataDriven(e.target.checked)} />}
          label="Data-driven (recipients and parameter values come from a query — one delivery per row)"
        />
      )}

      {dataDriven ? (
        <Stack spacing={1.5} sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <TextField select size="small" label="Subscriber data source" value={dd.dataSourceId} onChange={(e) => setDd({ ...dd, dataSourceId: e.target.value })}>
            {dataSources.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                {d.name}
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <SqlEditor value={dd.query} onChange={(v) => setDd({ ...dd, query: v })} height={120} path={`dd-${initial?.id ?? 'new'}.sql`} />
          </Box>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            <TextField size="small" label="E-mail column" value={dd.emailColumn} onChange={(e) => setDd({ ...dd, emailColumn: e.target.value })} />
            <TextField size="small" label="CC column (optional)" value={dd.ccColumn ?? ''} onChange={(e) => setDd({ ...dd, ccColumn: e.target.value })} />
            <TextField size="small" label="Format column (optional)" value={dd.formatColumn ?? ''} onChange={(e) => setDd({ ...dd, formatColumn: e.target.value })} helperText="PDF / EXCEL / WORD / CSV / HTML" />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Map report parameters to query columns (leave empty to use the fixed value below):
          </Typography>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            {report.definition.parameters.map((p) => (
              <TextField key={p.name} size="small" label={`${p.label ?? p.name} ← column`} value={dd.paramColumns[p.name] ?? ''} onChange={(e) => setDd({ ...dd, paramColumns: Object.fromEntries(Object.entries({ ...dd.paramColumns, [p.name]: e.target.value }).filter(([, c]) => c)) })} />
            ))}
          </Stack>
        </Stack>
      ) : (
        delivery === 'email' && (
          <>
            {emailInput('To', recipients, setRecipients)}
            {emailInput('Cc', cc, setCc)}
          </>
        )
      )}

      {delivery === 'email' && (
        <>
          <TextField size="small" label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} helperText="{{Globals.ReportName}}, {{Globals.ExecutionTime}}, {{Parameters.name}}" />
          <TextField size="small" label="Comment (message body)" value={comment} onChange={(e) => setComment(e.target.value)} multiline minRows={2} />
          <Stack direction="row" spacing={2}>
            <FormControlLabel control={<Switch checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} />} label="Include a link to the report" />
          </Stack>
        </>
      )}
      <FormControlLabel control={<Switch checked={onlyIfData} onChange={(e) => setOnlyIfData(e.target.checked)} />} label="Skip delivery when the report has no data" />

      {report.definition.parameters.length > 0 && (
        <>
          <Typography variant="subtitle2">Report parameter values</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {report.definition.parameters
              .filter((p) => !p.hidden)
              .map((p) => (
                <FormControlLabel
                  key={p.name}
                  control={
                    <Switch
                      size="small"
                      checked={useDefault.has(p.name)}
                      onChange={(e) =>
                        setUseDefault((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(p.name);
                          else n.delete(p.name);
                          return n;
                        })
                      }
                    />
                  }
                  label={<Typography variant="body2">{p.label ?? p.name}: use report default{p.default !== undefined && p.default !== null ? ` (${Array.isArray(p.default) ? p.default.join(', ') : String(p.default)})` : ''}</Typography>}
                />
              ))}
          </Stack>
          <ParameterPane
            reportId={report.id}
            parameters={report.definition.parameters.map((p) => (useDefault.has(p.name) ? { ...p, hidden: true } : p))}
            values={params}
            onChange={(n, v) => setParams((p) => ({ ...p, [n]: v }))}
          />
        </>
      )}

      {err && <Alert severity="error">{err}</Alert>}
      <Stack direction="row" justifyContent="flex-end" spacing={1}>
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={m.saveSubscription.isPending}>
          {initial ? 'Save' : 'Create subscription'}
        </Button>
      </Stack>
    </Stack>
  );
}

function Deliveries({ sid }: { sid: string }) {
  const { data = [] } = useDeliveries(sid);
  if (!data.length) return <Typography variant="body2" color="text.secondary">No deliveries yet.</Typography>;
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Started</TableCell>
          <TableCell>Status</TableCell>
          <TableCell align="right">Delivered</TableCell>
          <TableCell align="right">Failed</TableCell>
          <TableCell>Error</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {data.map((d) => (
          <TableRow key={d.id}>
            <TableCell>{new Date(d.startedAt).toLocaleString()}</TableCell>
            <TableCell>
              <Chip size="small" label={d.status} color={statusColor(d.status)} />
            </TableCell>
            <TableCell align="right">{d.delivered}</TableCell>
            <TableCell align="right">{d.failed}</TableCell>
            <TableCell sx={{ maxWidth: 360, whiteSpace: 'pre-wrap', fontSize: 12, color: 'error.main' }}>{d.error}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SubscriptionsDialog({ open, onClose, report, values }: { open: boolean; onClose: () => void; report: Report; values: ParamValues }) {
  const { data: subs = [] } = useReportSubscriptions(open ? report.id : undefined);
  const m = useReportMutations();
  const can = useCan();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const tab = editing ? 1 : 0;
  const sorted = useMemo(() => [...subs].sort((a, b) => a.name.localeCompare(b.name)), [subs]);

  const run = async (s: Subscription) => {
    setToast(null);
    try {
      const r = await m.runSubscription.mutateAsync(s.id);
      setToast({ ok: r.status === 'success' || r.status === 'skipped', text: `${s.name}: ${r.status} — ${r.delivered} delivered, ${r.failed} failed${r.error ? ` · ${r.error}` : ''}` });
    } catch (e) {
      setToast({ ok: false, text: errorMessage(e) });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Subscriptions · {report.title}</DialogTitle>
      <DialogContent dividers>
        <Tabs value={tab} sx={{ mb: 1 }}>
          <Tab label={`Subscriptions (${subs.length})`} onClick={() => setEditing(null)} />
          {editing && <Tab label={editing === 'new' ? 'New subscription' : `Edit · ${editing.name}`} />}
        </Tabs>
        {editing ? (
          <SubscriptionForm report={report} initial={editing === 'new' ? undefined : editing} values={values} onDone={() => setEditing(null)} />
        ) : (
          <Stack spacing={1.5}>
            {toast && <Alert severity={toast.ok ? 'success' : 'warning'} onClose={() => setToast(null)}>{toast.text}</Alert>}
            {sorted.length === 0 && <Typography color="text.secondary">No subscriptions yet. Create one to e-mail this report on a schedule or archive it to report history.</Typography>}
            {sorted.map((s) => (
              <Box key={s.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography fontWeight={600} noWrap>
                        {s.name}
                      </Typography>
                      {!s.enabled && <Chip size="small" label="disabled" />}
                      {s.dataDriven && <Chip size="small" color="secondary" label="data-driven" />}
                      {s.lastStatus && <Chip size="small" label={`last: ${s.lastStatus}`} color={statusColor(s.lastStatus)} />}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {describeCron(s.cron, s.timezone)} · {s.delivery === 'email' ? `${FORMAT_LABELS[s.format]} → ${s.dataDriven ? 'recipients from query' : s.recipients.join(', ')}` : 'saved to report history'}
                      {s.lastRunAt ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}` : ''}
                    </Typography>
                    {s.lastError && (
                      <Typography variant="caption" color="error" sx={{ whiteSpace: 'pre-wrap' }}>
                        {s.lastError}
                      </Typography>
                    )}
                  </Box>
                  <Tooltip title="Run now">
                    <span>
                      <IconButton onClick={() => run(s)} disabled={m.runSubscription.isPending}>
                        <PlayArrowIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Delivery history">
                    <IconButton onClick={() => setHistory(history === s.id ? null : s.id)}>
                      <HistoryIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton onClick={() => setEditing(s)}>
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton onClick={async () => (await confirm('Delete subscription?', s.name)) && m.deleteSubscription.mutate(s.id)}>
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Stack>
                {history === s.id && (
                  <Box sx={{ mt: 1 }}>
                    <Deliveries sid={s.id} />
                  </Box>
                )}
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {!editing && can.createDashboards && (
          <Button startIcon={<AddIcon />} variant="contained" onClick={() => setEditing('new')}>
            New subscription
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
      {dialog}
    </Dialog>
  );
}
