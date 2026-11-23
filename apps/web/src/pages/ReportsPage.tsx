import { useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  Link,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
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
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import FolderIcon from '@mui/icons-material/FolderOutlined';
import FolderOpenIcon from '@mui/icons-material/FolderOpenOutlined';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import { api, errorMessage } from '@/api/client';
import { useDataSources } from '@/api/hooks';
import { BLANK_DEFINITION, FORMAT_LABELS, useExecutions, useMySubscriptions, useReportMutations, useReports, useReportTemplates, type ReportDefinition, type ReportSummary } from '@/api/reports';
import { useCan } from '@/auth/AuthContext';
import { EmptyState, PageHeader, useConfirm } from '@/components/common/misc';
import { relativeTime } from '@/utils/format';
import { describeCron } from '@/components/reports/SubscriptionsDialog';

function NewReportDialog({ open, onClose, folder }: { open: boolean; onClose: () => void; folder: string }) {
  const navigate = useNavigate();
  const m = useReportMutations();
  const { data: templates = [] } = useReportTemplates();
  const { data: dataSources = [] } = useDataSources();
  const [mode, setMode] = useState<'blank' | string>('blank');
  const [title, setTitle] = useState('');
  const [path, setPath] = useState(folder);
  const [dsId, setDsId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const sample = dataSources.find((d) => /sample/i.test(d.name));

  const create = async () => {
    setErr(null);
    try {
      if (mode === 'blank') {
        const r = await m.create.mutateAsync({ title: title || 'New report', folder: path, definition: { ...BLANK_DEFINITION, datasets: [] } });
        onClose();
        navigate(`/reports/${r.id}/edit`);
      } else {
        const created = await m.fromTemplate.mutateAsync({ templateId: mode, dataSourceId: dsId || sample?.id || '', folder: path });
        onClose();
        navigate(`/reports/${created[created.length - 1].id}`);
      }
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New report</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField select label="Start from" value={mode} onChange={(e) => setMode(e.target.value)}>
            <MenuItem value="blank">Blank report (opens the designer)</MenuItem>
            {templates.map((t) => (
              <MenuItem key={t.id} value={t.id}>
                {t.title} — {t.reports} report(s)
              </MenuItem>
            ))}
          </TextField>
          {mode !== 'blank' && (
            <>
              <Alert severity="info" variant="outlined">
                {templates.find((t) => t.id === mode)?.description} Built for the sample database.
              </Alert>
              <TextField select label="Data source" value={dsId || sample?.id || ''} onChange={(e) => setDsId(e.target.value)}>
                {dataSources.map((d) => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.name}
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}
          {mode === 'blank' && <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Monthly sales" autoFocus />}
          <TextField label="Folder" value={path} onChange={(e) => setPath(e.target.value)} helperText="e.g. /Finance/Monthly — folders are created automatically" />
          {err && <Alert severity="error">{err}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={create} disabled={m.create.isPending || m.fromTemplate.isPending}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function folderTree(reports: ReportSummary[]) {
  const set = new Set<string>(['/']);
  for (const r of reports) {
    const parts = r.folder.split('/').filter(Boolean);
    parts.forEach((_p, i) => set.add(`/${parts.slice(0, i + 1).join('/')}`));
  }
  return [...set].sort();
}

function SubscriptionsTab() {
  const can = useCan();
  const [all, setAll] = useState(false);
  const { data = [] } = useMySubscriptions(all);
  return (
    <Paper variant="outlined">
      <Stack direction="row" sx={{ p: 1.5 }} alignItems="center">
        <Typography sx={{ flex: 1 }} color="text.secondary" variant="body2">
          {all ? 'All subscriptions in this workspace' : 'Subscriptions you own'} · manage them from each report&apos;s Subscribe button
        </Typography>
        {can.manageAlerts && <Button size="small" onClick={() => setAll((a) => !a)}>{all ? 'Show mine' : 'Show all'}</Button>}
      </Stack>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Report</TableCell>
            <TableCell>Subscription</TableCell>
            <TableCell>Schedule</TableCell>
            <TableCell>Delivery</TableCell>
            <TableCell>Last run</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.map((s) => (
            <TableRow key={s.id} hover>
              <TableCell>
                <Link component={RouterLink} to={`/reports/${s.reportId}`}>
                  {s.report?.title}
                </Link>
              </TableCell>
              <TableCell>
                {s.name} {!s.enabled && <Chip size="small" label="disabled" />} {s.dataDriven && <Chip size="small" color="secondary" label="data-driven" />}
              </TableCell>
              <TableCell>{describeCron(s.cron, s.timezone)}</TableCell>
              <TableCell>{s.delivery === 'email' ? `${FORMAT_LABELS[s.format]} e-mail` : 'Report history'}</TableCell>
              <TableCell>
                {s.lastRunAt ? (
                  <Tooltip title={s.lastError ?? ''}>
                    <Chip size="small" label={`${s.lastStatus} · ${relativeTime(s.lastRunAt)}`} color={s.lastStatus === 'success' ? 'success' : s.lastStatus === 'failed' ? 'error' : 'default'} />
                  </Tooltip>
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
          {!data.length && (
            <TableRow>
              <TableCell colSpan={5}>
                <Typography color="text.secondary" sx={{ py: 2 }}>
                  No subscriptions.
                </Typography>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Paper>
  );
}

function ExecutionLogTab({ reports }: { reports: ReportSummary[] }) {
  const [reportId, setReportId] = useState('');
  const { data = [] } = useExecutions(true, reportId || undefined);
  const titles = new Map(reports.map((r) => [r.id, r.title]));
  return (
    <Paper variant="outlined">
      <Stack direction="row" sx={{ p: 1.5 }} spacing={2} alignItems="center">
        <TextField select size="small" label="Report" value={reportId} onChange={(e) => setReportId(e.target.value)} sx={{ minWidth: 260 }}>
          <MenuItem value="">All reports</MenuItem>
          {reports.map((r) => (
            <MenuItem key={r.id} value={r.id}>
              {r.title}
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="body2" color="text.secondary">
          Every view, export, subscription and snapshot run (kept 90 days).
        </Typography>
      </Stack>
      <Box sx={{ maxHeight: '60vh', overflow: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Report</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Format</TableCell>
              <TableCell align="right">Rows</TableCell>
              <TableCell align="right">Duration</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((e) => (
              <TableRow key={e.id}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</TableCell>
                <TableCell>{titles.get(e.reportId) ?? e.reportId.slice(0, 8)}</TableCell>
                <TableCell>{e.source}</TableCell>
                <TableCell>{e.format}</TableCell>
                <TableCell align="right">{e.rowCount.toLocaleString()}</TableCell>
                <TableCell align="right">
                  {e.durationMs} ms{e.cached ? ' (cache)' : ''}
                </TableCell>
                <TableCell>
                  <Tooltip title={e.error ?? ''}>
                    <Chip size="small" label={e.status} color={e.status === 'success' ? 'success' : 'error'} />
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Paper>
  );
}

export function ReportsPage() {
  const navigate = useNavigate();
  const can = useCan();
  const [search, setSearch] = useState('');
  const { data: reports = [], isLoading } = useReports(search || undefined);
  const { data: allReports = [] } = useReports();
  const m = useReportMutations();
  const { confirm, dialog } = useConfirm();
  const [folder, setFolder] = useState('/');
  const [tab, setTab] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; r: ReportSummary } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folders = useMemo(() => folderTree(allReports), [allReports]);
  // "All reports" (/) lists everything; a folder lists itself and its sub-folders
  const shown = search || folder === '/' ? reports : reports.filter((r) => r.folder === folder || r.folder.startsWith(`${folder}/`));

  const exportDefinition = async (r: ReportSummary) => {
    const { data } = await api.get(`/reports/${r.id}`);
    const blob = new Blob([JSON.stringify({ graphanReport: 1, title: data.title, description: data.description, folder: data.folder, definition: data.definition }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${r.title.replace(/[^\w-]+/g, '_')}.report.json`;
    a.click();
  };

  const importDefinition = async (file: File) => {
    setErr(null);
    try {
      const json = JSON.parse(await file.text()) as { title?: string; description?: string; folder?: string; definition?: ReportDefinition };
      if (!json.definition) throw new Error('Not a Graphan report file (missing "definition")');
      const r = await m.create.mutateAsync({ title: json.title ?? file.name.replace(/\.report\.json$|\.json$/, ''), description: json.description, folder: folder, definition: json.definition });
      navigate(`/reports/${r.id}/edit`);
    } catch (e) {
      setErr(`Import failed: ${errorMessage(e)} — data source IDs in the file must exist in this workspace (edit them in the designer's JSON tab).`);
    }
  };

  return (
    <Box>
      <PageHeader
        title="Reports"
        subtitle="Paginated, printable reports with parameters, subscriptions and history (SSRS-style)"
        actions={
          can.createDashboards && (
            <Stack direction="row" spacing={1}>
              <Button onClick={() => fileRef.current?.click()}>Import</Button>
              <Button variant="outlined" startIcon={<AutoAwesomeIcon />} onClick={() => navigate('/analyze?target=report')}>
                Generate from database
              </Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
                New report
              </Button>
            </Stack>
          )
        }
      />
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importDefinition(e.target.files[0])} />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Catalog" />
        <Tab icon={<ScheduleSendIcon sx={{ fontSize: 18 }} />} iconPosition="start" label="Subscriptions" />
        {can.manageAlerts && <Tab label="Execution log" />}
      </Tabs>
      {err && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr(null)}>
          {err}
        </Alert>
      )}

      {tab === 0 && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <Paper variant="outlined" sx={{ width: { md: 240 }, flexShrink: 0, alignSelf: 'flex-start' }}>
            <List dense>
              {folders.map((f) => {
                const depth = f === '/' ? 0 : f.split('/').length - 1;
                return (
                  <ListItemButton key={f} selected={!search && f === folder} onClick={() => (setSearch(''), setFolder(f))} sx={{ pl: 1.5 + depth * 1.5 }}>
                    <ListItemIcon sx={{ minWidth: 30 }}>{f === folder ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />}</ListItemIcon>
                    <ListItemText primary={f === '/' ? 'All reports' : f.split('/').pop()} />
                  </ListItemButton>
                );
              })}
            </List>
          </Paper>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <TextField
              placeholder="Search reports and folders"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="small"
              sx={{ mb: 2, width: { xs: '100%', sm: 360 } }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            />
            {!isLoading && shown.length === 0 ? (
              <EmptyState
                icon={<DescriptionIcon sx={{ fontSize: 48 }} />}
                title="No reports here"
                description="Create a paginated report from scratch, start from the sales report pack, or import a .report.json file."
                action={can.createDashboards && <Button variant="contained" onClick={() => setNewOpen(true)}>New report</Button>}
              />
            ) : (
              <Paper variant="outlined">
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Folder</TableCell>
                      <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Owner</TableCell>
                      <TableCell>Modified</TableCell>
                      <TableCell width={48} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {shown.map((r) => (
                      <TableRow key={r.id} hover>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <DescriptionIcon fontSize="small" color="primary" />
                            <Box>
                              <Link component={RouterLink} to={`/reports/${r.id}`} underline="hover" fontWeight={500}>
                                {r.title}
                              </Link>
                              {!!r._count.subscriptions && <Chip size="small" variant="outlined" sx={{ ml: 1 }} label={`${r._count.subscriptions} subscription${r._count.subscriptions > 1 ? 's' : ''}`} />}
                              {r.description && (
                                <Typography variant="caption" color="text.secondary" display="block" noWrap sx={{ maxWidth: 520 }}>
                                  {r.description}
                                </Typography>
                              )}
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{r.folder}</TableCell>
                        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>{r.owner.name}</TableCell>
                        <TableCell>{relativeTime(r.updatedAt)}</TableCell>
                        <TableCell>
                          <IconButton size="small" onClick={(e) => setMenu({ el: e.currentTarget, r })}>
                            <MoreVertIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            )}
          </Box>
        </Stack>
      )}
      {tab === 1 && <SubscriptionsTab />}
      {tab === 2 && can.manageAlerts && <ExecutionLogTab reports={allReports} />}

      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => (navigate(`/reports/${menu!.r.id}`), setMenu(null))}>View</MenuItem>
        {menu?.r.canEdit && <MenuItem onClick={() => (navigate(`/reports/${menu!.r.id}/edit`), setMenu(null))}>Edit in designer</MenuItem>}
        {can.createDashboards && (
          <MenuItem
            onClick={async () => {
              const r = await m.duplicate.mutateAsync(menu!.r.id);
              setMenu(null);
              navigate(`/reports/${r.id}/edit`);
            }}
          >
            Duplicate
          </MenuItem>
        )}
        <MenuItem onClick={() => (exportDefinition(menu!.r), setMenu(null))}>Download definition (.json)</MenuItem>
        {menu?.r.canEdit && (
          <MenuItem
            sx={{ color: 'error.main' }}
            onClick={async () => {
              const r = menu!.r;
              setMenu(null);
              if (await confirm(`Delete "${r.title}"?`, 'Its subscriptions and history are deleted too.')) m.remove.mutate(r.id);
            }}
          >
            Delete
          </MenuItem>
        )}
      </Menu>
      <NewReportDialog key={String(newOpen)} open={newOpen} onClose={() => setNewOpen(false)} folder={folder} />
      {dialog}
    </Box>
  );
}
