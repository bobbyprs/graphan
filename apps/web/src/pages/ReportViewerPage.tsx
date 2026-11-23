import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/FileDownloadOutlined';
import PrintIcon from '@mui/icons-material/PrintOutlined';
import HistoryIcon from '@mui/icons-material/History';
import ScheduleSendIcon from '@mui/icons-material/ScheduleSend';
import EditIcon from '@mui/icons-material/EditOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LinkIcon from '@mui/icons-material/Link';
import CameraIcon from '@mui/icons-material/CameraAltOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api, downloadPost, errorMessage } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { FORMAT_LABELS, paramsFromSearch, paramsToSearch, useReport, useReportMutations, useSnapshots, type DrillLink, type ParamValues, type RenderedReport, type Report, type ReportFormat } from '@/api/reports';
import { useCan } from '@/auth/AuthContext';
import { ParameterPane } from '@/components/reports/ParameterPane';
import { ReportView } from '@/components/reports/ReportView';
import { SubscriptionsDialog } from '@/components/reports/SubscriptionsDialog';

async function downloadGet(url: string, fallback: string) {
  const res = await api.get(url, { responseType: 'blob' });
  const name = /filename="([^"]+)"/.exec((res.headers['content-disposition'] as string) ?? '')?.[1] ?? fallback;
  const href = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}

/** `embedded`: rendered inside another application's iframe with a signed embed session. */
export function ReportViewerPage({ embedded = false }: { embedded?: boolean }) {
  const params = useParams();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const can = useCan();
  const snapshotId = sp.get('snapshot');
  const signedIn = useReport(embedded ? undefined : params.id);
  const embeddedReport = useQuery({ queryKey: ['embed-report'], enabled: embedded, queryFn: async () => (await api.get<Report>('/embed/report')).data });
  const { data: report, error: loadError } = embedded ? embeddedReport : signedIn;
  const id = report?.id ?? params.id ?? '';
  const base = embedded ? '/embed/report' : `/reports/${id}`;
  const m = useReportMutations();

  const [values, setValues] = useState<ParamValues>({});
  const [ready, setReady] = useState(false);
  const [model, setModel] = useState<RenderedReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [exportEl, setExportEl] = useState<HTMLElement | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const { data: snapshots = [] } = useSnapshots(id, historyOpen);
  const drillStack = (location.state as { from?: string[] } | null)?.from ?? [];

  const run = useCallback(
    async (vals: ParamValues, fresh = false) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setRunning(true);
      setError(null);
      try {
        const { data } = await api.post<{ model: RenderedReport; cached: boolean }>(`${base}/render`, { parameters: vals, fresh }, { signal: ac.signal });
        setModel(data.model);
        setCached(data.cached);
        setSp(paramsToSearch(vals, new URLSearchParams()), { replace: true, state: location.state });
      } catch (e) {
        if (!ac.signal.aborted) setError(errorMessage(e));
      } finally {
        if (abort.current === ac) setRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base],
  );

  // Initial load: snapshot, or resolve defaults (+ URL p.* values) and auto-run like SSRS
  useEffect(() => {
    if (!report) return;
    setModel(null);
    setError(null);
    setReady(false);
    if (snapshotId) {
      api
        .get<{ model: RenderedReport }>(`/reports/${id}/snapshots/${snapshotId}`)
        .then((r) => setModel(r.data.model))
        .catch((e) => setError(errorMessage(e)));
      return;
    }
    const fromUrl = paramsFromSearch(sp);
    api
      .post<{ values: ParamValues }>(`${base}/parameters`, { parameters: fromUrl })
      .then(({ data }) => {
        setValues(data.values);
        setReady(true);
        const missing = report.definition.parameters.filter((p) => p.required && (data.values[p.name] === null || (Array.isArray(data.values[p.name]) && !(data.values[p.name] as unknown[]).length)));
        if (!missing.length) void run(data.values);
        else setError(`Select a value for: ${missing.map((p) => p.label ?? p.name).join(', ')}, then click View Report.`);
      })
      .catch((e) => setError(errorMessage(e)));
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id, report?.version, snapshotId]);

  const onDrill = (l: DrillLink) => {
    if (embedded) return; // drill-through targets are other reports the embedding app has not authorised
    const here = `${location.pathname}${location.search}`;
    navigate(`/reports/${l.reportId}?${paramsToSearch(l.params as ParamValues)}`, { state: { from: [...drillStack, here] } });
  };

  const exportAs = async (f: ReportFormat) => {
    setExportEl(null);
    try {
      if (snapshotId) await downloadGet(`/reports/${id}/snapshots/${snapshotId}/export?format=${f}`, `${report?.title}.${f.toLowerCase()}`);
      else await downloadPost(`${base}/export`, { parameters: values, format: f }, `${report?.title}.${f.toLowerCase()}`);
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  const printLayout = async () => {
    setPdfLoading(true);
    try {
      const res = snapshotId
        ? await api.get(`/reports/${id}/snapshots/${snapshotId}/export?format=PDF`, { responseType: 'blob' })
        : await api.post(`${base}/export`, { parameters: values, format: 'PDF' }, { responseType: 'blob' });
      setPdfUrl(URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/pdf' })));
    } catch (e) {
      setToast(errorMessage(e));
    } finally {
      setPdfLoading(false);
    }
  };

  const saveSnapshot = async () => {
    try {
      await m.snapshot.mutateAsync({ id, parameters: values, label: `Saved ${new Date().toLocaleString()}` });
      setToast('Snapshot saved to report history');
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  if (loadError) return <Alert severity="error">{errorMessage(loadError)}</Alert>;
  if (!report) return <LinearProgress />;
  const hasParams = report.definition.parameters.some((p) => !p.hidden);

  return (
    <Stack spacing={1.5} sx={{ minHeight: 0 }}>
      {/* Toolbar */}
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        {!embedded && (
        <Tooltip title={drillStack.length ? 'Back to parent report' : 'All reports'}>
          <IconButton onClick={() => (drillStack.length ? navigate(drillStack[drillStack.length - 1], { state: { from: drillStack.slice(0, -1) } }) : navigate('/reports'))}>
            <ArrowBackIcon />
          </IconButton>
        </Tooltip>
        )}
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography variant="h5" noWrap>
            {report.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {embedded ? '' : `${report.folder} · v${report.version}`}
            {model && !snapshotId ? ` · ${model.rowCount.toLocaleString()} rows · ${model.durationMs} ms${cached ? ' (cached)' : ''}` : ''}
          </Typography>
        </Box>
        <ButtonGroup variant="outlined" size="small">
          <Tooltip title="Refresh (re-run, bypass cache)">
            <span>
              <Button onClick={() => run(values, true)} disabled={running || !!snapshotId}>
                <RefreshIcon fontSize="small" />
              </Button>
            </span>
          </Tooltip>
          <Button startIcon={<DownloadIcon />} endIcon={<ExpandMoreIcon />} onClick={(e) => setExportEl(e.currentTarget)} disabled={!model}>
            Export
          </Button>
          <Button startIcon={pdfLoading ? <CircularProgress size={14} /> : <PrintIcon />} onClick={printLayout} disabled={!model || pdfLoading}>
            Print layout
          </Button>
        </ButtonGroup>
        <TextField select size="small" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} sx={{ width: 92 }}>
          {[0.5, 0.75, 1, 1.25, 1.5].map((z) => (
            <MenuItem key={z} value={z}>
              {z * 100}%
            </MenuItem>
          ))}
        </TextField>
        {!embedded && (<>
        <Tooltip title="Copy link with these parameter values">
          <IconButton
            onClick={async () => {
              await navigator.clipboard.writeText(`${window.location.origin}/reports/${id}?${paramsToSearch(values)}`);
              setToast('Link copied');
            }}
          >
            <LinkIcon />
          </IconButton>
        </Tooltip>
        {can.createDashboards && (
          <Tooltip title="Save snapshot to report history">
            <span>
              <IconButton onClick={saveSnapshot} disabled={!model || !!snapshotId || m.snapshot.isPending}>
                <CameraIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Report history (snapshots)">
          <IconButton onClick={() => setHistoryOpen(true)}>
            <HistoryIcon />
          </IconButton>
        </Tooltip>
        <Button size="small" startIcon={<ScheduleSendIcon />} onClick={() => setSubsOpen(true)}>
          Subscribe
        </Button>
        {report.canEdit && (
          <Button size="small" variant="contained" startIcon={<EditIcon />} onClick={() => navigate(`/reports/${id}/edit`)}>
            Edit
          </Button>
        )}
        </>)}
      </Stack>

      {snapshotId ? (
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
              Back to live report
            </Button>
          }
        >
          Viewing a snapshot from {model ? new Date(model.executedAt).toLocaleString() : '…'} (report history). Data is not re-queried.
        </Alert>
      ) : (
        hasParams && (
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'flex-start' }}>
              <Box sx={{ flex: 1 }}>{ready && <ParameterPane reportId={id} basePath={base} parameters={report.definition.parameters} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} />}</Box>
              <Button variant="contained" startIcon={running ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />} onClick={() => run(values)} disabled={!ready || running} sx={{ whiteSpace: 'nowrap', alignSelf: { xs: 'stretch', md: 'flex-start' } }}>
                View Report
              </Button>
            </Stack>
          </Paper>
        )
      )}

      {running && <LinearProgress />}
      {error && <Alert severity={error.startsWith('Select a value') || error.startsWith('Enter a value') ? 'info' : 'error'}>{error}</Alert>}

      <Box sx={{ bgcolor: (t) => (t.palette.mode === 'dark' ? '#1b1d22' : '#ECEFF3'), borderRadius: 1, p: { xs: 1, md: 3 }, minHeight: 300, opacity: running ? 0.6 : 1, transition: 'opacity .2s' }}>
        {model ? <ReportView model={model} onDrill={embedded ? undefined : onDrill} zoom={zoom} /> : !error && <Stack alignItems="center" sx={{ py: 8 }}><CircularProgress /></Stack>}
      </Box>

      <Menu anchorEl={exportEl} open={!!exportEl} onClose={() => setExportEl(null)}>
        {(Object.keys(FORMAT_LABELS) as ReportFormat[]).map((f) => (
          <MenuItem key={f} onClick={() => exportAs(f)}>
            {FORMAT_LABELS[f]}
          </MenuItem>
        ))}
      </Menu>

      {/* Print layout = the paginated PDF in the browser's viewer (page navigation, zoom, print, find) */}
      <Dialog open={!!pdfUrl} onClose={() => (pdfUrl && URL.revokeObjectURL(pdfUrl), setPdfUrl(null))} fullScreen>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', py: 1 }}>
          <Box sx={{ flex: 1 }}>Print layout · {report.title}</Box>
          <IconButton onClick={() => (pdfUrl && URL.revokeObjectURL(pdfUrl), setPdfUrl(null))}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ p: 0 }}>{pdfUrl && <iframe title="Print layout" src={pdfUrl} style={{ border: 0, width: '100%', height: '100%' }} />}</DialogContent>
      </Dialog>

      <Drawer anchor="right" open={historyOpen} onClose={() => setHistoryOpen(false)}>
        <Box sx={{ width: { xs: 320, sm: 400 }, p: 2 }}>
          <Typography variant="h6">Report history</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Snapshots keep the data as it was when they were taken (latest {report.snapshotRetention} kept).
          </Typography>
          <Divider />
          {snapshots.length === 0 && <Typography sx={{ mt: 2 }} color="text.secondary">No snapshots yet. Use the camera button or a subscription with "Save to report history".</Typography>}
          <List dense>
            {snapshots.map((s) => (
              <ListItem
                key={s.id}
                disablePadding
                secondaryAction={
                  report.canEdit && (
                    <IconButton edge="end" onClick={() => m.deleteSnapshot.mutate({ id, sid: s.id })}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )
                }
              >
                <ListItemButton
                  selected={s.id === snapshotId}
                  onClick={() => {
                    setHistoryOpen(false);
                    setSp(new URLSearchParams({ snapshot: s.id }));
                  }}
                >
                  <ListItemText primary={new Date(s.createdAt).toLocaleString()} secondary={`${s.label ?? ''}${s.label ? ' · ' : ''}${s.rowCount.toLocaleString()} rows · ${(s.sizeBytes / 1024).toFixed(0)} KB`} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>

      {!embedded && <SubscriptionsDialog open={subsOpen} onClose={() => setSubsOpen(false)} report={report} values={values} />}
      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} />
    </Stack>
  );
}
