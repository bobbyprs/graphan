import { useEffect } from 'react';
import { Autocomplete, Box, Chip, MenuItem, TextField } from '@mui/material';
import { useParamOptions, type ParamValues, type ReportDefinition, type ReportParameter } from '@/api/reports';

interface Props {
  reportId: string;
  parameters: ReportParameter[];
  values: ParamValues;
  onChange: (name: string, v: unknown) => void;
  /** Designer preview: options are computed from the unsaved definition */
  definition?: ReportDefinition;
  disabled?: boolean;
  /** API base for option lookups (embedded viewer uses /embed/report) */
  basePath?: string;
}

const ALL_OPTION = { value: '__all__all', label: '(Select all)' };
const asArray = (v: unknown): (string | number)[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v as string | number]);

function ParamInput({ p, index, props }: { p: ReportParameter; index: number; props: Props }) {
  const { reportId, parameters, values, onChange, definition, disabled, basePath } = props;
  // Cascading: options depend on the values of earlier parameters
  const earlier: ParamValues = {};
  parameters.slice(0, index).forEach((x) => (earlier[x.name] = values[x.name]));
  const hasOptions = p.options.kind !== 'none';
  const { data: options = [], isFetching, error } = useParamOptions(basePath ?? `/reports/${reportId}`, p.name, earlier, hasOptions, definition);
  const value = values[p.name];
  const label = `${p.label || p.name}${p.required ? ' *' : ''}`;

  // Drop selections no longer offered after a parent parameter changed
  useEffect(() => {
    if (!hasOptions || isFetching || !options.length) return;
    const allowed = new Set(options.map((o) => String(o.value)));
    const cur = asArray(value);
    const kept = cur.filter((x) => allowed.has(String(x)));
    if (kept.length === cur.length) return;
    if (p.multi) onChange(p.name, kept.length || p.options.kind !== 'query' || !p.options.defaultFirst ? kept : options.map((o) => o.value));
    else onChange(p.name, kept[0] ?? (p.options.kind === 'query' && p.options.defaultFirst ? options[0]?.value : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, isFetching]);

  const common = { size: 'small' as const, label, disabled, sx: { minWidth: 180, flex: '1 1 200px', maxWidth: p.multi ? 420 : 280 } };

  if (hasOptions) {
    const byValue = new Map(options.map((o) => [String(o.value), o]));
    if (p.multi) {
      const selected = asArray(value).map((v) => byValue.get(String(v)) ?? { value: v, label: String(v) });
      const all = options.length > 0 && selected.length === options.length;
      return (
        <Autocomplete
          multiple
          disableCloseOnSelect
          options={[ALL_OPTION, ...options]}
          loading={isFetching}
          value={selected}
          isOptionEqualToValue={(a, b) => String(a.value) === String(b.value)}
          getOptionLabel={(o) => o.label}
          onChange={(_e, v) => {
            if (v.some((o) => o.value === ALL_OPTION.value)) onChange(p.name, all ? [] : options.map((o) => o.value));
            else onChange(p.name, v.map((o) => o.value));
          }}
          disabled={disabled}
          sx={common.sx}
          renderTags={(v, getTagProps) =>
            all
              ? [<Chip key="all" size="small" label={`All (${options.length})`} />]
              : [
                  ...v.slice(0, 2).map((o, i) => <Chip {...getTagProps({ index: i })} key={String(o.value)} size="small" label={o.label} />),
                  ...(v.length > 2 ? [<Chip key="more" size="small" label={`+${v.length - 2}`} />] : []),
                ]
          }
          ListboxProps={{ style: { maxHeight: 320 } }}
          slotProps={{ paper: { sx: { minWidth: 260 } } }}
          renderOption={(liProps, o, { selected: sel }) => (
            <li {...liProps} key={String(o.value)} style={o.value === ALL_OPTION.value ? { borderBottom: '1px solid rgba(128,128,128,.25)', fontStyle: 'italic' } : undefined}>
              <input type="checkbox" readOnly checked={o.value === ALL_OPTION.value ? all : sel} style={{ marginRight: 8 }} />
              {o.value === ALL_OPTION.value && all ? 'Clear selection' : o.label}
            </li>
          )}
          renderInput={(params) => <TextField {...params} size="small" label={label} error={!!error} helperText={error ? 'Could not load values' : undefined} />}
        />
      );
    }
    return (
      <TextField select {...common} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(p.name, e.target.value === '' ? null : (byValue.get(e.target.value)?.value ?? e.target.value))} error={!!error} helperText={error ? 'Could not load values' : undefined}>
        {!p.required && (
          <MenuItem value="">
            <em>(none)</em>
          </MenuItem>
        )}
        {options.map((o) => (
          <MenuItem key={String(o.value)} value={String(o.value)}>
            {o.label}
          </MenuItem>
        ))}
        {value !== null && value !== undefined && value !== '' && !byValue.has(String(value)) && <MenuItem value={String(value)}>{String(value)}</MenuItem>}
      </TextField>
    );
  }

  switch (p.type) {
    case 'boolean':
      return (
        <TextField select {...common} value={value === null || value === undefined ? '' : String(value === true || value === 'true')} onChange={(e) => onChange(p.name, e.target.value === '' ? null : e.target.value === 'true')}>
          {!p.required && <MenuItem value="">(none)</MenuItem>}
          <MenuItem value="true">Yes</MenuItem>
          <MenuItem value="false">No</MenuItem>
        </TextField>
      );
    case 'date':
      return <TextField {...common} type="date" value={String(value ?? '').slice(0, 10)} onChange={(e) => onChange(p.name, e.target.value || null)} InputLabelProps={{ shrink: true }} />;
    case 'datetime':
      return <TextField {...common} type="datetime-local" value={String(value ?? '').slice(0, 16)} onChange={(e) => onChange(p.name, e.target.value || null)} InputLabelProps={{ shrink: true }} />;
    case 'integer':
    case 'float':
      return <TextField {...common} type="number" value={value ?? ''} inputProps={{ step: p.type === 'integer' ? 1 : 'any' }} onChange={(e) => onChange(p.name, e.target.value === '' ? null : Number(e.target.value))} />;
    default:
      if (p.multi)
        return (
          <Autocomplete
            multiple
            freeSolo
            options={[] as string[]}
            value={asArray(value).map(String)}
            onChange={(_e, v) => onChange(p.name, v)}
            disabled={disabled}
            sx={common.sx}
            renderInput={(params) => <TextField {...params} size="small" label={label} placeholder="Type and press Enter" />}
          />
        );
      return <TextField {...common} value={value ?? ''} onChange={(e) => onChange(p.name, e.target.value === '' ? null : e.target.value)} />;
  }
}

/** SSRS-style parameter bar (cascading, multi-select with Select all, typed inputs). */
export function ParameterPane(props: Props) {
  const visible = props.parameters.map((p, i) => ({ p, i })).filter(({ p }) => !p.hidden);
  if (!visible.length) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'flex-start' }}>
      {visible.map(({ p, i }) => (
        <ParamInput key={p.name} p={p} index={i} props={props} />
      ))}
    </Box>
  );
}
