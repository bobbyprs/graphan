import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SaveIcon from '@mui/icons-material/Save';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import TitleIcon from '@mui/icons-material/Title';
import TableChartIcon from '@mui/icons-material/TableChartOutlined';
import GridOnIcon from '@mui/icons-material/GridOn';
import BarChartIcon from '@mui/icons-material/BarChart';
import LooksOneIcon from '@mui/icons-material/LooksOneOutlined';
import ImageIcon from '@mui/icons-material/ImageOutlined';
import InsertPageBreakIcon from '@mui/icons-material/InsertPageBreakOutlined';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import AccountTreeIcon from '@mui/icons-material/AccountTreeOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import { api, errorMessage } from '@/api/client';
import { useDataSources } from '@/api/hooks';
import {
  AGGREGATES,
  newId,
  useReport,
  useReportMutations,
  useReports,
  type Column,
  type Dataset,
  type Group,
  type ItemType,
  type ListChild,
  type ParamValues,
  type RenderedReport,
  type ReportDefinition,
  type ReportItem,
  type ReportParameter,
} from '@/api/reports';
import { SqlEditor } from '@/components/common/SqlEditor';
import { ParameterPane } from '@/components/reports/ParameterPane';
import { ReportView } from '@/components/reports/ReportView';

type DatasetInfo = Record<string, { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; rowCount: number }>;

const FORMATS = ['', 'N0', 'N2', 'C0', 'C2', 'P0', 'P1', 'F2', 'D', 'DT', 'T', 'dd-MMM-yyyy', 'MMM yyyy', 'yyyy-MM-dd HH:mm'];
const ITEM_META: Record<ItemType, { label: string; icon: ReactNode }> = {
  text: { label: 'Text box', icon: <TitleIcon fontSize="small" /> },
  list: { label: 'List (repeat per row)', icon: <AccountTreeIcon fontSize="small" /> },
  table: { label: 'Table (groups & subtotals)', icon: <TableChartIcon fontSize="small" /> },
  matrix: { label: 'Matrix (cross-tab)', icon: <GridOnIcon fontSize="small" /> },
  chart: { label: 'Chart', icon: <BarChartIcon fontSize="small" /> },
  kpi: { label: 'KPI cards', icon: <LooksOneIcon fontSize="small" /> },
  image: { label: 'Image / logo', icon: <ImageIcon fontSize="small" /> },
  subreport: { label: 'Subreport', icon: <AccountTreeIcon fontSize="small" /> },
  pageBreak: { label: 'Page break', icon: <InsertPageBreakIcon fontSize="small" /> },
  divider: { label: 'Line', icon: <HorizontalRuleIcon fontSize="small" /> },
};

function newItem(type: ItemType, def: ReportDefinition): ReportItem {
  const id = newId();
  const ds = def.datasets[0]?.name ?? '';
  switch (type) {
    case 'text': return { id, type, text: 'Text — use {{Parameters.name}} or {{Sum(dataset.field, C2)}}', style: {} };
    case 'list': return { id, type, dataset: ds, maxRows: 100, items: [{ id: newId(), type: 'text', text: '{{Fields.}}', style: {} }] };
    case 'table': return { id, type, dataset: ds, columns: [], groups: [], details: true, totals: true, repeatHeader: true, sort: [], zebra: true };
    case 'matrix': return { id, type, dataset: ds, rows: [], column: '', value: '', aggregate: 'sum', rowTotals: true, columnTotals: true, columnSort: 'asc', maxColumns: 50 };
    case 'chart': return { id, type, dataset: ds, chartType: 'column', category: '', series: [], height: 300, legend: true, labels: false };
    case 'kpi': return { id, type, cards: [{ label: 'Total', value: ds ? `{{Count(${ds})}}` : '0' }] };
    case 'image': return { id, type, src: '', width: 160, align: 'left' };
    case 'subreport': return { id, type, reportId: '', params: {} };
    default: return { id, type } as ReportItem;
  }
}

// ───────────── small form helpers ─────────────
const Row = ({ children }: { children: ReactNode }) => (
  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
    {children}
  </Stack>
);

function FieldPicker({ label, value, fields, onChange, width = 180 }: { label: string; value: string; fields: string[]; onChange: (v: string) => void; width?: number }) {
  return <Autocomplete freeSolo size="small" options={fields} value={value} onInputChange={(_e, v) => onChange(v)} sx={{ width }} renderInput={(p) => <TextField {...p} label={label} />} />;
}

function FormatPicker({ value, onChange, width = 140 }: { value?: string; onChange: (v?: string) => void; width?: number }) {
  return (
    <Autocomplete
      freeSolo
      size="small"
      options={FORMATS}
      value={value ?? ''}
      onInputChange={(_e, v) => onChange(v || undefined)}
      sx={{ width }}
      renderInput={(p) => <TextField {...p} label="Format" helperText={undefined} />}
    />
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <FormControlLabel sx={{ mr: 1 }} control={<Checkbox size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} />} label={<Typography variant="body2">{label}</Typography>} />;
}

// ───────────── Editors ─────────────
function DatasetEditor({ ds, onChange, onRemove }: { ds: Dataset; onChange: (d: Dataset) => void; onRemove: () => void }) {
  const { data: dataSources = [] } = useDataSources();
  return (
    <Stack spacing={1.25}>
      <Row>
        <TextField size="small" label="Name" value={ds.name} onChange={(e) => onChange({ ...ds, name: e.target.value.replace(/[^\w]/g, '_') })} sx={{ width: 160 }} />
        <TextField select size="small" label="Data source" value={ds.dataSourceId} onChange={(e) => onChange({ ...ds, dataSourceId: e.target.value })} sx={{ flex: 1, minWidth: 180 }}>
          {dataSources.map((d) => (
            <MenuItem key={d.id} value={d.id}>
              {d.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" type="number" label="Max rows" value={ds.maxRows ?? ''} onChange={(e) => onChange({ ...ds, maxRows: e.target.value ? Number(e.target.value) : undefined })} sx={{ width: 110 }} />
        <Tooltip title="Delete dataset">
          <IconButton onClick={onRemove}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Row>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
        <SqlEditor value={ds.query} onChange={(v) => onChange({ ...ds, query: v })} height={200} path={`rpt-ds-${ds.name}.sql`} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        Use parameters as <code>{'${name}'}</code> (bound safely; multi-value → <code>IN {'${name}'}</code>).
      </Typography>
      <Typography variant="subtitle2">Calculated fields</Typography>
      {ds.calculated.map((c, i) => (
        <Row key={i}>
          <TextField size="small" label="Name" value={c.name} onChange={(e) => onChange({ ...ds, calculated: ds.calculated.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^\w]/g, '_') } : x)) })} sx={{ width: 140 }} />
          <TextField size="small" label="Expression (e.g. revenue - cost)" value={c.expression} onChange={(e) => onChange({ ...ds, calculated: ds.calculated.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)) })} sx={{ flex: 1 }} />
          <IconButton size="small" onClick={() => onChange({ ...ds, calculated: ds.calculated.filter((_x, j) => j !== i) })}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Row>
      ))}
      <Button size="small" startIcon={<AddIcon />} onClick={() => onChange({ ...ds, calculated: [...ds.calculated, { name: `calc_${ds.calculated.length + 1}`, expression: '' }] })} sx={{ alignSelf: 'flex-start' }}>
        Calculated field
      </Button>
    </Stack>
  );
}

function ParameterEditor({ p, onChange, onRemove }: { p: ReportParameter; onChange: (p: ReportParameter) => void; onRemove: () => void }) {
  const { data: dataSources = [] } = useDataSources();
  const defText = p.default === undefined || p.default === null ? '' : Array.isArray(p.default) ? p.default.join(', ') : String(p.default);
  return (
    <Stack spacing={1.25}>
      <Row>
        <TextField size="small" label="Name" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value.replace(/[^\w]/g, '_') })} sx={{ width: 140 }} />
        <TextField size="small" label="Prompt" value={p.label ?? ''} onChange={(e) => onChange({ ...p, label: e.target.value })} sx={{ flex: 1, minWidth: 140 }} />
        <TextField select size="small" label="Type" value={p.type} onChange={(e) => onChange({ ...p, type: e.target.value as ReportParameter['type'] })} sx={{ width: 120 }}>
          {['string', 'integer', 'float', 'date', 'datetime', 'boolean'].map((t) => (
            <MenuItem key={t} value={t}>
              {t}
            </MenuItem>
          ))}
        </TextField>
        <IconButton onClick={onRemove}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Row>
      <Row>
        <Check label="Multi-value" checked={p.multi} onChange={(v) => onChange({ ...p, multi: v })} />
        <Check label="Required" checked={p.required} onChange={(v) => onChange({ ...p, required: v })} />
        <Check label="Hidden" checked={p.hidden} onChange={(v) => onChange({ ...p, hidden: v })} />
        <TextField
          size="small"
          label="Default"
          value={defText}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({ ...p, default: raw === '' ? null : p.multi ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw });
          }}
          helperText={p.type.startsWith('date') ? 'today, today-7d, startOfMonth, startOfYear, endOfMonth or yyyy-MM-dd' : p.multi ? 'comma-separated' : undefined}
          sx={{ flex: 1, minWidth: 160 }}
        />
      </Row>
      <TextField select size="small" label="Available values" value={p.options.kind} onChange={(e) => onChange({ ...p, options: e.target.value === 'static' ? { kind: 'static', values: [] } : e.target.value === 'query' ? { kind: 'query', dataSourceId: dataSources[0]?.id ?? '', query: 'SELECT value, label FROM ...', defaultFirst: false } : { kind: 'none' } })}>
        <MenuItem value="none">None (free entry)</MenuItem>
        <MenuItem value="static">Specify values</MenuItem>
        <MenuItem value="query">Get values from a query (can use earlier parameters → cascading)</MenuItem>
      </TextField>
      {p.options.kind === 'static' && (
        <TextField
          size="small"
          multiline
          minRows={3}
          label="One per line: value or value|label"
          value={p.options.values.map((v) => (v.label && v.label !== String(v.value) ? `${v.value}|${v.label}` : String(v.value))).join('\n')}
          onChange={(e) =>
            onChange({
              ...p,
              options: {
                kind: 'static',
                values: e.target.value
                  .split('\n')
                  .filter((l) => l.trim())
                  .map((l) => {
                    const [v, ...rest] = l.split('|');
                    return { value: v.trim(), label: rest.join('|').trim() || undefined };
                  }),
              },
            })
          }
        />
      )}
      {p.options.kind === 'query' &&
        (() => {
          const o = p.options;
          return (
            <Stack spacing={1}>
              <TextField select size="small" label="Data source" value={o.dataSourceId} onChange={(e) => onChange({ ...p, options: { ...o, dataSourceId: e.target.value } })}>
                {dataSources.map((d) => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.name}
                  </MenuItem>
                ))}
              </TextField>
              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                <SqlEditor value={o.query} onChange={(v) => onChange({ ...p, options: { ...o, query: v } })} height={90} path={`rpt-param-${p.name}.sql`} />
              </Box>
              <Row>
                <TextField size="small" label="Value field" value={o.valueField ?? ''} onChange={(e) => onChange({ ...p, options: { ...o, valueField: e.target.value || undefined } })} placeholder="1st column" sx={{ width: 140 }} />
                <TextField size="small" label="Label field" value={o.labelField ?? ''} onChange={(e) => onChange({ ...p, options: { ...o, labelField: e.target.value || undefined } })} placeholder="2nd column" sx={{ width: 140 }} />
                <Check label={p.multi ? 'Default: select all' : 'Default: first value'} checked={!!o.defaultFirst} onChange={(v) => onChange({ ...p, options: { ...o, defaultFirst: v } })} />
              </Row>
            </Stack>
          );
        })()}
    </Stack>
  );
}

function ColumnEditor({ c, fields, reports, onChange, onRemove, onMove }: { c: Column; fields: string[]; reports: { id: string; title: string }[]; onChange: (c: Column) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const [more, setMore] = useState(false);
  const rule = c.rules[0];
  return (
    <Paper variant="outlined" sx={{ p: 1 }}>
      <Row>
        <FieldPicker label="Field" value={c.field} fields={fields} onChange={(v) => onChange({ ...c, field: v })} width={150} />
        <TextField size="small" label="Header" value={c.header ?? ''} onChange={(e) => onChange({ ...c, header: e.target.value || undefined })} sx={{ width: 140 }} />
        <FormatPicker value={c.format} onChange={(v) => onChange({ ...c, format: v })} width={120} />
        <TextField select size="small" label="Total" value={c.aggregate ?? 'none'} onChange={(e) => onChange({ ...c, aggregate: e.target.value as Column['aggregate'] })} sx={{ width: 110 }}>
          {['none', ...AGGREGATES].map((a) => (
            <MenuItem key={a} value={a}>
              {a}
            </MenuItem>
          ))}
        </TextField>
        <IconButton size="small" onClick={() => onMove(-1)}>
          <ArrowUpwardIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={() => onMove(1)}>
          <ArrowDownwardIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={onRemove}>
          <DeleteIcon fontSize="small" />
        </IconButton>
        <Button size="small" onClick={() => setMore((m) => !m)}>
          {more ? 'Less' : 'More'}
        </Button>
      </Row>
      {more && (
        <Stack spacing={1} sx={{ mt: 1 }}>
          <Row>
            <TextField select size="small" label="Align" value={c.align ?? ''} onChange={(e) => onChange({ ...c, align: (e.target.value || undefined) as Column['align'] })} sx={{ width: 110 }}>
              <MenuItem value="">auto</MenuItem>
              <MenuItem value="left">left</MenuItem>
              <MenuItem value="center">center</MenuItem>
              <MenuItem value="right">right</MenuItem>
            </TextField>
            <TextField size="small" type="number" label="Width (relative)" value={c.width ?? 1} onChange={(e) => onChange({ ...c, width: Number(e.target.value) || 1 })} sx={{ width: 130 }} inputProps={{ step: 0.1, min: 0.2 }} />
            <Check label="Hide repeated values" checked={!!c.hideDuplicates} onChange={(v) => onChange({ ...c, hideDuplicates: v })} />
          </Row>
          <Typography variant="caption" color="text.secondary">
            Conditional format (first rule)
          </Typography>
          <Row>
            <TextField select size="small" label="When value" value={rule?.op ?? ''} onChange={(e) => onChange({ ...c, rules: e.target.value ? [{ ...(rule ?? {}), op: e.target.value as 'contains' }] : [] })} sx={{ width: 120 }}>
              <MenuItem value="">(no rule)</MenuItem>
              {['<', '<=', '>', '>=', '=', '!=', 'contains', 'empty', 'notEmpty'].map((o) => (
                <MenuItem key={o} value={o}>
                  {o}
                </MenuItem>
              ))}
            </TextField>
            {rule && (
              <>
                <TextField size="small" label="Value" value={rule.value ?? ''} onChange={(e) => onChange({ ...c, rules: [{ ...rule, value: e.target.value }] })} sx={{ width: 110 }} />
                <TextField size="small" type="color" label="Text" value={rule.color ?? '#B91C1C'} onChange={(e) => onChange({ ...c, rules: [{ ...rule, color: e.target.value }] })} sx={{ width: 80 }} />
                <TextField size="small" type="color" label="Fill" value={rule.background ?? '#ffffff'} onChange={(e) => onChange({ ...c, rules: [{ ...rule, background: e.target.value === '#ffffff' ? undefined : e.target.value }] })} sx={{ width: 80 }} />
                <Check label="Bold" checked={!!rule.bold} onChange={(v) => onChange({ ...c, rules: [{ ...rule, bold: v }] })} />
              </>
            )}
          </Row>
          <Typography variant="caption" color="text.secondary">
            Drill-through (click opens another report)
          </Typography>
          <Row>
            <TextField select size="small" label="Target report" value={c.drillthrough?.reportId ?? ''} onChange={(e) => onChange({ ...c, drillthrough: e.target.value ? { reportId: e.target.value, params: c.drillthrough?.params ?? {} } : undefined })} sx={{ minWidth: 220 }}>
              <MenuItem value="">(none)</MenuItem>
              {reports.map((r) => (
                <MenuItem key={r.id} value={r.id}>
                  {r.title}
                </MenuItem>
              ))}
            </TextField>
            {c.drillthrough && (
              <TextField
                size="small"
                label="Parameters (param=field, @param, =literal)"
                value={Object.entries(c.drillthrough.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ')}
                onChange={(e) =>
                  onChange({
                    ...c,
                    drillthrough: {
                      reportId: c.drillthrough!.reportId,
                      params: Object.fromEntries(
                        e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter((x) => x.includes('='))
                          .map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]),
                      ),
                    },
                  })
                }
                sx={{ flex: 1, minWidth: 260 }}
              />
            )}
          </Row>
        </Stack>
      )}
    </Paper>
  );
}

function ItemEditor({ it, def, fieldsOf, reports, onChange }: { it: ReportItem; def: ReportDefinition; fieldsOf: (ds: string) => string[]; reports: { id: string; title: string }[]; onChange: (it: ReportItem) => void }) {
  const datasetSelect = (value: string, set: (v: string) => void) => (
    <TextField select size="small" label="Dataset" value={value} onChange={(e) => set(e.target.value)} sx={{ minWidth: 160 }}>
      {def.datasets.map((d) => (
        <MenuItem key={d.name} value={d.name}>
          {d.name}
        </MenuItem>
      ))}
    </TextField>
  );
  const titleField = it.type !== 'text' && it.type !== 'pageBreak' && it.type !== 'divider' && <TextField size="small" label="Title (optional, expressions allowed)" value={it.title ?? ''} onChange={(e) => onChange({ ...it, title: e.target.value || undefined })} fullWidth />;
  const bookmarkField = <TextField size="small" label="Bookmark (document map label; optional)" value={it.bookmark ?? ''} onChange={(e) => onChange({ ...it, bookmark: e.target.value || undefined })} fullWidth />;

  switch (it.type) {
    case 'text':
      return (
        <Stack spacing={1.25}>
          <TextField multiline minRows={3} size="small" label="Text" value={it.text} onChange={(e) => onChange({ ...it, text: e.target.value })} />
          <Row>
            {['{{Globals.ReportName}}', '{{Globals.ExecutionTime}}', '{{User.Name}}', ...def.parameters.map((p) => `{{Parameters.${p.name}}}`), ...def.datasets.map((d) => `{{Count(${d.name})}}`)].map((t) => (
              <Chip key={t} size="small" label={t} onClick={() => onChange({ ...it, text: `${it.text}${it.text ? ' ' : ''}${t}` })} />
            ))}
          </Row>
          <Row>
            <TextField size="small" type="number" label="Font size" value={it.style.fontSize ?? ''} onChange={(e) => onChange({ ...it, style: { ...it.style, fontSize: e.target.value ? Number(e.target.value) : undefined } })} sx={{ width: 100 }} />
            <Check label="Bold" checked={!!it.style.bold} onChange={(v) => onChange({ ...it, style: { ...it.style, bold: v } })} />
            <Check label="Italic" checked={!!it.style.italic} onChange={(v) => onChange({ ...it, style: { ...it.style, italic: v } })} />
            <TextField size="small" type="color" label="Color" value={it.style.color ?? '#111827'} onChange={(e) => onChange({ ...it, style: { ...it.style, color: e.target.value } })} sx={{ width: 80 }} />
            <TextField select size="small" label="Align" value={it.style.align ?? 'left'} onChange={(e) => onChange({ ...it, style: { ...it.style, align: e.target.value as 'left' } })} sx={{ width: 100 }}>
              <MenuItem value="left">left</MenuItem>
              <MenuItem value="center">center</MenuItem>
              <MenuItem value="right">right</MenuItem>
            </TextField>
          </Row>
        </Stack>
      );
    case 'list': {
      const fields = fieldsOf(it.dataset);
      const setItems = (items: ListChild[]) => onChange({ ...it, items });
      const patchChild = (i: number, patch: Record<string, unknown>) => setItems(it.items.map((c, j) => (j === i ? ({ ...c, ...patch } as ListChild) : c)));
      return (
        <Stack spacing={1.25}>
          {titleField}
          {bookmarkField}
          <Row>
            {datasetSelect(it.dataset, (v) => onChange({ ...it, dataset: v }))}
            <TextField size="small" type="number" label="Max rows" value={it.maxRows} onChange={(e) => onChange({ ...it, maxRows: Number(e.target.value) || 100 })} sx={{ width: 110 }} />
          </Row>
          <Typography variant="caption" color="text.secondary">
            The elements below repeat once per row. Use {'{{Fields.column}}'} in text to show that row&apos;s values.
          </Typography>
          {fields.length > 0 && (
            <Row>
              {fields.map((f) => (
                <Chip key={f} size="small" label={`{{Fields.${f}}}`} />
              ))}
            </Row>
          )}
          {it.items.map((c, i) => (
            <Box key={c.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
              <Row>
                <TextField
                  select
                  size="small"
                  label="Element"
                  value={c.type}
                  onChange={(e) => {
                    const t = e.target.value as ListChild['type'];
                    const next = (t === 'text' ? { id: c.id, type: 'text', text: '{{Fields.}}', style: {} } : t === 'image' ? { id: c.id, type: 'image', src: '', width: 160, align: 'left' } : { id: c.id, type: 'divider' }) as ListChild;
                    setItems(it.items.map((x, j) => (j === i ? next : x)));
                  }}
                  sx={{ width: 120 }}
                >
                  <MenuItem value="text">Text</MenuItem>
                  <MenuItem value="image">Image</MenuItem>
                  <MenuItem value="divider">Line</MenuItem>
                </TextField>
                <IconButton size="small" aria-label="Remove element" onClick={() => setItems(it.items.filter((_x, j) => j !== i))}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Row>
              {c.type === 'text' && <TextField size="small" fullWidth multiline minRows={1} label="Text" value={c.text} onChange={(e) => patchChild(i, { text: e.target.value })} sx={{ mt: 1 }} />}
              {c.type === 'image' && <TextField size="small" fullWidth label="Image data URI" value={c.src} onChange={(e) => patchChild(i, { src: e.target.value })} sx={{ mt: 1 }} />}
            </Box>
          ))}
          <Box>
            <Button size="small" startIcon={<AddIcon />} onClick={() => setItems([...it.items, { id: newId(), type: 'text', text: '{{Fields.}}', style: {} }])}>
              Add element
            </Button>
          </Box>
        </Stack>
      );
    }
    case 'table': {
      const fields = fieldsOf(it.dataset);
      const setCols = (columns: Column[]) => onChange({ ...it, columns });
      const setGroups = (groups: Group[]) => onChange({ ...it, groups });
      return (
        <Stack spacing={1.25}>
          {titleField}
          {bookmarkField}
          <Row>
            {datasetSelect(it.dataset, (v) => onChange({ ...it, dataset: v }))}
            <Button size="small" disabled={!fields.length} onClick={() => setCols(fields.map((f) => ({ field: f, rules: [] })))}>
              Add all fields
            </Button>
          </Row>
          <Typography variant="subtitle2">Row groups (outer → inner)</Typography>
          {it.groups.map((g, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 1 }}>
              <Row>
                <FieldPicker label="Group by" value={g.field} fields={fields} onChange={(v) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, field: v } : x)))} width={150} />
                <TextField size="small" label="Header label ({{value}})" value={g.label ?? ''} onChange={(e) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))} sx={{ width: 170 }} />
                <TextField select size="small" label="Sort" value={g.sort} onChange={(e) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, sort: e.target.value as Group['sort'] } : x)))} sx={{ width: 110 }}>
                  <MenuItem value="none">query order</MenuItem>
                  <MenuItem value="asc">A → Z</MenuItem>
                  <MenuItem value="desc">Z → A</MenuItem>
                </TextField>
                <IconButton size="small" onClick={() => setGroups(it.groups.filter((_x, j) => j !== i))}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Row>
              <Row>
                <Check label="Header row" checked={g.header} onChange={(v) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, header: v } : x)))} />
                <Check label="Subtotal row" checked={g.subtotal} onChange={(v) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, subtotal: v } : x)))} />
                <Check label="Page break between" checked={g.pageBreak} onChange={(v) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, pageBreak: v } : x)))} />
                <Check label="Start collapsed" checked={g.collapsed} onChange={(v) => setGroups(it.groups.map((x, j) => (j === i ? { ...x, collapsed: v } : x)))} />
              </Row>
            </Paper>
          ))}
          <Button size="small" startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }} onClick={() => setGroups([...it.groups, { field: '', sort: 'none', header: true, subtotal: true, pageBreak: false, collapsed: false }])}>
            Add group
          </Button>
          <Typography variant="subtitle2">Columns</Typography>
          {it.columns.map((c, i) => (
            <ColumnEditor
              key={i}
              c={c}
              fields={fields}
              reports={reports}
              onChange={(nc) => setCols(it.columns.map((x, j) => (j === i ? nc : x)))}
              onRemove={() => setCols(it.columns.filter((_x, j) => j !== i))}
              onMove={(d) => {
                const j = i + d;
                if (j < 0 || j >= it.columns.length) return;
                const next = [...it.columns];
                [next[i], next[j]] = [next[j], next[i]];
                setCols(next);
              }}
            />
          ))}
          <Button size="small" startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }} onClick={() => setCols([...it.columns, { field: '', rules: [] }])}>
            Add column
          </Button>
          <Row>
            <Check label="Detail rows" checked={it.details} onChange={(v) => onChange({ ...it, details: v })} />
            <Check label="Grand total" checked={it.totals} onChange={(v) => onChange({ ...it, totals: v })} />
            <Check label="Repeat header on each page" checked={it.repeatHeader} onChange={(v) => onChange({ ...it, repeatHeader: v })} />
            <Check label="Zebra rows" checked={it.zebra} onChange={(v) => onChange({ ...it, zebra: v })} />
          </Row>
          <Row>
            <TextField size="small" label="Filter (e.g. revenue > 1000)" value={it.filter ?? ''} onChange={(e) => onChange({ ...it, filter: e.target.value || undefined })} sx={{ flex: 1, minWidth: 200 }} />
            <TextField size="small" label="Sort (field asc, field desc)" value={it.sort.map((s) => `${s.field} ${s.dir}`).join(', ')} onChange={(e) => onChange({ ...it, sort: e.target.value.split(',').map((x) => x.trim().split(/\s+/)).filter((x) => x[0]).map(([f, d]) => ({ field: f, dir: d === 'desc' ? 'desc' : 'asc' })) })} sx={{ flex: 1, minWidth: 200 }} />
          </Row>
          <TextField size="small" label="No-rows message" value={it.noRowsMessage ?? ''} onChange={(e) => onChange({ ...it, noRowsMessage: e.target.value || undefined })} />
        </Stack>
      );
    }
    case 'matrix': {
      const fields = fieldsOf(it.dataset);
      return (
        <Stack spacing={1.25}>
          {titleField}
          {bookmarkField}
          <Row>
            {datasetSelect(it.dataset, (v) => onChange({ ...it, dataset: v }))}
            <Autocomplete multiple freeSolo size="small" options={fields} value={it.rows} onChange={(_e, v) => onChange({ ...it, rows: v })} sx={{ minWidth: 220, flex: 1 }} renderInput={(p) => <TextField {...p} label="Row groups" />} />
          </Row>
          <Row>
            <FieldPicker label="Column group" value={it.column} fields={fields} onChange={(v) => onChange({ ...it, column: v })} />
            <FieldPicker label="Value" value={it.value} fields={fields} onChange={(v) => onChange({ ...it, value: v })} />
            <TextField select size="small" label="Aggregate" value={it.aggregate} onChange={(e) => onChange({ ...it, aggregate: e.target.value as 'sum' })} sx={{ width: 130 }}>
              {AGGREGATES.map((a) => (
                <MenuItem key={a} value={a}>
                  {a}
                </MenuItem>
              ))}
            </TextField>
            <FormatPicker value={it.format} onChange={(v) => onChange({ ...it, format: v })} />
          </Row>
          <Row>
            <Check label="Row totals" checked={it.rowTotals} onChange={(v) => onChange({ ...it, rowTotals: v })} />
            <Check label="Column totals" checked={it.columnTotals} onChange={(v) => onChange({ ...it, columnTotals: v })} />
            <TextField select size="small" label="Column order" value={it.columnSort} onChange={(e) => onChange({ ...it, columnSort: e.target.value as 'asc' })} sx={{ width: 130 }}>
              <MenuItem value="none">query order</MenuItem>
              <MenuItem value="asc">A → Z</MenuItem>
              <MenuItem value="desc">Z → A</MenuItem>
            </TextField>
            <TextField size="small" type="number" label="Max columns" value={it.maxColumns} onChange={(e) => onChange({ ...it, maxColumns: Number(e.target.value) || 50 })} sx={{ width: 120 }} />
          </Row>
        </Stack>
      );
    }
    case 'chart': {
      const fields = fieldsOf(it.dataset);
      return (
        <Stack spacing={1.25}>
          {titleField}
          {bookmarkField}
          <Row>
            {datasetSelect(it.dataset, (v) => onChange({ ...it, dataset: v }))}
            <TextField select size="small" label="Chart type" value={it.chartType} onChange={(e) => onChange({ ...it, chartType: e.target.value as 'bar' })} sx={{ width: 140 }}>
              {['column', 'bar', 'stacked', 'line', 'area', 'pie', 'donut'].map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" type="number" label="Height" value={it.height} onChange={(e) => onChange({ ...it, height: Number(e.target.value) || 300 })} sx={{ width: 100 }} />
          </Row>
          <Row>
            <FieldPicker label="Category (x)" value={it.category} fields={fields} onChange={(v) => onChange({ ...it, category: v })} />
            <Autocomplete multiple freeSolo size="small" options={fields} value={it.series} onChange={(_e, v) => onChange({ ...it, series: v })} sx={{ minWidth: 200, flex: 1 }} renderInput={(p) => <TextField {...p} label="Values (series)" />} />
          </Row>
          <Row>
            <FieldPicker label="Split series by (optional)" value={it.seriesField ?? ''} fields={fields} onChange={(v) => onChange({ ...it, seriesField: v || undefined })} width={200} />
            <FormatPicker value={it.format} onChange={(v) => onChange({ ...it, format: v })} />
            <Check label="Legend" checked={it.legend} onChange={(v) => onChange({ ...it, legend: v })} />
            <Check label="Data labels" checked={it.labels} onChange={(v) => onChange({ ...it, labels: v })} />
          </Row>
        </Stack>
      );
    }
    case 'kpi':
      return (
        <Stack spacing={1}>
          {titleField}
          {bookmarkField}
          {it.cards.map((c, i) => (
            <Row key={i}>
              <TextField size="small" label="Label" value={c.label} onChange={(e) => onChange({ ...it, cards: it.cards.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} sx={{ width: 130 }} />
              <TextField size="small" label="Value expression" value={c.value} onChange={(e) => onChange({ ...it, cards: it.cards.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} sx={{ flex: 1, minWidth: 200 }} placeholder="{{Sum(ds.amount, C0)}}" />
              <TextField size="small" type="color" label="Color" value={c.color ?? '#111827'} onChange={(e) => onChange({ ...it, cards: it.cards.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })} sx={{ width: 70 }} />
              <IconButton size="small" onClick={() => onChange({ ...it, cards: it.cards.filter((_x, j) => j !== i) })} disabled={it.cards.length === 1}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Row>
          ))}
          <Button size="small" startIcon={<AddIcon />} sx={{ alignSelf: 'flex-start' }} disabled={it.cards.length >= 8} onClick={() => onChange({ ...it, cards: [...it.cards, { label: 'Label', value: '' }] })}>
            Add card
          </Button>
          <Typography variant="caption" color="text.secondary">
            Functions: Sum, Avg, Min, Max, Count, CountDistinct, First, Last — e.g. <code>{'{{Avg(sales.revenue, C2)}}'}</code>
          </Typography>
        </Stack>
      );
    case 'image':
      return (
        <Stack spacing={1.25}>
          <Row>
            <Button component="label" variant="outlined" size="small">
              Upload image (PNG/JPG/SVG, max 500 KB)
              <input
                hidden
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f || f.size > 500_000) return;
                  const r = new FileReader();
                  r.onload = () => onChange({ ...it, src: String(r.result) });
                  r.readAsDataURL(f);
                }}
              />
            </Button>
            <TextField size="small" type="number" label="Width (px)" value={it.width} onChange={(e) => onChange({ ...it, width: Number(e.target.value) || 160 })} sx={{ width: 110 }} />
            <TextField select size="small" label="Align" value={it.align ?? 'left'} onChange={(e) => onChange({ ...it, align: e.target.value as 'left' })} sx={{ width: 110 }}>
              <MenuItem value="left">left</MenuItem>
              <MenuItem value="center">center</MenuItem>
              <MenuItem value="right">right</MenuItem>
            </TextField>
          </Row>
          {it.src && <img src={it.src} alt="" style={{ maxWidth: 200, maxHeight: 100, objectFit: 'contain' }} />}
        </Stack>
      );
    case 'subreport':
      return (
        <Stack spacing={1.25}>
          {titleField}
          {bookmarkField}
          <TextField select size="small" label="Report" value={it.reportId} onChange={(e) => onChange({ ...it, reportId: e.target.value })}>
            {reports.map((r) => (
              <MenuItem key={r.id} value={r.id}>
                {r.title}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Parameters (param={{Parameters.x}}, param==literal)"
            value={Object.entries(it.params)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}
            onChange={(e) =>
              onChange({
                ...it,
                params: Object.fromEntries(
                  e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter((x) => x.includes('='))
                    .map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]),
                ),
              })
            }
          />
        </Stack>
      );
    default:
      return <Typography variant="body2" color="text.secondary">No settings.</Typography>;
  }
}

// ───────────── Page ─────────────
export function ReportDesignerPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: report, error } = useReport(id);
  const { data: allReports = [] } = useReports();
  const m = useReportMutations();
  const [def, setDef] = useState<ReportDefinition | null>(null);
  const [meta, setMeta] = useState({ title: '', description: '', folder: '/', cacheMinutes: 0, snapshotRetention: 30 });
  const [version, setVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<{ kind: 'dataset' | 'param' | 'item'; index: number } | null>(null);
  const [addEl, setAddEl] = useState<HTMLElement | null>(null);
  const [preview, setPreview] = useState<RenderedReport | null>(null);
  const [dsInfo, setDsInfo] = useState<DatasetInfo>({});
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [values, setValues] = useState<ParamValues>({});
  const [json, setJson] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!report || def) return;
    setDef(report.definition);
    setMeta({ title: report.title, description: report.description ?? '', folder: report.folder, cacheMinutes: report.cacheMinutes, snapshotRetention: report.snapshotRetention });
    setVersion(report.version);
  }, [report, def]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const update = (fn: (d: ReportDefinition) => ReportDefinition) => {
    setDef((d) => (d ? fn(d) : d));
    setDirty(true);
  };
  const fieldsOf = useMemo(
    () => (ds: string) => {
      const info = dsInfo[ds];
      const calc = def?.datasets.find((d) => d.name === ds)?.calculated.map((c) => c.name) ?? [];
      return [...new Set([...(info?.columns.map((c) => c.name) ?? []), ...calc])];
    },
    [dsInfo, def],
  );

  const runPreview = async (vals = values) => {
    if (!def) return;
    setPreviewing(true);
    setPreviewErr(null);
    try {
      const { data: dv } = await api.post<{ values: ParamValues }>(`/reports/${id}/parameters`, { parameters: vals, definition: def });
      setValues(dv.values);
      const { data } = await api.post<{ model: RenderedReport; datasets: DatasetInfo }>(`/reports/${id}/preview`, { definition: def, parameters: dv.values });
      setPreview(data.model);
      setDsInfo(data.datasets);
    } catch (e) {
      setPreviewErr(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    if (!def) return;
    try {
      const r = await m.update.mutateAsync({ id, version, ...meta, description: meta.description || null, definition: def });
      setVersion(r.version);
      setDirty(false);
      setToast({ ok: true, msg: `Saved (version ${r.version})` });
    } catch (e) {
      setToast({ ok: false, msg: errorMessage(e) });
    }
  };

  useEffect(() => {
    if (tab === 3 && def) {
      setJson(JSON.stringify(def, null, 2));
      setJsonErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (error) return <Alert severity="error">{errorMessage(error)}</Alert>;
  if (!report || !def) return <LinearProgress />;
  if (!report.canEdit) return <Alert severity="warning">You can view this report but not edit it.</Alert>;

  const otherReports = allReports.filter((r) => r.id !== id).map((r) => ({ id: r.id, title: r.title }));
  const move = (i: number, d: -1 | 1) =>
    update((x) => {
      const j = i + d;
      if (j < 0 || j >= x.body.length) return x;
      const body = [...x.body];
      [body[i], body[j]] = [body[j], body[i]];
      setSel({ kind: 'item', index: j });
      return { ...x, body };
    });

  const selected = sel?.kind === 'item' ? def.body[sel.index] : undefined;

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <IconButton onClick={() => navigate(`/reports/${id}`)}>
          <ArrowBackIcon />
        </IconButton>
        <TextField size="small" label="Report title" value={meta.title} onChange={(e) => (setMeta({ ...meta, title: e.target.value }), setDirty(true))} sx={{ minWidth: 260, flex: 1 }} />
        <TextField size="small" label="Folder" value={meta.folder} onChange={(e) => (setMeta({ ...meta, folder: e.target.value }), setDirty(true))} sx={{ width: 180 }} />
        {dirty && <Chip size="small" color="warning" label="Unsaved" />}
        <Button startIcon={previewing ? <CircularProgress size={16} /> : <PlayArrowIcon />} onClick={() => runPreview()} disabled={previewing}>
          Preview
        </Button>
        <Button startIcon={<VisibilityIcon />} onClick={() => navigate(`/reports/${id}`)} disabled={dirty}>
          View
        </Button>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={m.update.isPending || !dirty}>
          Save
        </Button>
      </Stack>

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems="flex-start">
        {/* Left: definition */}
        <Paper variant="outlined" sx={{ width: { xs: '100%', lg: 560 }, flexShrink: 0, maxHeight: { lg: 'calc(100vh - 170px)' }, overflow: 'auto' }}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" sx={{ borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 2 }}>
            <Tab label="Data" />
            <Tab label="Layout" />
            <Tab label="Page & settings" />
            <Tab label="JSON" />
          </Tabs>
          <Box sx={{ p: 1.5 }}>
            {tab === 0 && (
              <Stack spacing={2}>
                <Box>
                  <Stack direction="row" alignItems="center">
                    <Typography variant="subtitle1" sx={{ flex: 1 }}>
                      Datasets
                    </Typography>
                    <Button size="small" startIcon={<AddIcon />} onClick={() => (update((d) => ({ ...d, datasets: [...d.datasets, { name: `dataset${d.datasets.length + 1}`, dataSourceId: '', query: 'SELECT 1 AS value', calculated: [] }] })), setSel({ kind: 'dataset', index: def.datasets.length }))}>
                      Dataset
                    </Button>
                  </Stack>
                  <List dense>
                    {def.datasets.map((d, i) => (
                      <ListItemButton key={i} selected={sel?.kind === 'dataset' && sel.index === i} onClick={() => setSel({ kind: 'dataset', index: i })}>
                        <ListItemText primary={d.name} secondary={dsInfo[d.name] ? `${dsInfo[d.name].rowCount} rows · ${dsInfo[d.name].columns.map((c) => c.name).join(', ')}` : 'Preview to see fields'} secondaryTypographyProps={{ noWrap: true }} />
                      </ListItemButton>
                    ))}
                  </List>
                  {sel?.kind === 'dataset' && def.datasets[sel.index] && (
                    <DatasetEditor
                      ds={def.datasets[sel.index]}
                      onChange={(nd) => update((d) => ({ ...d, datasets: d.datasets.map((x, j) => (j === sel.index ? nd : x)) }))}
                      onRemove={() => (update((d) => ({ ...d, datasets: d.datasets.filter((_x, j) => j !== sel.index) })), setSel(null))}
                    />
                  )}
                </Box>
                <Divider />
                <Box>
                  <Stack direction="row" alignItems="center">
                    <Typography variant="subtitle1" sx={{ flex: 1 }}>
                      Parameters
                    </Typography>
                    <Button size="small" startIcon={<AddIcon />} onClick={() => (update((d) => ({ ...d, parameters: [...d.parameters, { name: `param${d.parameters.length + 1}`, type: 'string', multi: false, required: true, hidden: false, options: { kind: 'none' } }] })), setSel({ kind: 'param', index: def.parameters.length }))}>
                      Parameter
                    </Button>
                  </Stack>
                  <List dense>
                    {def.parameters.map((p, i) => (
                      <ListItemButton key={i} selected={sel?.kind === 'param' && sel.index === i} onClick={() => setSel({ kind: 'param', index: i })}>
                        <ListItemText primary={`${p.label || p.name}  (\${${p.name}})`} secondary={`${p.type}${p.multi ? ', multi' : ''}${p.options.kind !== 'none' ? `, ${p.options.kind} values` : ''}${p.hidden ? ', hidden' : ''}`} />
                        <IconButton size="small" disabled={i === 0} onClick={(e) => (e.stopPropagation(), update((d) => { const ps = [...d.parameters]; [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]]; return { ...d, parameters: ps }; }))}>
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                      </ListItemButton>
                    ))}
                  </List>
                  {sel?.kind === 'param' && def.parameters[sel.index] && (
                    <ParameterEditor
                      p={def.parameters[sel.index]}
                      onChange={(np) => update((d) => ({ ...d, parameters: d.parameters.map((x, j) => (j === sel.index ? np : x)) }))}
                      onRemove={() => (update((d) => ({ ...d, parameters: d.parameters.filter((_x, j) => j !== sel.index) })), setSel(null))}
                    />
                  )}
                </Box>
              </Stack>
            )}

            {tab === 1 && (
              <Stack spacing={1.5}>
                <Stack direction="row" alignItems="center">
                  <Typography variant="subtitle1" sx={{ flex: 1 }}>
                    Report body
                  </Typography>
                  <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={(e) => setAddEl(e.currentTarget)}>
                    Insert
                  </Button>
                </Stack>
                {def.body.length === 0 && <Typography variant="body2" color="text.secondary">Empty. Insert a table, matrix, chart, KPI cards or text. Add a dataset first on the Data tab.</Typography>}
                <List dense sx={{ py: 0 }}>
                  {def.body.map((it, i) => (
                    <ListItemButton key={it.id} selected={sel?.kind === 'item' && sel.index === i} onClick={() => setSel({ kind: 'item', index: i })} sx={{ borderRadius: 1 }}>
                      <ListItemIcon sx={{ minWidth: 32 }}>{ITEM_META[it.type].icon}</ListItemIcon>
                      <ListItemText
                        primary={it.title || (it.type === 'text' ? it.text.slice(0, 60) : ITEM_META[it.type].label)}
                        secondary={'dataset' in it ? `${ITEM_META[it.type].label} · ${it.dataset}` : it.type !== 'text' && !it.title ? undefined : ITEM_META[it.type].label}
                        primaryTypographyProps={{ noWrap: true }}
                      />
                      <IconButton size="small" onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                        <ArrowUpwardIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={(e) => (e.stopPropagation(), move(i, 1))}>
                        <ArrowDownwardIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={(e) => (e.stopPropagation(), update((d) => ({ ...d, body: d.body.filter((_x, j) => j !== i) })), setSel(null))}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </ListItemButton>
                  ))}
                </List>
                {selected && (
                  <>
                    <Divider />
                    <Typography variant="subtitle2">{ITEM_META[selected.type].label}</Typography>
                    <ItemEditor it={selected} def={def} fieldsOf={fieldsOf} reports={otherReports} onChange={(ni) => update((d) => ({ ...d, body: d.body.map((x, j) => (j === sel!.index ? ni : x)) }))} />
                  </>
                )}
                <Menu anchorEl={addEl} open={!!addEl} onClose={() => setAddEl(null)}>
                  {(Object.keys(ITEM_META) as ItemType[]).map((t) => (
                    <MenuItem
                      key={t}
                      onClick={() => {
                        setAddEl(null);
                        const at = sel?.kind === 'item' ? sel.index + 1 : def.body.length;
                        update((d) => ({ ...d, body: [...d.body.slice(0, at), newItem(t, d), ...d.body.slice(at)] }));
                        setSel({ kind: 'item', index: at });
                      }}
                    >
                      <ListItemIcon>{ITEM_META[t].icon}</ListItemIcon>
                      {ITEM_META[t].label}
                    </MenuItem>
                  ))}
                </Menu>
              </Stack>
            )}

            {tab === 2 && (
              <Stack spacing={1.5}>
                <TextField size="small" label="Description" value={meta.description} onChange={(e) => (setMeta({ ...meta, description: e.target.value }), setDirty(true))} multiline />
                <Typography variant="subtitle2">Page setup</Typography>
                <Row>
                  <TextField select size="small" label="Paper" value={def.page.size} onChange={(e) => update((d) => ({ ...d, page: { ...d.page, size: e.target.value as 'A4' } }))} sx={{ width: 110 }}>
                    {['A4', 'A3', 'A5', 'LETTER', 'LEGAL'].map((s) => (
                      <MenuItem key={s} value={s}>
                        {s}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField select size="small" label="Orientation" value={def.page.orientation} onChange={(e) => update((d) => ({ ...d, page: { ...d.page, orientation: e.target.value as 'portrait' } }))} sx={{ width: 130 }}>
                    <MenuItem value="portrait">Portrait</MenuItem>
                    <MenuItem value="landscape">Landscape</MenuItem>
                  </TextField>
                  <TextField size="small" type="number" label="Font size" value={def.page.fontSize} onChange={(e) => update((d) => ({ ...d, page: { ...d.page, fontSize: Number(e.target.value) || 9 } }))} sx={{ width: 100 }} />
                </Row>
                <Row>
                  {(['Top', 'Right', 'Bottom', 'Left'] as const).map((l, i) => (
                    <TextField
                      key={l}
                      size="small"
                      type="number"
                      label={`${l} margin (mm)`}
                      value={def.page.margins[i]}
                      onChange={(e) =>
                        update((d) => {
                          const mg = [...d.page.margins] as [number, number, number, number];
                          mg[i] = Number(e.target.value) || 0;
                          return { ...d, page: { ...d.page, margins: mg } };
                        })
                      }
                      sx={{ width: 120 }}
                    />
                  ))}
                </Row>
                <Typography variant="subtitle2">Page header / footer</Typography>
                {(['header', 'footer'] as const).map((hf) => (
                  <Row key={hf}>
                    {(['left', 'center', 'right'] as const).map((pos) => (
                      <TextField key={pos} size="small" label={`${hf} ${pos}`} value={def[hf][pos]} onChange={(e) => update((d) => ({ ...d, [hf]: { ...d[hf], [pos]: e.target.value } }))} sx={{ flex: 1, minWidth: 140 }} />
                    ))}
                  </Row>
                ))}
                <Typography variant="caption" color="text.secondary">
                  {'{{Globals.PageNumber}}, {{Globals.TotalPages}}, {{Globals.ReportName}}, {{Globals.ExecutionTime}}, {{User.Name}}, {{Parameters.x}}'}
                </Typography>
                <Row>
                  <Check label="Show title on first page" checked={def.showTitle} onChange={(v) => update((d) => ({ ...d, showTitle: v }))} />
                  <Check label="Show parameter values" checked={def.showParameters} onChange={(v) => update((d) => ({ ...d, showParameters: v }))} />
                </Row>
                <Typography variant="subtitle2">Regional</Typography>
                <Row>
                  <TextField size="small" label="Currency symbol" value={def.currency} onChange={(e) => update((d) => ({ ...d, currency: e.target.value }))} sx={{ width: 130 }} />
                  <TextField size="small" label="Locale" value={def.locale} onChange={(e) => update((d) => ({ ...d, locale: e.target.value }))} sx={{ width: 120 }} helperText="en-US, en-IN, de-DE…" />
                  <TextField size="small" label="Time zone" value={def.timezone} onChange={(e) => update((d) => ({ ...d, timezone: e.target.value }))} sx={{ width: 170 }} />
                </Row>
                <Typography variant="subtitle2">Embedding in other applications</Typography>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={!!report.embedEnabled}
                      onChange={async (e) => {
                        try {
                          await m.setEmbed.mutateAsync({ id, enabled: e.target.checked });
                        } catch (err) {
                          setToast({ ok: false, msg: errorMessage(err) });
                        }
                      }}
                    />
                  }
                  label={<Typography variant="body2">Allow signed embedding (iframe at /embed/report/&lt;token&gt;)</Typography>}
                />
                {report.embedEnabled && (
                  <Box component="pre" sx={{ m: 0, p: 1.25, bgcolor: 'action.hover', borderRadius: 1, fontSize: 11.5, overflow: 'auto' }}>
                    {`// your app's backend (secret = Graphan EMBED_SECRET)
const token = jwt.sign({
  resource: { report: '${id}' },
  params: { /* locked parameters, e.g. region: user.region */ },
  user: currentUser.email,
  exp: Math.floor(Date.now() / 1000) + 600,
}, process.env.GRAPHAN_EMBED_SECRET);
// <iframe src="${window.location.origin}/embed/report/\${token}">`}
                  </Box>
                )}
                <Typography variant="subtitle2">Processing</Typography>
                <Row>
                  <TextField size="small" type="number" label="Cache results (minutes, 0 = off)" value={meta.cacheMinutes} onChange={(e) => (setMeta({ ...meta, cacheMinutes: Number(e.target.value) || 0 }), setDirty(true))} sx={{ width: 230 }} />
                  <TextField size="small" type="number" label="Snapshots to keep" value={meta.snapshotRetention} onChange={(e) => (setMeta({ ...meta, snapshotRetention: Number(e.target.value) || 30 }), setDirty(true))} sx={{ width: 160 }} />
                </Row>
              </Stack>
            )}

            {tab === 3 && (
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  The full report definition (like an SSRS .rdl). Edit and click Apply.
                </Typography>
                <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
                  <SqlEditor language="json" value={json} onChange={setJson} height={520} path={`rpt-${id}.json`} />
                </Box>
                {jsonErr && <Alert severity="error">{jsonErr}</Alert>}
                <Button
                  variant="outlined"
                  sx={{ alignSelf: 'flex-start' }}
                  onClick={async () => {
                    try {
                      const parsed = JSON.parse(json) as ReportDefinition;
                      const { data } = await api.post<{ ok: boolean; issues?: { path: string; message: string }[] }>('/reports/validate', { definition: parsed });
                      if (!data.ok) return setJsonErr(data.issues!.map((i) => `${i.path}: ${i.message}`).join('\n'));
                      setDef(parsed);
                      setDirty(true);
                      setJsonErr(null);
                      setToast({ ok: true, msg: 'Definition applied — Save to keep it' });
                    } catch (e) {
                      setJsonErr(errorMessage(e));
                    }
                  }}
                >
                  Apply
                </Button>
              </Stack>
            )}
          </Box>
        </Paper>

        {/* Right: live preview */}
        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          {def.parameters.some((p) => !p.hidden) && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                <Box sx={{ flex: 1 }}>
                  <ParameterPane reportId={id} parameters={def.parameters} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} definition={def} />
                </Box>
                <Button variant="contained" onClick={() => runPreview(values)} disabled={previewing} startIcon={<PlayArrowIcon />} sx={{ alignSelf: 'flex-start', whiteSpace: 'nowrap' }}>
                  Preview
                </Button>
              </Stack>
            </Paper>
          )}
          {previewing && <LinearProgress />}
          {previewErr && <Alert severity="error" sx={{ mb: 1.5 }}>{previewErr}</Alert>}
          <Box sx={{ bgcolor: (t) => (t.palette.mode === 'dark' ? '#1b1d22' : '#ECEFF3'), borderRadius: 1, p: { xs: 1, md: 2 }, minHeight: 400 }}>
            {preview ? (
              <ReportView model={preview} zoom={0.9} />
            ) : (
              <Stack alignItems="center" justifyContent="center" sx={{ py: 10 }} spacing={1}>
                <Typography color="text.secondary">Click Preview to run the report with the current (unsaved) design.</Typography>
                <Button variant="outlined" startIcon={<PlayArrowIcon />} onClick={() => runPreview()}>
                  Preview
                </Button>
              </Stack>
            )}
          </Box>
          {Object.keys(dsInfo).length > 0 && (
            <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Dataset fields
              </Typography>
              {Object.entries(dsInfo).map(([name, info]) => (
                <Box key={name} sx={{ mb: 1 }}>
                  <Typography variant="body2" fontWeight={600}>
                    {name} <Typography component="span" variant="caption" color="text.secondary">({info.rowCount} rows)</Typography>
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {info.columns.map((c) => (
                      <Chip key={c.name} size="small" variant="outlined" label={`${c.name} · ${c.type}`} />
                    ))}
                  </Stack>
                </Box>
              ))}
            </Paper>
          )}
        </Box>
      </Stack>
      <Snackbar open={!!toast} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
        {toast ? (
          <Alert severity={toast.ok ? 'success' : 'error'} variant="filled" onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Stack>
  );
}

