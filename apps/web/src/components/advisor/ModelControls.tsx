import { useEffect, useState } from 'react';
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
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import EditIcon from '@mui/icons-material/Edit';
import { ROLE_META, type AColumn, type ATable, type ColumnOverride, type ColumnRole, type ManualJoin, type ModelOverrides, type TableOverride } from '@/api/advisor';

// ───────────── Draft operations (pure) ─────────────

const clean = <T extends object>(o: T): T | undefined => {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as T;
  return Object.keys(out).length ? out : undefined;
};

export const colKey = (tableKey: string, column: string) => `${tableKey}|${column}`;

export function setTableOv(ov: ModelOverrides, key: string, patch: Partial<Record<keyof TableOverride, unknown>>): ModelOverrides {
  const next = clean({ ...(ov.tables?.[key] ?? {}), ...patch } as TableOverride);
  const tables = { ...(ov.tables ?? {}) };
  if (next) tables[key] = next;
  else delete tables[key];
  return { ...ov, tables };
}

export function setColumnOv(ov: ModelOverrides, tableKey: string, col: string, patch: Partial<ColumnOverride>): ModelOverrides {
  const k = colKey(tableKey, col);
  const next = clean({ ...(ov.columns?.[k] ?? {}), ...patch });
  const columns = { ...(ov.columns ?? {}) };
  if (next) columns[k] = next;
  else delete columns[k];
  return { ...ov, columns };
}

export function toggleJoinRemoved(ov: ModelOverrides, id: string): ModelOverrides {
  const cur = ov.joins?.remove ?? [];
  const remove = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return { ...ov, joins: { ...(ov.joins ?? {}), remove } };
}

export function addManualJoin(ov: ModelOverrides, j: ManualJoin): ModelOverrides {
  const id = (x: ManualJoin) => `${x.left.schema}.${x.left.table}.${x.left.column}`;
  const add = [...(ov.joins?.add ?? []).filter((x) => id(x) !== id(j)), j];
  return { ...ov, joins: { ...(ov.joins ?? {}), add } };
}

export function removeManualJoin(ov: ModelOverrides, leftKey: string): ModelOverrides {
  const add = (ov.joins?.add ?? []).filter((x) => `${x.left.schema}.${x.left.table}.${x.left.column}` !== leftKey);
  return { ...ov, joins: { ...(ov.joins ?? {}), add } };
}

export function setKpiOv(ov: ModelOverrides, id: string, patch: { name?: string; hidden?: boolean }): ModelOverrides {
  const next = clean({ ...(ov.kpis?.[id] ?? {}), ...patch });
  const kpis = { ...(ov.kpis ?? {}) };
  if (next) kpis[id] = next;
  else delete kpis[id];
  return { ...ov, kpis };
}

export function countCorrections(ov: ModelOverrides) {
  return Object.keys(ov.tables ?? {}).length + Object.keys(ov.columns ?? {}).length + (ov.joins?.add?.length ?? 0) + (ov.joins?.remove?.length ?? 0) + Object.keys(ov.kpis ?? {}).length;
}

/** Stable comparison (key order independent) to know whether the draft differs from what is saved. */
export function sameModel(a: ModelOverrides, b: ModelOverrides) {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)])) : v;
  const strip = (o: ModelOverrides) => norm({ tables: o.tables ?? {}, columns: o.columns ?? {}, add: o.joins?.add ?? [], remove: o.joins?.remove ?? [], kpis: o.kpis ?? {} });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// ───────────── Small editors ─────────────

const ROLES = Object.keys(ROLE_META) as ColumnRole[];

/** Text field that commits on blur / Enter, so typing does not re-render the whole page. */
export function CommitField({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.ComponentProps<typeof TextField>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onCommit(v.trim());
  return <TextField {...rest} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())} />;
}

export function SynonymsField({ value, onChange, disabled, label = 'Synonyms', width = 260 }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; label?: string; width?: number | string }) {
  return (
    <Autocomplete
      multiple
      freeSolo
      size="small"
      options={[]}
      value={value}
      disabled={disabled}
      onChange={(_e, v) => onChange((v as string[]).map((x) => x.trim()).filter(Boolean).slice(0, 20))}
      renderTags={(vals, getTagProps) => vals.map((x, i) => <Chip {...getTagProps({ index: i })} key={x} size="small" label={x} sx={{ height: 20 }} />)}
      renderInput={(p) => <TextField {...p} label={label} placeholder={value.length ? '' : 'type, Enter'} />}
      sx={{ width }}
    />
  );
}

export function RoleSelect({ c, value, onChange, canEdit }: { c: AColumn; value: ColumnRole | undefined; onChange: (role: ColumnRole | undefined) => void; canEdit: boolean }) {
  const shown = value ?? c.role;
  const chip = (
    <Chip
      size="small"
      label={ROLE_META[shown].label}
      color={ROLE_META[shown].color}
      variant={shown === 'measure' || shown === 'dimension' || shown === 'time' ? 'filled' : 'outlined'}
      icon={value ? <EditIcon sx={{ fontSize: '12px !important' }} /> : undefined}
      sx={{ height: 20, cursor: canEdit ? 'pointer' : undefined }}
    />
  );
  const tip = value ? 'Set in the data model' : `${c.reason} (${c.roleConfidence}% confident)${canEdit ? '. Click to correct.' : ''}`;
  if (!canEdit) return <Tooltip title={tip}>{chip}</Tooltip>;
  return (
    <TextField
      select
      size="small"
      variant="standard"
      value={value ?? '__auto'}
      onChange={(e) => onChange(e.target.value === '__auto' ? undefined : (e.target.value as ColumnRole))}
      SelectProps={{ renderValue: () => <Tooltip title={tip}>{chip}</Tooltip>, disableUnderline: true } as object}
      sx={{ minWidth: 110 }}
    >
      <MenuItem value="__auto" dense>
        Automatic
      </MenuItem>
      {ROLES.map((r) => (
        <MenuItem key={r} value={r} dense>
          {ROLE_META[r].label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** Data-model settings of one table: name, synonyms, time and label column, hidden. */
export function TableModelEditor({ t, ov, onChange, canEdit }: { t: ATable; ov: ModelOverrides; onChange: (ov: ModelOverrides) => void; canEdit: boolean }) {
  const to = ov.tables?.[t.key] ?? {};
  const timeCols = t.columns.filter((c) => c.role === 'time' || c.role === 'auditTime' || c.kind === 'datetime');
  const labelCols = t.columns.filter((c) => ['label', 'dimension', 'text', 'identifier'].includes(c.role));
  const tv = to.timeColumn === null ? '__none' : to.timeColumn ?? '__auto';
  const lv = to.labelColumn === null ? '__none' : to.labelColumn ?? '__auto';
  return (
    <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 1.5, mb: 1.5, alignItems: 'center' }}>
      <CommitField size="small" label="Display name" placeholder={t.label ?? t.name} value={to.label ?? ''} disabled={!canEdit} onCommit={(v) => onChange(setTableOv(ov, t.key, { label: v }))} sx={{ width: 200 }} />
      <SynonymsField value={to.synonyms ?? []} disabled={!canEdit} onChange={(v) => onChange(setTableOv(ov, t.key, { synonyms: v }))} />
      <TextField select size="small" label="Time column" value={tv} disabled={!canEdit} sx={{ width: 180 }} onChange={(e) => onChange(setTableOv(ov, t.key, { timeColumn: e.target.value === '__auto' ? undefined : e.target.value === '__none' ? null : e.target.value }))}>
        <MenuItem value="__auto">Automatic{t.timeColumn && to.timeColumn === undefined ? ` (${t.timeColumn})` : ''}</MenuItem>
        <MenuItem value="__none">None</MenuItem>
        {timeCols.map((c) => (
          <MenuItem key={c.name} value={c.name}>
            {c.name}
          </MenuItem>
        ))}
      </TextField>
      <TextField select size="small" label="Label column" value={lv} disabled={!canEdit} sx={{ width: 180 }} onChange={(e) => onChange(setTableOv(ov, t.key, { labelColumn: e.target.value === '__auto' ? undefined : e.target.value === '__none' ? null : e.target.value }))}>
        <MenuItem value="__auto">Automatic{t.labelColumn && to.labelColumn === undefined ? ` (${t.labelColumn})` : ''}</MenuItem>
        <MenuItem value="__none">None</MenuItem>
        {labelCols.map((c) => (
          <MenuItem key={c.name} value={c.name}>
            {c.name}
          </MenuItem>
        ))}
      </TextField>
      <FormControlLabel control={<Switch size="small" checked={!!to.hidden} disabled={!canEdit} onChange={(e) => onChange(setTableOv(ov, t.key, { hidden: e.target.checked || undefined }))} />} label={<Typography variant="body2">Hide from analysis</Typography>} />
    </Stack>
  );
}

export function AddJoinDialog({ open, onClose, tables, onAdd, initialLeft }: { open: boolean; onClose: () => void; tables: ATable[]; onAdd: (j: ManualJoin) => void; initialLeft?: string }) {
  const [lt, setLt] = useState<ATable | null>(null);
  const [lc, setLc] = useState('');
  const [rt, setRt] = useState<ATable | null>(null);
  const [rc, setRc] = useState('');
  useEffect(() => {
    if (!open) return;
    setLt(tables.find((t) => t.key === initialLeft) ?? null);
    setLc('');
    setRt(null);
    setRc('');
  }, [open, initialLeft, tables]);
  useEffect(() => {
    if (rt && !rc) setRc(rt.primaryKey ?? rt.columns[0]?.name ?? '');
  }, [rt, rc]);
  const ok = lt && lc && rt && rc && !(lt.key === rt.key && lc === rc);
  const opt = (t: ATable) => `${t.key}${t.label ? ` (${t.label})` : ''}`;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a join</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Many rows of the first table point to one row of the second (for example <code>orders.customer_id → customers.id</code>). Manual joins always count as 100% and are used by suggestions and questions.
        </Typography>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Autocomplete size="small" options={tables} value={lt} getOptionLabel={opt} onChange={(_e, v) => (setLt(v), setLc(''))} sx={{ flex: 1 }} renderInput={(p) => <TextField {...p} label="From table (many)" />} />
            <TextField select size="small" label="Column" value={lc} disabled={!lt} onChange={(e) => setLc(e.target.value)} sx={{ width: { sm: 180 } }}>
              {(lt?.columns ?? []).map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Autocomplete size="small" options={tables} value={rt} getOptionLabel={opt} onChange={(_e, v) => (setRt(v), setRc(''))} sx={{ flex: 1 }} renderInput={(p) => <TextField {...p} label="To table (one)" />} />
            <TextField select size="small" label="Key column" value={rc} disabled={!rt} onChange={(e) => setRc(e.target.value)} sx={{ width: { sm: 180 } }}>
              {(rt?.columns ?? []).map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name}
                  {c.name === rt?.primaryKey ? ' (primary key)' : ''}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          {lt && lc && rt && rc && lt.columns.find((c) => c.name === lc)?.dataType !== rt.columns.find((c) => c.name === rc)?.dataType && (
            <Alert severity="info">
              Data types differ ({lt.columns.find((c) => c.name === lc)?.dataType} vs {rt.columns.find((c) => c.name === rc)?.dataType}). Check the values really match.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!ok}
          onClick={() => {
            onAdd({ left: { schema: lt!.schema, table: lt!.name, column: lc }, right: { schema: rt!.schema, table: rt!.name, column: rc } });
            onClose();
          }}
        >
          Add join
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Sticky bar shown while the draft has unsaved corrections. */
export function ModelSaveBar({ draft, saved, saving, error, onSave, onDiscard }: { draft: ModelOverrides; saved: ModelOverrides; saving: boolean; error?: string; onSave: () => void; onDiscard: () => void }) {
  if (sameModel(draft, saved)) return null;
  return (
    <Paper elevation={6} sx={{ position: 'sticky', bottom: 16, zIndex: 5, mt: 2, p: 1.5, display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', border: 1, borderColor: 'warning.main' }}>
      <Box sx={{ flex: 1, minWidth: 220 }}>
        <Typography variant="subtitle2">Unsaved data model changes ({countCorrections(draft)} correction{countCorrections(draft) === 1 ? '' : 's'} in total)</Typography>
        <Typography variant="caption" color="text.secondary">
          Saving stores the corrections for this data source (shared with your workspace) and analyses again with them.
        </Typography>
        {error && (
          <Typography variant="caption" color="error" sx={{ display: 'block' }}>
            {error}
          </Typography>
        )}
      </Box>
      <Button color="inherit" onClick={onDiscard} disabled={saving}>
        Discard
      </Button>
      <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save & re-analyse'}
      </Button>
    </Paper>
  );
}
