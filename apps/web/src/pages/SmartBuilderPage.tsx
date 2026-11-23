import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardActionArea,
  Checkbox,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  LinearProgress,
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import LinkIcon from '@mui/icons-material/Link';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingFlatIcon from '@mui/icons-material/TrendingFlat';
import InsightsIcon from '@mui/icons-material/Insights';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import LoopIcon from '@mui/icons-material/Loop';
import LeaderboardIcon from '@mui/icons-material/Leaderboard';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import FactCheckIcon from '@mui/icons-material/FactCheckOutlined';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import RestoreIcon from '@mui/icons-material/Restore';
import AddLinkIcon from '@mui/icons-material/AddLink';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswerOutlined';
import { useCreateDashboard, useDataSources, useSchemas } from '@/api/hooks';
import { useReportMutations } from '@/api/reports';
import { errorMessage } from '@/api/client';
import { useAnalyze, useCompose, useSaveModel, type AInsight, type ASuggestion, type ATable, type Analysis, type ModelOverrides, type QualityScore, type SuggestionKind } from '@/api/advisor';
import { AskBox } from '@/components/advisor/AskBox';
import {
  AddJoinDialog,
  CommitField,
  ModelSaveBar,
  RoleSelect,
  SynonymsField,
  TableModelEditor,
  addManualJoin,
  colKey,
  removeManualJoin,
  setColumnOv,
  setKpiOv,
  toggleJoinRemoved,
} from '@/components/advisor/ModelControls';
import type { DashboardDefinition, Panel, PanelType } from '@/api/types';
import { DsIcon, PageHeader } from '@/components/common/misc';
import { PanelRenderer } from '@/components/viz/PanelRenderer';
import { VIZ_TYPES } from '@/components/dashboard/PanelEditor';
import { useCan } from '@/auth/AuthContext';

const KIND_GROUPS: { id: string; label: string; kinds: SuggestionKind[] }[] = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'kpi', label: 'KPIs', kinds: ['kpi'] },
  { id: 'trend', label: 'Trends', kinds: ['trend', 'trendBy'] },
  { id: 'breakdown', label: 'Breakdowns', kinds: ['breakdown', 'share', 'failures', 'heatmap'] },
  { id: 'other', label: 'Tables & scatter', kinds: ['detail', 'relationship'] },
];

const fmtInt = (n: number) => n.toLocaleString();
const gradeColor = (g: QualityScore['grade']) => (g === 'A' ? 'success.main' : g === 'B' ? 'info.main' : g === 'C' ? 'warning.main' : 'error.main');

/** Client-side panel for previews (mirrors the server's compose mapping). */
function previewPanel(s: ASuggestion): Panel {
  const unit = s.unit as Panel['options']['unit'];
  const options: Panel['options'] = (() => {
    switch (s.kind) {
      case 'kpi':
        return { reducer: s.fields.category ? 'sum' : 'last', sparkline: !!s.fields.category, unit };
      case 'trend':
        return { unit, xField: 'time', yFields: ['value'], showLegend: false, smooth: true };
      case 'trendBy':
        return { unit, xField: 'time', yFields: ['value'], seriesField: 'series', stacked: true, showLegend: false };
      case 'breakdown':
      case 'failures':
        return { unit, xField: 'label', yFields: [s.fields.value ?? 'value'], horizontal: true, showLegend: false, color: s.kind === 'failures' ? '#E5484D' : undefined };
      case 'share':
        return { unit, donut: true, labelField: 'label', valueField: 'value', showLegend: false };
      case 'heatmap':
        return { unit, xField: 'x', yField: 'y', valueField: 'value' };
      case 'relationship':
        return { xField: s.fields.x, yField: s.fields.y };
      default:
        return { pageSize: 5 };
    }
  })();
  return { id: s.id, title: s.title, type: s.viz as PanelType, gridPos: { x: 0, y: 0, w: 12, h: 6 }, options };
}

/** Mounts children only once scrolled into view (dozens of charts would be slow otherwise). */
function Lazy({ height, children }: { height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ref.current || shown) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setShown(true), { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [shown]);
  return (
    <Box ref={ref} sx={{ height, position: 'relative', overflow: 'hidden' }}>
      {shown && children}
    </Box>
  );
}

function AnswerPreview({ s }: { s: ASuggestion }) {
  const result = useMemo(() => (s.preview ? { columns: s.preview.columns, rows: s.preview.rows, rowCount: s.preview.rows.length, truncated: false, durationMs: 0 } : null), [s.preview]);
  const panel = useMemo(() => ({ ...previewPanel(s), options: { ...previewPanel(s).options, ...(s.kind === 'detail' ? { pageSize: 8 } : {}), showLegend: s.kind === 'trendBy' } }), [s]);
  if (!result) return null;
  return (
    <Box sx={{ height: s.viz === 'kpi' ? 110 : s.viz === 'table' ? 330 : 280, position: 'relative' }}>
      <PanelRenderer panel={panel} result={result} />
    </Box>
  );
}

function Sparkline({ points, color = 'currentColor' }: { points: { v: number }[]; color?: string }) {
  if (points.length < 2) return null;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const d = vs.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (vs.length - 1)) * 120).toFixed(1)},${(30 - ((v - lo) / (hi - lo || 1)) * 26 - 2).toFixed(1)}`).join(' ');
  return (
    <svg width={120} height={30} viewBox="0 0 120 30" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

function SuggestionCard({ s, selected, onToggle, tableNames }: { s: ASuggestion; selected: boolean; onToggle: () => void; tableNames: Map<string, string> }) {
  const icon = VIZ_TYPES.find((v) => v.type === s.viz)?.icon;
  const result = useMemo(() => (s.preview ? { columns: s.preview.columns, rows: s.preview.rows, rowCount: s.preview.rows.length, truncated: false, durationMs: 0 } : null), [s.preview]);
  const panel = useMemo(() => previewPanel(s), [s]);
  return (
    <Card variant="outlined" sx={{ height: '100%', borderColor: selected ? 'primary.main' : 'divider', borderWidth: selected ? 2 : 1, bgcolor: 'surface.panel' }}>
      <CardActionArea onClick={onToggle} sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', p: 1.25 }}>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Checkbox size="small" checked={selected} sx={{ p: 0.25, mt: -0.25 }} tabIndex={-1} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ '& svg': { fontSize: 16, color: 'text.secondary' } }}>
              {icon}
              <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1.25 }} noWrap title={s.title}>
                {s.title}
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 32 }}>
              {s.description}
            </Typography>
          </Box>
          <Tooltip title="Relevance score">
            <Chip size="small" label={s.score} color={s.score >= 80 ? 'success' : s.score >= 60 ? 'primary' : 'default'} variant={s.recommended ? 'filled' : 'outlined'} sx={{ height: 20, fontWeight: 600 }} />
          </Tooltip>
        </Stack>
        <Box sx={{ mt: 1, mx: -0.5, pointerEvents: 'none' }}>
          <Lazy height={s.viz === 'kpi' ? 90 : 150}>{result && <PanelRenderer panel={panel} result={result} />}</Lazy>
        </Box>
        <Stack direction="row" spacing={0.5} sx={{ mt: 'auto', pt: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
          {s.question && <Chip size="small" icon={<QuestionAnswerIcon sx={{ fontSize: 14 }} />} label="Your question" color="primary" variant="outlined" sx={{ height: 20 }} />}
          {s.joinIds.length > 0 && <Chip size="small" icon={<LinkIcon sx={{ fontSize: 14 }} />} label={`${new Set(s.tables).size} tables`} color="secondary" variant="outlined" sx={{ height: 20 }} />}
          {[...new Set(s.tables)].slice(0, 3).map((t) => (
            <Chip key={t} size="small" label={tableNames.get(t) ?? t} variant="outlined" sx={{ height: 20, fontSize: 11 }} />
          ))}
        </Stack>
      </CardActionArea>
    </Card>
  );
}

function QualityPanel({ q }: { q: QualityScore | null }) {
  if (!q) return null;
  return (
    <Box>
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="h3" sx={{ fontWeight: 700, color: gradeColor(q.grade) }}>
          {q.score}
        </Typography>
        <Typography color="text.secondary">/ 100 · grade {q.grade}</Typography>
      </Stack>
      <Stack spacing={0.75} sx={{ mt: 1 }}>
        {q.parts.map((p) => (
          <Box key={p.name}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption">{p.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {p.score}/{p.max}
              </Typography>
            </Stack>
            <LinearProgress variant="determinate" value={(p.score / p.max) * 100} color={p.score / p.max >= 0.8 ? 'success' : p.score / p.max >= 0.5 ? 'primary' : 'warning'} sx={{ height: 5, borderRadius: 3 }} />
            {p.tip && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', lineHeight: 1.3, mt: 0.25 }}>
                {p.tip}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

const INSIGHT_ICON: Record<AInsight['kind'], JSX.Element> = {
  trend: <TrendingUpIcon />,
  growth: <InsightsIcon />,
  seasonality: <LoopIcon />,
  outlier: <WarningAmberIcon />,
  contributors: <LeaderboardIcon />,
  correlation: <ScatterPlotIcon />,
  quality: <FactCheckIcon />,
};

function InsightsTab({ a, tableNames }: { a: Analysis; tableNames: Map<string, string> }) {
  if (!a.insights.length) return <Alert severity="info">No statistical findings. The tables may have no time column or too few rows.</Alert>;
  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
      {a.insights.map((i) => {
        const dirIcon = i.direction === 'up' ? <TrendingUpIcon color="success" /> : i.direction === 'down' ? <TrendingDownIcon color="error" /> : i.direction === 'flat' ? <TrendingFlatIcon color="disabled" /> : null;
        return (
          <Paper key={i.id} variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel' }}>
            <Stack direction="row" spacing={1.25} alignItems="flex-start">
              <Box sx={{ color: i.kind === 'outlier' || i.kind === 'quality' ? 'warning.main' : 'primary.main', mt: 0.25 }}>{(i.kind === 'trend' || i.kind === 'growth') && dirIcon ? dirIcon : INSIGHT_ICON[i.kind]}</Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {i.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {i.detail}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }} alignItems="center">
                  <Chip size="small" label={i.kind} sx={{ height: 20 }} />
                  {i.table && <Chip size="small" variant="outlined" label={tableNames.get(i.table) ?? i.table} sx={{ height: 20 }} />}
                </Stack>
              </Box>
              {i.series && (
                <Box sx={{ color: 'primary.main', alignSelf: 'center' }}>
                  <Sparkline points={i.series} />
                </Box>
              )}
            </Stack>
          </Paper>
        );
      })}
    </Box>
  );
}

function TablesTab({ a, onBuildFor, draft, onDraft, canEdit }: { a: Analysis; onBuildFor: (t: ATable) => void; draft: ModelOverrides; onDraft: (ov: ModelOverrides) => void; canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);
  const list = a.tables.filter(
    (t) =>
      (!q || `${t.key} ${t.label ?? ''} ${(t.synonyms ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())) &&
      (!onlyEdited || draft.tables?.[t.key] || Object.keys(draft.columns ?? {}).some((k) => k.startsWith(`${t.key}|`))),
  );
  const hidden = Object.entries(draft.tables ?? {}).filter(([, v]) => v.hidden).map(([k]) => k);
  return (
    <Stack spacing={1}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <TextField size="small" placeholder="Filter tables" value={q} onChange={(e) => setQ(e.target.value)} sx={{ maxWidth: 360, flex: 1 }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <ToggleButton size="small" value="edited" selected={onlyEdited} onChange={() => setOnlyEdited((v) => !v)} sx={{ textTransform: 'none', px: 1.25 }}>
          <TuneIcon fontSize="small" sx={{ mr: 0.5 }} /> Corrected only
        </ToggleButton>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {canEdit
          ? 'Correct anything the analyzer got wrong: column roles, display names, synonyms (words people use in questions), time and label columns. Corrections are saved per data source and used by every analysis and question.'
          : 'Column profiles. Analysts and above can correct roles, names and synonyms.'}
      </Typography>
      {hidden.length > 0 && (
        <Alert severity="info" sx={{ py: 0 }}>
          Hidden from analysis: {hidden.map((k) => (
            <Chip key={k} size="small" label={k} onDelete={canEdit ? () => onDraft({ ...draft, tables: { ...draft.tables, [k]: { ...draft.tables![k], hidden: undefined } } }) : undefined} sx={{ height: 20, ml: 0.5 }} />
          ))}
        </Alert>
      )}
      {list.map((t) => (
        <Accordion key={t.key} disableGutters variant="outlined" TransitionProps={{ unmountOnExit: true }} sx={{ bgcolor: 'surface.panel', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ flex: 1, minWidth: 0, pr: 1 }}>
              <Typography sx={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13 }} noWrap>
                {t.key}
              </Typography>
              {t.label && (
                <Typography variant="body2" color="primary" noWrap>
                  {t.label}
                </Typography>
              )}
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                <Chip size="small" label={t.kind} color={t.kind === 'fact' ? 'primary' : t.kind === 'dimension' ? 'secondary' : 'default'} sx={{ height: 20 }} />
                <Chip size="small" variant="outlined" label={`${fmtInt(t.rowCount)} rows`} sx={{ height: 20 }} />
                {t.timeColumn && <Chip size="small" variant="outlined" label={`time: ${t.timeColumn}`} sx={{ height: 20 }} />}
                {t.labelColumn && <Chip size="small" variant="outlined" label={`label: ${t.labelColumn}`} sx={{ height: 20 }} />}
              </Stack>
              <Box sx={{ flex: 1 }} />
              <Tooltip title="Importance (size, relationships, measures, time column)">
                <Box sx={{ width: 90, display: { xs: 'none', sm: 'block' } }}>
                  <LinearProgress variant="determinate" value={t.importance} sx={{ height: 5, borderRadius: 3 }} />
                </Box>
              </Tooltip>
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0 }}>
            <TableModelEditor t={t} ov={draft} onChange={onDraft} canEdit={canEdit} />
            {t.notes.length > 0 && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1 }}>
                {t.notes.join(' · ')}
              </Typography>
            )}
            {t.sampled && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Profile from a sample of {fmtInt(t.sampleSize)} rows.
              </Typography>
            )}
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Column</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Display name & synonyms</TableCell>
                    <TableCell align="right">Null %</TableCell>
                    <TableCell align="right">Unique %</TableCell>
                    <TableCell align="right">Min</TableCell>
                    <TableCell align="right">Max</TableCell>
                    <TableCell align="right">Mean</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {t.columns.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{c.name}</TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{c.dataType}</TableCell>
                      <TableCell>
                        <RoleSelect c={c} value={draft.columns?.[colKey(t.key, c.name)]?.role} canEdit={canEdit} onChange={(role) => onDraft(setColumnOv(draft, t.key, c.name, { role }))} />
                      </TableCell>
                      <TableCell sx={{ minWidth: 300 }}>
                        <Stack direction="row" spacing={0.75}>
                          <CommitField
                            size="small"
                            variant="standard"
                            placeholder={c.label ?? c.name}
                            value={draft.columns?.[colKey(t.key, c.name)]?.label ?? ''}
                            disabled={!canEdit}
                            onCommit={(label) => onDraft(setColumnOv(draft, t.key, c.name, { label }))}
                            sx={{ width: 130 }}
                            inputProps={{ 'aria-label': `Display name of ${c.name}` }}
                          />
                          <SynonymsField label="" width={170} value={draft.columns?.[colKey(t.key, c.name)]?.synonyms ?? []} disabled={!canEdit} onChange={(synonyms) => onDraft(setColumnOv(draft, t.key, c.name, { synonyms }))} />
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ color: c.nullPct >= 50 ? 'warning.main' : undefined }}>{c.nullPct}</TableCell>
                      <TableCell align="right">{c.uniquePct}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtStat(c.min)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtStat(c.max)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{c.mean !== undefined ? c.mean.toLocaleString(undefined, { maximumFractionDigits: 2 }) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            {t.rowCount > 0 && (
              <Button size="small" startIcon={<AutoAwesomeIcon />} sx={{ mt: 1 }} onClick={() => onBuildFor(t)}>
                Select suggestions for this table
              </Button>
            )}
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}

function fmtStat(v: unknown) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 16).replace('T', ' ') : s;
}

export function SmartBuilderPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const can = useCan();
  const { data: dataSources = [] } = useDataSources();
  const sqlSources = dataSources.filter((d) => d.type !== 'MONGODB');
  const [dsId, setDsId] = useState(params.get('ds') ?? '');
  const [schemas, setSchemas] = useState<string[]>([]);
  const { data: allSchemas = [] } = useSchemas(dsId || undefined);
  const analyze = useAnalyze();
  const compose = useCompose();
  const createDash = useCreateDashboard();
  const reports = useReportMutations();
  const a = analyze.data;

  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<'dashboard' | 'report'>(params.get('target') === 'report' ? 'report' : 'dashboard');
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('all');
  const [tableFilter, setTableFilter] = useState('');
  const [quality, setQuality] = useState<QualityScore | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // Answers to questions (also kept in the server-side analysis so they compose like suggestions)
  const [answers, setAnswers] = useState<ASuggestion[]>([]);
  // Data model draft: corrections not saved yet
  const [draft, setDraft] = useState<ModelOverrides>({});
  const [addJoin, setAddJoin] = useState(false);
  const saveModel = useSaveModel();
  const canEdit = can.createDashboards;
  const lastInput = useRef<{ dataSourceId: string; schemas?: string[] } | null>(null);

  useEffect(() => {
    document.title = 'Smart builder · Graphan';
  }, []);
  useEffect(() => {
    if (!dsId && sqlSources[0]) setDsId(sqlSources[0].id);
  }, [sqlSources, dsId]);

  // New analysis → preselect the recommended set, default filter and title
  useEffect(() => {
    if (!a) return;
    setSelected(a.recommended);
    setFilter(a.dimensions[0]?.id ?? '');
    setTitle(`${a.dataSourceName} ${a.schemas.length === 1 ? `${a.schemas[0]} ` : ''}overview`);
    setQuality(a.quality);
    setAnswers([]);
    setDraft(a.model.overrides);
  }, [a]);

  // Live quality score for the current selection
  const composeReq = useRef(0);
  useEffect(() => {
    if (!a || !selected.length) {
      setQuality(null);
      return;
    }
    const n = ++composeReq.current;
    const h = setTimeout(() => {
      compose.mutate(
        { id: a.id, suggestionIds: selected, target, title, filter: filter || null },
        {
          onSuccess: (r) => {
            if (n !== composeReq.current) return;
            setQuality(r.quality);
            setNotes(r.notes);
          },
        },
      );
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, selected, target, filter]);

  const tableNames = useMemo(() => new Map((a?.tables ?? []).map((t) => [t.key, t.name])), [a]);
  const suggestions = useMemo(() => (a ? [...answers, ...a.suggestions.filter((s) => !s.question && !answers.some((x) => x.id === s.id))] : []), [a, answers]);
  const visible = useMemo(() => {
    if (!a) return [];
    const kinds = KIND_GROUPS.find((g) => g.id === group)?.kinds ?? [];
    const q = search.toLowerCase();
    return suggestions.filter(
      (s) => (!kinds.length || kinds.includes(s.kind)) && (!tableFilter || s.tables.includes(tableFilter)) && (!q || `${s.title} ${s.description} ${s.tables.join(' ')}`.toLowerCase().includes(q)),
    );
  }, [a, suggestions, group, search, tableFilter]);
  const suggestionTables = useMemo(() => [...new Set(suggestions.map((s) => s.table))], [suggestions]);

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const run = (fresh = false) => {
    lastInput.current = { dataSourceId: dsId, schemas: schemas.length ? schemas : undefined };
    analyze.mutate({ ...lastInput.current, fresh });
  };
  const onAnswer = (s: ASuggestion) => {
    setAnswers((cur) => {
      const old = cur.find((x) => x.question?.toLowerCase() === s.question?.toLowerCase());
      if (old) setSelected((sel) => sel.filter((id) => id !== old.id));
      return [s, ...cur.filter((x) => x !== old)];
    });
  };
  const saveAndRerun = async () => {
    if (!a) return;
    await saveModel.mutateAsync({ dataSourceId: a.dataSourceId, overrides: draft });
    analyze.mutate({ ...(lastInput.current ?? { dataSourceId: a.dataSourceId }), fresh: false });
  };
  const onDraftKpi = (id: string, detected: string, name: string) => setDraft(setKpiOv(draft, id, { name: name && name !== detected ? name : undefined }));
  const removedJoins = draft.joins?.remove ?? [];
  const pendingJoins = (draft.joins?.add ?? []).filter((m) => !a?.joins.some((j) => j.source === 'manual' && j.left.table === m.left.table && j.left.column === m.left.column && j.left.schema === m.left.schema && j.right.table === m.right.table && j.right.column === m.right.column));

  const create = async () => {
    if (!a) return;
    const r = await compose.mutateAsync({ id: a.id, suggestionIds: selected, target, title, filter: filter || null });
    if (target === 'dashboard') {
      const d = await createDash.mutateAsync({ title: r.title, description: r.description, tags: ['generated'], definition: r.definition as DashboardDefinition });
      navigate(`/dashboards/${d.id}`);
    } else {
      const rep = await reports.create.mutateAsync({ title: r.title, description: r.description, folder: '/Generated', definition: r.definition as Record<string, unknown> });
      navigate(`/reports/${rep.id}`);
    }
  };
  const createError = createDash.error ?? reports.create.error;

  return (
    <Box>
      <PageHeader
        icon={<AutoAwesomeIcon color="primary" sx={{ fontSize: 32 }} />}
        title="Smart builder"
        subtitle="Analyse a whole database: Graphan profiles every table, finds how tables join, detects KPIs and trends, and suggests dashboards and reports you can build in one click."
      />

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'surface.panel' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField select size="small" label="Data source" value={dsId} onChange={(e) => (setDsId(e.target.value), setSchemas([]))} sx={{ minWidth: 240 }}>
            {sqlSources.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DsIcon type={d.type} size={20} />
                  <span>{d.name}</span>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          <Autocomplete
            multiple
            size="small"
            options={allSchemas}
            value={schemas}
            onChange={(_e, v) => setSchemas(v)}
            sx={{ flex: 1, minWidth: 240 }}
            renderInput={(p) => <TextField {...p} label="Schemas" placeholder={schemas.length ? '' : 'All schemas'} />}
          />
          <Button variant="contained" size="large" startIcon={<AutoAwesomeIcon />} disabled={!dsId || analyze.isPending} onClick={() => run(false)}>
            Analyse database
          </Button>
          {a && (
            <Tooltip title="Analyse again (ignore the 15-minute cache)">
              <span>
                <Button startIcon={<RefreshIcon />} disabled={analyze.isPending} onClick={() => run(true)}>
                  Refresh
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>
        {analyze.isPending && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress />
            <Typography variant="caption" color="text.secondary">
              Reading table structures, sampling rows, testing joins and running candidate queries. Read-only; usually a few seconds.
            </Typography>
          </Box>
        )}
        {analyze.error && <Alert severity="error" sx={{ mt: 2 }}>{errorMessage(analyze.error)}</Alert>}
      </Paper>

      {!a && !analyze.isPending && (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center', bgcolor: 'surface.panel' }}>
          <AutoAwesomeIcon color="primary" sx={{ fontSize: 48 }} />
          <Typography variant="h6" sx={{ mt: 1 }}>
            Pick a data source and click Analyse database
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 720, mx: 'auto', mt: 1 }}>
            No SQL needed. Graphan classifies every column (keys, time, measures, dimensions), recommends joins between tables (declared foreign keys plus matches found by name, data type and value overlap), ranks KPIs, finds trends, growth, seasonality, outliers and top contributors, and proposes ready-to-use panels with live previews. Choose the ones you want and create a dashboard or a paginated report.
          </Typography>
        </Paper>
      )}

      {a && (
        <>
          <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
            <Chip label={`${a.summary.analysed} tables analysed${a.summary.emptyTables ? ` (${a.summary.emptyTables} empty)` : ''}`} />
            <Chip label={`${fmtInt(a.summary.rows)} rows`} />
            <Chip icon={<LinkIcon />} label={`${a.summary.joins} joins (${a.summary.declaredJoins} declared, ${a.summary.inferredJoins} inferred)`} />
            <Chip label={`${a.summary.kpis} KPIs`} />
            <Chip label={`${a.summary.insights} insights`} />
            <Chip variant="outlined" label={`${(a.durationMs / 1000).toFixed(1)} s`} />
            <Chip
              icon={<TuneIcon />}
              variant="outlined"
              color={a.model.corrections ? 'warning' : 'default'}
              label={a.model.corrections ? `Data model: ${a.model.corrections} correction${a.model.corrections === 1 ? '' : 's'}` : 'Data model: no corrections'}
              onClick={() => setTab(4)}
            />
          </Stack>
          <AskBox analysisId={a.id} examples={a.examples} selected={selected} onAnswer={onAnswer} onToggle={toggle} renderPreview={(s) => <AnswerPreview s={s} />} onTeach={() => setTab(4)} />
          {a.warnings.map((w) => (
            <Alert key={w} severity="warning" sx={{ mb: 1 }}>
              {w}
            </Alert>
          ))}

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 340px' }, alignItems: 'start' }}>
            <Box sx={{ minWidth: 0 }}>
              <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
                <Tab label={`Suggestions (${suggestions.length})`} />
                <Tab label={`Insights (${a.insights.length})`} />
                <Tab label={`KPIs (${a.kpis.length})`} />
                <Tab label={`Joins (${a.joins.length})`} />
                <Tab label="Tables & columns" />
              </Tabs>

              {tab === 0 && (
                <>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1.5 }} alignItems={{ md: 'center' }}>
                    <TextField size="small" placeholder="Search suggestions" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ minWidth: 220 }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
                    <TextField select size="small" label="Table" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} sx={{ minWidth: 200 }}>
                      <MenuItem value="">All tables</MenuItem>
                      {suggestionTables.map((t) => (
                        <MenuItem key={t} value={t}>
                          {t}
                        </MenuItem>
                      ))}
                    </TextField>
                    <ToggleButtonGroup size="small" exclusive value={group} onChange={(_e, v) => v && setGroup(v)} sx={{ flexWrap: 'wrap' }}>
                      {KIND_GROUPS.map((g) => (
                        <ToggleButton key={g.id} value={g.id} sx={{ textTransform: 'none', px: 1.25 }}>
                          {g.label}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" onClick={() => setSelected(a.recommended)}>
                      Recommended
                    </Button>
                    <Button size="small" onClick={() => setSelected((cur) => [...new Set([...cur, ...visible.map((s) => s.id)])])}>
                      Select shown
                    </Button>
                    <Button size="small" color="inherit" onClick={() => setSelected([])}>
                      Clear
                    </Button>
                  </Stack>
                  {!visible.length && <Alert severity="info">No suggestions match.</Alert>}
                  <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', xl: '1fr 1fr 1fr' } }}>
                    {visible.map((s) => (
                      <SuggestionCard key={s.id} s={s} selected={selected.includes(s.id)} onToggle={() => toggle(s.id)} tableNames={tableNames} />
                    ))}
                  </Box>
                </>
              )}

              {tab === 1 && <InsightsTab a={a} tableNames={tableNames} />}

              {tab === 2 && (
                <Paper variant="outlined" sx={{ overflowX: 'auto', bgcolor: 'surface.panel' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>KPI</TableCell>
                        <TableCell>Table</TableCell>
                        <TableCell>Category</TableCell>
                        <TableCell width={140}>Score</TableCell>
                        <TableCell>Why</TableCell>
                        {canEdit && <TableCell width={48} />}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {a.kpis.map((k) => (
                        <TableRow key={k.id} hover sx={{ opacity: draft.kpis?.[k.id]?.hidden ? 0.45 : 1 }}>
                          <TableCell sx={{ fontWeight: 500, minWidth: 220 }}>
                            {canEdit ? (
                              <CommitField size="small" variant="standard" fullWidth value={draft.kpis?.[k.id]?.name ?? k.name} onCommit={(name) => onDraftKpi(k.id, k.name, name)} inputProps={{ 'aria-label': `Name of KPI ${k.name}` }} />
                            ) : (
                              k.name
                            )}
                          </TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{k.table}{k.column ? `.${k.column}` : ''}</TableCell>
                          <TableCell><Chip size="small" label={k.category} sx={{ height: 20 }} /></TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <LinearProgress variant="determinate" value={k.score} sx={{ flex: 1, height: 5, borderRadius: 3 }} />
                              <Typography variant="caption">{k.score}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{k.reason}</TableCell>
                          {canEdit && (
                            <TableCell>
                              <Tooltip title={draft.kpis?.[k.id]?.hidden ? 'Show this KPI again' : 'Hide this KPI (not a useful number)'}>
                                <IconButton size="small" onClick={() => setDraft(setKpiOv(draft, k.id, { hidden: draft.kpis?.[k.id]?.hidden ? undefined : true }))}>
                                  {draft.kpis?.[k.id]?.hidden ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
                                </IconButton>
                              </Tooltip>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Paper>
              )}

              {tab === 3 && (
                <Paper variant="outlined" sx={{ overflowX: 'auto', bgcolor: 'surface.panel' }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ p: 1.5, pb: 0 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                      Inferred joins are scored as name similarity × 0.3 + data-type match × 0.2 + value overlap × 0.5; only joins above 80% are kept. Declared foreign keys score 100. Remove a wrong join or add a missing one; corrections apply to every analysis of this data source.
                    </Typography>
                    {canEdit && (
                      <Button size="small" variant="outlined" startIcon={<AddLinkIcon />} onClick={() => setAddJoin(true)} sx={{ flexShrink: 0 }}>
                        Add join
                      </Button>
                    )}
                  </Stack>
                  {(pendingJoins.length > 0 || removedJoins.some((id) => !a.joins.some((j) => j.id === id))) && (
                    <Stack spacing={0.5} sx={{ px: 1.5, pt: 1 }}>
                      {pendingJoins.map((m) => (
                        <Typography key={`${m.left.schema}.${m.left.table}.${m.left.column}`} variant="caption" color="success.main">
                          Will be added on save: {m.left.schema}.{m.left.table}.{m.left.column} → {m.right.schema}.{m.right.table}.{m.right.column}{' '}
                          <Button size="small" sx={{ p: 0, minWidth: 0, textTransform: 'none', fontSize: 'inherit' }} onClick={() => setDraft(removeManualJoin(draft, `${m.left.schema}.${m.left.table}.${m.left.column}`))}>
                            undo
                          </Button>
                        </Typography>
                      ))}
                      {removedJoins.filter((id) => !a.joins.some((j) => j.id === id)).map((id) => (
                        <Typography key={id} variant="caption" color="text.secondary">
                          Removed: {id.replace(/^j:/, '')}{' '}
                          <Button size="small" sx={{ p: 0, minWidth: 0, textTransform: 'none', fontSize: 'inherit' }} disabled={!canEdit} onClick={() => setDraft(toggleJoinRemoved(draft, id))}>
                            restore
                          </Button>
                        </Typography>
                      ))}
                    </Stack>
                  )}
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>From (many)</TableCell>
                        <TableCell>To (one)</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell width={140}>Confidence</TableCell>
                        <TableCell align="right">Name</TableCell>
                        <TableCell align="right">Type</TableCell>
                        <TableCell align="right">Overlap</TableCell>
                        {canEdit && <TableCell width={48} />}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {[...a.joins].sort((x, y) => Number(x.source === 'declared') - Number(y.source === 'declared') || y.confidence - x.confidence).map((j) => (
                        <TableRow key={j.id} hover sx={{ opacity: removedJoins.includes(j.id) ? 0.45 : 1, textDecoration: removedJoins.includes(j.id) ? 'line-through' : undefined }}>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{j.left.schema}.{j.left.table}.<b>{j.left.column}</b></TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{j.right.schema}.{j.right.table}.<b>{j.right.column}</b></TableCell>
                          <TableCell><Chip size="small" label={j.source === 'declared' ? 'Foreign key' : j.source === 'manual' ? 'Manual' : 'Inferred'} color={j.source === 'declared' ? 'default' : j.source === 'manual' ? 'warning' : 'secondary'} sx={{ height: 20 }} /></TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <LinearProgress variant="determinate" value={j.confidence} color={j.confidence >= 95 ? 'success' : 'primary'} sx={{ flex: 1, height: 5, borderRadius: 3 }} />
                              <Typography variant="caption">{j.confidence}%</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell align="right" sx={{ fontSize: 12 }}>{j.scores?.name ?? ''}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12 }}>{j.scores?.datatype ?? ''}</TableCell>
                          <TableCell align="right" sx={{ fontSize: 12 }}>{j.scores?.overlap ?? ''}</TableCell>
                          {canEdit && (
                            <TableCell>
                              <Tooltip title={removedJoins.includes(j.id) ? 'Keep this join' : j.source === 'manual' ? 'Delete this manual join' : 'Wrong join: remove it'}>
                                <IconButton
                                  size="small"
                                  onClick={() =>
                                    setDraft(j.source === 'manual' ? removeManualJoin(draft, `${j.left.schema}.${j.left.table}.${j.left.column}`) : toggleJoinRemoved(draft, j.id))
                                  }
                                >
                                  {removedJoins.includes(j.id) ? <RestoreIcon fontSize="small" /> : <DeleteIcon fontSize="small" />}
                                </IconButton>
                              </Tooltip>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Paper>
              )}

              {tab === 4 && (
                <TablesTab
                  a={a}
                  draft={draft}
                  onDraft={setDraft}
                  canEdit={canEdit}
                  onBuildFor={(t) => {
                    const ids = suggestions.filter((s) => s.table === t.key).slice(0, 10).map((s) => s.id);
                    setSelected(ids);
                    setTableFilter(t.key);
                    setTitle(`${t.name} overview`);
                    setTab(0);
                  }}
                />
              )}
              <ModelSaveBar
                draft={draft}
                saved={a.model.overrides}
                saving={saveModel.isPending || analyze.isPending}
                error={saveModel.error ? errorMessage(saveModel.error) : undefined}
                onSave={saveAndRerun}
                onDiscard={() => setDraft(a.model.overrides)}
              />
              <AddJoinDialog open={addJoin} onClose={() => setAddJoin(false)} tables={a.tables} onAdd={(j) => setDraft(addManualJoin(draft, j))} />
            </Box>

            {/* Build panel */}
            <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel', position: { lg: 'sticky' }, top: { lg: 72 } }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
                Build
              </Typography>
              <Stack spacing={1.5}>
                <ToggleButtonGroup exclusive fullWidth size="small" value={target} onChange={(_e, v) => v && setTarget(v)}>
                  <ToggleButton value="dashboard" sx={{ textTransform: 'none', gap: 0.75 }}>
                    <SpaceDashboardIcon fontSize="small" /> Dashboard
                  </ToggleButton>
                  <ToggleButton value="report" sx={{ textTransform: 'none', gap: 0.75 }}>
                    <DescriptionIcon fontSize="small" /> Report
                  </ToggleButton>
                </ToggleButtonGroup>
                <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <TextField select size="small" label={target === 'dashboard' ? 'Filter variable' : 'Filter parameter'} value={filter} onChange={(e) => setFilter(e.target.value)} helperText="Viewers can slice every panel that can reach this column.">
                  <MenuItem value="">None</MenuItem>
                  {a.dimensions.map((d) => (
                    <MenuItem key={d.id} value={d.id}>
                      {d.label}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        {d.table.table}.{d.col}
                      </Typography>
                    </MenuItem>
                  ))}
                </TextField>
                <Divider />
                <Typography variant="body2">
                  <b>{selected.length}</b> panel{selected.length === 1 ? '' : 's'} selected
                </Typography>
                {selected.length > 0 ? <QualityPanel q={quality} /> : <Typography variant="caption" color="text.secondary">Select suggestions to see the quality score.</Typography>}
                {notes.map((n) => (
                  <Typography key={n} variant="caption" color="text.secondary">
                    {n}
                  </Typography>
                ))}
                {createError && <Alert severity="error">{errorMessage(createError)}</Alert>}
                {compose.error && !compose.isPending && <Alert severity="error">{errorMessage(compose.error)}</Alert>}
                <Button
                  variant="contained"
                  size="large"
                  startIcon={target === 'dashboard' ? <SpaceDashboardIcon /> : <DescriptionIcon />}
                  disabled={!can.createDashboards || !selected.length || createDash.isPending || reports.create.isPending}
                  onClick={create}
                >
                  Create {target}
                </Button>
                {!can.createDashboards && (
                  <Typography variant="caption" color="text.secondary">
                    Your role can analyse but not create {target}s.
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  {target === 'dashboard'
                    ? 'Creates an editable dashboard: time range, filter with drill-down, forecasting on the main trend. Every panel query can be changed afterwards.'
                    : 'Creates a paginated report in /Generated with date range and filter parameters, ready for PDF/Excel export and subscriptions.'}
                </Typography>
              </Stack>
            </Paper>
          </Box>
        </>
      )}
    </Box>
  );
}
