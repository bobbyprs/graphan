import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppBar,
  Autocomplete,
  Box,
  Button,
  Dialog,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import BarChartIcon from '@mui/icons-material/BarChart';
import PieChartIcon from '@mui/icons-material/PieChart';
import StackedLineChartIcon from '@mui/icons-material/StackedLineChart';
import ScatterPlotIcon from '@mui/icons-material/ScatterPlot';
import GridOnIcon from '@mui/icons-material/GridOn';
import SpeedIcon from '@mui/icons-material/Speed';
import LooksOneIcon from '@mui/icons-material/LooksOne';
import TableChartIcon from '@mui/icons-material/TableChart';
import DashboardIcon from '@mui/icons-material/SpaceDashboard';
import PublicIcon from '@mui/icons-material/Public';
import NotesIcon from '@mui/icons-material/Notes';
import { useCompletion, useDataSources, useExecuteQuery } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { Panel, PanelOptions, PanelType, Transforms, Variable } from '@/api/types';
import { HOLOGRAPH_TYPES, supportsWebGL2 } from '@/components/viz/holographSupport';
import { SqlEditor } from '@/components/common/SqlEditor';
import { PanelRenderer } from '@/components/viz/PanelRenderer';
import { DsIcon } from '@/components/common/misc';
import { ForecastSettings } from '@/components/ml/ForecastSettings';
import { isForecastColumn } from '@/components/viz/echartsOptions';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import { useDataModel } from '@/api/advisor';
import { useCan } from '@/auth/AuthContext';

export const VIZ_TYPES: { type: PanelType; label: string; icon: JSX.Element }[] = [
  { type: 'line', label: 'Line', icon: <ShowChartIcon /> },
  { type: 'area', label: 'Area', icon: <StackedLineChartIcon /> },
  { type: 'bar', label: 'Bar', icon: <BarChartIcon /> },
  { type: 'pie', label: 'Pie', icon: <PieChartIcon /> },
  { type: 'scatter', label: 'Scatter', icon: <ScatterPlotIcon /> },
  { type: 'heatmap', label: 'Heat map', icon: <GridOnIcon /> },
  { type: 'gauge', label: 'Gauge', icon: <SpeedIcon /> },
  { type: 'kpi', label: 'KPI', icon: <LooksOneIcon /> },
  { type: 'table', label: 'Table', icon: <TableChartIcon /> },
  { type: 'treemap', label: 'Tree map', icon: <DashboardIcon /> },
  { type: 'geomap', label: 'Geo map', icon: <PublicIcon /> },
  { type: 'text', label: 'Text', icon: <NotesIcon /> },
];

interface Props {
  open: boolean;
  panel: Panel;
  variables: Variable[];
  timeRange: { from: string; to: string };
  variableValues: Record<string, unknown>;
  onClose: () => void;
  onApply: (p: Panel) => void;
}

function FieldSelect({ label, value, columns, onChange, multiple }: { label: string; value?: string | string[]; columns: string[]; onChange: (v: any) => void; multiple?: boolean }) {
  if (multiple) {
    return (
      <Autocomplete
        multiple
        size="small"
        options={columns}
        value={(value as string[]) ?? []}
        onChange={(_e, v) => onChange(v.length ? v : undefined)}
        renderInput={(p) => <TextField {...p} label={label} placeholder="auto" />}
      />
    );
  }
  return (
    <Autocomplete
      size="small"
      options={columns}
      value={(value as string) ?? null}
      onChange={(_e, v) => onChange(v ?? undefined)}
      renderInput={(p) => <TextField {...p} label={label} placeholder="auto" />}
    />
  );
}

export function PanelEditor({ open, panel: initial, variables, timeRange, variableValues, onClose, onApply }: Props) {
  const [panel, setPanel] = useState<Panel>(initial);
  const [tab, setTab] = useState(0);
  const { data: dataSources = [] } = useDataSources();
  const { data: catalog } = useCompletion(panel.dataSourceId ?? undefined);
  const canExplore = useCan().explore;
  const { data: dataModel } = useDataModel(panel.dataSourceId ?? undefined, canExplore);
  const exec = useExecuteQuery();

  useEffect(() => setPanel(initial), [initial]);

  const ds = dataSources.find((d) => d.id === panel.dataSourceId);
  const columns = useMemo(() => exec.data?.columns.map((c) => c.name).filter((c) => !isForecastColumn(c)) ?? [], [exec.data]);
  const set = (patch: Partial<Panel>) => setPanel((p) => ({ ...p, ...patch }));
  const setOpt = (patch: Partial<PanelOptions>) => setPanel((p) => ({ ...p, options: { ...p.options, ...patch } }));
  const setTx = (patch: Partial<Transforms>) => setPanel((p) => ({ ...p, transforms: { ...p.transforms, ...patch } }));

  const run = (sql?: string) => {
    if (!panel.dataSourceId || !(sql ?? panel.query)) return;
    exec.mutate({ dataSourceId: panel.dataSourceId, sql: sql ?? panel.query!, timeRange, variables: variableValues, transforms: panel.transforms });
  };

  // Re-run the preview shortly after forecast settings change
  const fcKey = JSON.stringify(panel.transforms?.forecast ?? null);
  const lastFcKey = useRef(fcKey);
  useEffect(() => {
    if (lastFcKey.current === fcKey) return;
    lastFcKey.current = fcKey;
    const t = setTimeout(() => run(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fcKey]);

  // Auto-run when the editor opens on an existing query
  useEffect(() => {
    if (open && initial.query && initial.dataSourceId) run(initial.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial.id]);

  const o = panel.options;
  const calc = panel.transforms?.calculatedFields ?? [];
  const usesXY = ['line', 'area', 'bar', 'scatter', 'heatmap'].includes(panel.type);
  const usesValue = ['pie', 'gauge', 'kpi', 'treemap', 'geomap', 'heatmap'].includes(panel.type);

  return (
    <Dialog fullScreen open={open} onClose={onClose}>
      <AppBar position="static" color="default" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <IconButton edge="start" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flex: 1 }}>
            Edit panel
          </Typography>
          <Button onClick={onClose}>Discard</Button>
          <Button variant="contained" onClick={() => onApply(panel)}>
            Apply
          </Button>
        </Toolbar>
      </AppBar>

      <Stack direction={{ xs: 'column', lg: 'row' }} sx={{ flex: 1, minHeight: 0, overflow: { xs: 'auto', lg: 'hidden' } }}>
        {/* Left: preview + query */}
        <Stack sx={{ flex: 1, minWidth: 0, p: 2, gap: 2, overflow: 'auto' }}>
          <Box sx={{ height: 340, border: 1, borderColor: 'divider', borderRadius: 1, p: 1, bgcolor: 'surface.panel', flexShrink: 0 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {panel.title || 'Untitled panel'}
            </Typography>
            <Box sx={{ height: 'calc(100% - 28px)' }}>
              {exec.error ? (
                <Alert severity="error">{errorMessage(exec.error)}</Alert>
              ) : (
                <PanelRenderer panel={panel} result={exec.data ?? { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 0 }} />
              )}
            </Box>
          </Box>

          {panel.type !== 'text' && (
            <>
              <Tabs value={tab} onChange={(_e, v) => setTab(v)}>
                <Tab label="Query" />
                <Tab label={`Transform${calc.length ? ` (${calc.length})` : ''}`} />
                <Tab
                  icon={<AutoGraphIcon sx={{ fontSize: 18 }} />}
                  iconPosition="start"
                  sx={{ minHeight: 48 }}
                  label={panel.transforms?.forecast?.enabled ? 'Predict · on' : 'Predict'}
                />
              </Tabs>
              {tab === 0 && (
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      select
                      label="Data source"
                      value={panel.dataSourceId ?? ''}
                      onChange={(e) => set({ dataSourceId: e.target.value })}
                      sx={{ minWidth: 260 }}
                    >
                      {dataSources.map((d) => (
                        <MenuItem key={d.id} value={d.id}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <DsIcon type={d.type} size={20} />
                            <span>{d.name}</span>
                          </Stack>
                        </MenuItem>
                      ))}
                    </TextField>
                    <Box sx={{ flex: 1 }} />
                    {exec.data && (
                      <Typography variant="caption" color="text.secondary">
                        {exec.data.rowCount} rows · {exec.data.durationMs} ms
                      </Typography>
                    )}
                    <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => run()} disabled={exec.isPending || !panel.dataSourceId}>
                      Run
                    </Button>
                  </Stack>
                  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                    <SqlEditor
                      value={panel.query ?? ''}
                      onChange={(v) => set({ query: v })}
                      onRun={run}
                      language={ds?.type === 'MONGODB' ? 'json' : 'sql'}
                      catalog={catalog}
                      joins={dataModel?.joins}
                      variables={variables.map((v) => v.name)}
                      height={240}
                    />
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Macros: <code>$__timeFilter(col)</code>, <code>$__timeGroup(col, auto)</code>, <code>$__timeFrom</code>, <code>$__timeTo</code>. Variables:{' '}
                    {variables.length ? variables.map((v) => <code key={v.name}>{`\${${v.name}}`} </code>) : 'none'} — all values are sent as bound parameters.
                    Ctrl/⌘+Enter runs.
                  </Typography>
                </Stack>
              )}
              {tab === 1 && (
                <Stack spacing={2}>
                  <Typography variant="subtitle2">Calculated fields</Typography>
                  {calc.map((c, i) => (
                    <Stack key={i} direction="row" spacing={1}>
                      <TextField
                        label="Name"
                        value={c.name}
                        onChange={(e) => setTx({ calculatedFields: calc.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                        sx={{ width: 180 }}
                      />
                      <TextField
                        label="Expression"
                        value={c.expression}
                        onChange={(e) => setTx({ calculatedFields: calc.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)) })}
                        placeholder="round(revenue / orders, 2)"
                        sx={{ flex: 1 }}
                        InputProps={{ sx: { fontFamily: 'monospace' } }}
                      />
                      <IconButton onClick={() => setTx({ calculatedFields: calc.filter((_x, j) => j !== i) })} aria-label="Remove">
                        <DeleteIcon />
                      </IconButton>
                    </Stack>
                  ))}
                  <Box>
                    <Button startIcon={<AddIcon />} onClick={() => setTx({ calculatedFields: [...calc, { name: `calc_${calc.length + 1}`, expression: '' }] })}>
                      Add calculated field
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    Operators + − × ÷ % ^, comparisons, &amp;&amp; ||. Functions: abs, round, floor, ceil, sqrt, log, min, max, if, coalesce, pct, safediv, upper,
                    lower, concat, year, month, day. Use [col name] for names with spaces.
                  </Typography>
                  <Divider />
                  <Typography variant="subtitle2">Aggregate</Typography>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    <Box sx={{ flex: 1 }}>
                      <FieldSelect
                        label="Group by"
                        multiple
                        columns={columns}
                        value={panel.transforms?.groupBy?.fields}
                        onChange={(fields?: string[]) =>
                          setTx({ groupBy: fields ? { fields, aggregations: panel.transforms?.groupBy?.aggregations ?? [{ field: columns[1] ?? '', fn: 'sum' }] } : undefined })
                        }
                      />
                    </Box>
                    {panel.transforms?.groupBy && (
                      <>
                        <Box sx={{ flex: 1 }}>
                          <FieldSelect
                            label="Aggregate field"
                            columns={columns}
                            value={panel.transforms.groupBy.aggregations[0]?.field}
                            onChange={(f?: string) =>
                              f && setTx({ groupBy: { ...panel.transforms!.groupBy!, aggregations: [{ ...panel.transforms!.groupBy!.aggregations[0], field: f }] } })
                            }
                          />
                        </Box>
                        <TextField
                          select
                          label="Function"
                          value={panel.transforms.groupBy.aggregations[0]?.fn ?? 'sum'}
                          onChange={(e) =>
                            setTx({
                              groupBy: {
                                ...panel.transforms!.groupBy!,
                                aggregations: [{ ...panel.transforms!.groupBy!.aggregations[0], fn: e.target.value as 'sum' }],
                              },
                            })
                          }
                          sx={{ width: 140 }}
                        >
                          {['sum', 'avg', 'min', 'max', 'count', 'distinct', 'first', 'last'].map((f) => (
                            <MenuItem key={f} value={f}>
                              {f}
                            </MenuItem>
                          ))}
                        </TextField>
                      </>
                    )}
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    <Box sx={{ flex: 1 }}>
                      <FieldSelect
                        label="Sort by"
                        columns={[...columns, ...calc.map((c) => c.name)]}
                        value={panel.transforms?.sort?.[0]?.field}
                        onChange={(f?: string) => setTx({ sort: f ? [{ field: f, dir: panel.transforms?.sort?.[0]?.dir ?? 'desc' }] : [] })}
                      />
                    </Box>
                    <TextField
                      select
                      label="Direction"
                      value={panel.transforms?.sort?.[0]?.dir ?? 'desc'}
                      onChange={(e) => panel.transforms?.sort?.[0] && setTx({ sort: [{ ...panel.transforms.sort[0], dir: e.target.value as 'asc' }] })}
                      sx={{ width: 130 }}
                    >
                      <MenuItem value="asc">Ascending</MenuItem>
                      <MenuItem value="desc">Descending</MenuItem>
                    </TextField>
                    <TextField
                      type="number"
                      label="Limit"
                      value={panel.transforms?.limit ?? ''}
                      onChange={(e) => setTx({ limit: e.target.value ? Number(e.target.value) : undefined })}
                      sx={{ width: 110 }}
                    />
                  </Stack>
                  <Box>
                    <Button variant="outlined" startIcon={<PlayArrowIcon />} onClick={() => run()}>
                      Apply &amp; preview
                    </Button>
                  </Box>
                </Stack>
              )}
            </>
          )}
          {panel.type !== 'text' && tab === 2 && (
            <ForecastSettings
              value={panel.transforms?.forecast}
              onChange={(forecast) => setTx({ forecast })}
              result={exec.data}
              panelType={panel.type}
              options={panel.options}
            />
          )}
          {panel.type === 'text' && (
            <TextField
              label="Markdown content"
              multiline
              minRows={10}
              value={String(o.content ?? '')}
              onChange={(e) => setOpt({ content: e.target.value })}
              InputProps={{ sx: { fontFamily: 'monospace' } }}
            />
          )}
        </Stack>

        {/* Right: options */}
        <Box sx={{ width: { lg: 360 }, borderLeft: { lg: 1 }, borderColor: { lg: 'divider' }, p: 2, overflow: 'auto' }}>
          <Stack spacing={2}>
            <TextField label="Title" value={panel.title} onChange={(e) => set({ title: e.target.value })} />
            <TextField label="Description" value={panel.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} multiline maxRows={3} />
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Visualization
              </Typography>
              <ToggleButtonGroup
                exclusive
                value={panel.type}
                onChange={(_e, v) => v && set({ type: v })}
                sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0.5, '& .MuiToggleButton-root': { border: 1, borderColor: 'divider', borderRadius: '4px !important' } }}
              >
                {VIZ_TYPES.map((v) => (
                  <Tooltip key={v.type} title={v.label}>
                    <ToggleButton value={v.type} sx={{ flexDirection: 'column', gap: 0.25, py: 0.75, fontSize: 11 }}>
                      {v.icon}
                      {v.label}
                    </ToggleButton>
                  </Tooltip>
                ))}
              </ToggleButtonGroup>
            </Box>

            {panel.type !== 'text' && (
              <>
                <Divider textAlign="left">Fields</Divider>
                {usesXY && <FieldSelect label="X field" columns={columns} value={o.xField} onChange={(v) => setOpt({ xField: v })} />}
                {['line', 'area', 'bar'].includes(panel.type) && (
                  <FieldSelect label="Y fields" multiple columns={columns} value={o.yFields} onChange={(v) => setOpt({ yFields: v })} />
                )}
                {['scatter', 'heatmap'].includes(panel.type) && <FieldSelect label="Y field" columns={columns} value={o.yField} onChange={(v) => setOpt({ yField: v })} />}
                {['line', 'area', 'bar', 'scatter'].includes(panel.type) && (
                  <FieldSelect label="Series field (long format → pivot)" columns={columns} value={o.seriesField} onChange={(v) => setOpt({ seriesField: v })} />
                )}
                {usesValue && <FieldSelect label="Value field" columns={[...columns, ...calc.map((c) => c.name)]} value={o.valueField} onChange={(v) => setOpt({ valueField: v })} />}
                {['pie', 'geomap'].includes(panel.type) && <FieldSelect label="Label field" columns={columns} value={o.labelField} onChange={(v) => setOpt({ labelField: v })} />}
                {panel.type === 'geomap' && (
                  <>
                    <FieldSelect label="Latitude field" columns={columns} value={o.latField} onChange={(v) => setOpt({ latField: v })} />
                    <FieldSelect label="Longitude field" columns={columns} value={o.lonField} onChange={(v) => setOpt({ lonField: v })} />
                  </>
                )}
                {panel.type === 'treemap' && <FieldSelect label="Hierarchy fields" multiple columns={columns} value={o.groupFields} onChange={(v) => setOpt({ groupFields: v })} />}

                <Divider textAlign="left">Display</Divider>
                <Stack direction="row" spacing={1}>
                  <TextField select label="Unit" value={o.unit ?? 'none'} onChange={(e) => setOpt({ unit: e.target.value as PanelOptions['unit'] })} fullWidth>
                    {['none', 'short', 'percent', 'currency', 'bytes', 'ms', 's'].map((u) => (
                      <MenuItem key={u} value={u}>
                        {u}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField type="number" label="Decimals" value={o.decimals ?? ''} onChange={(e) => setOpt({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })} sx={{ width: 110 }} />
                </Stack>
                {['line', 'area', 'bar'].includes(panel.type) && (
                  <Stack>
                    <FormControlLabel control={<Switch checked={!!o.stacked} onChange={(e) => setOpt({ stacked: e.target.checked })} />} label="Stacked" />
                    {panel.type !== 'bar' && <FormControlLabel control={<Switch checked={!!o.smooth} onChange={(e) => setOpt({ smooth: e.target.checked })} />} label="Smooth lines" />}
                    {panel.type === 'bar' && <FormControlLabel control={<Switch checked={!!o.horizontal} onChange={(e) => setOpt({ horizontal: e.target.checked })} />} label="Horizontal" />}
                    <FormControlLabel control={<Switch checked={o.showLegend !== false} onChange={(e) => setOpt({ showLegend: e.target.checked })} />} label="Legend" />
                  </Stack>
                )}
                {HOLOGRAPH_TYPES.includes(panel.type) && (
                  <FormControlLabel
                    control={<Switch checked={!!o.render3d} disabled={!supportsWebGL2()} onChange={(e) => setOpt({ render3d: e.target.checked })} />}
                    label={supportsWebGL2() ? '3D view (WebGL)' : '3D view (WebGL2 not available)'}
                  />
                )}
                {panel.type === 'pie' && <FormControlLabel control={<Switch checked={!!o.donut} onChange={(e) => setOpt({ donut: e.target.checked })} />} label="Donut" />}
                {['kpi', 'gauge'].includes(panel.type) && (
                  <>
                    <TextField select label="Reduce rows with" value={o.reducer ?? 'last'} onChange={(e) => setOpt({ reducer: e.target.value as 'last' })}>
                      {['last', 'first', 'sum', 'avg', 'min', 'max'].map((r) => (
                        <MenuItem key={r} value={r}>
                          {r}
                        </MenuItem>
                      ))}
                    </TextField>
                    {panel.type === 'kpi' && <FormControlLabel control={<Switch checked={!!o.sparkline} onChange={(e) => setOpt({ sparkline: e.target.checked })} />} label="Sparkline" />}
                    {panel.type === 'gauge' && (
                      <Stack direction="row" spacing={1}>
                        <TextField type="number" label="Min" value={o.min ?? 0} onChange={(e) => setOpt({ min: Number(e.target.value) })} />
                        <TextField type="number" label="Max" value={o.max ?? 100} onChange={(e) => setOpt({ max: Number(e.target.value) })} />
                      </Stack>
                    )}
                    <Typography variant="subtitle2">Thresholds</Typography>
                    {(o.thresholds ?? []).map((t, i) => (
                      <Stack key={i} direction="row" spacing={1} alignItems="center">
                        <input
                          type="color"
                          value={t.color}
                          aria-label="Threshold color"
                          onChange={(e) => setOpt({ thresholds: o.thresholds!.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })}
                          style={{ width: 36, height: 32, border: 'none', background: 'none' }}
                        />
                        <TextField
                          type="number"
                          label="From value"
                          value={t.value}
                          onChange={(e) => setOpt({ thresholds: o.thresholds!.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)) })}
                          fullWidth
                        />
                        <IconButton onClick={() => setOpt({ thresholds: o.thresholds!.filter((_x, j) => j !== i) })} aria-label="Remove threshold">
                          <DeleteIcon />
                        </IconButton>
                      </Stack>
                    ))}
                    <Box>
                      <Button size="small" startIcon={<AddIcon />} onClick={() => setOpt({ thresholds: [...(o.thresholds ?? []), { value: 0, color: '#73BF69' }] })}>
                        Add threshold
                      </Button>
                    </Box>
                  </>
                )}
                {panel.type === 'table' && (
                  <TextField type="number" label="Page size" value={o.pageSize ?? 20} onChange={(e) => setOpt({ pageSize: Number(e.target.value) || 20 })} />
                )}

                <Divider textAlign="left">Drill-down</Divider>
                <Typography variant="caption" color="text.secondary">
                  Clicking a datum sets a dashboard variable to that row's field value, filtering every panel that uses it.
                </Typography>
                <FieldSelect
                  label="Field"
                  columns={columns}
                  value={panel.drilldown?.field}
                  onChange={(f?: string) => set({ drilldown: f ? { field: f, variable: panel.drilldown?.variable ?? variables[0]?.name ?? '' } : undefined })}
                />
                {panel.drilldown && (
                  <TextField select label="Sets variable" value={panel.drilldown.variable} onChange={(e) => set({ drilldown: { ...panel.drilldown!, variable: e.target.value } })}>
                    {variables.map((v) => (
                      <MenuItem key={v.name} value={v.name}>
                        {v.label ?? v.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <TextField
                  type="number"
                  label="Cache TTL (seconds)"
                  helperText="Blank = derived from dashboard refresh"
                  value={panel.cacheTtlSeconds ?? ''}
                  onChange={(e) => set({ cacheTtlSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
              </>
            )}
          </Stack>
        </Box>
      </Stack>
    </Dialog>
  );
}
