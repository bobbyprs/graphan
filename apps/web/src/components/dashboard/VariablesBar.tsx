import { useEffect } from 'react';
import { Autocomplete, Chip, Stack, TextField } from '@mui/material';
import { useVariableOptions } from '@/api/hooks';
import type { Variable } from '@/api/types';

export const ALL = '$__all';
export type VarValues = Record<string, string | string[]>;

function VariablePicker({
  dashboardId,
  variable,
  value,
  onChange,
  onOptions,
  publicToken,
}: {
  dashboardId: string;
  variable: Variable;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
  onOptions: (name: string, values: string[]) => void;
  publicToken?: string;
}) {
  const needsFetch = variable.type === 'query';
  const { data: fetched = [], isLoading } = useVariableOptions(dashboardId, variable.name, needsFetch, publicToken);
  const options = needsFetch ? fetched : (variable.options ?? []);

  useEffect(() => {
    onOptions(variable.name, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.join('\u0001'), variable.name]);

  const label = variable.label ?? variable.name;

  if (variable.type === 'textbox') {
    return (
      <TextField
        label={label}
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        sx={{ minWidth: 160 }}
      />
    );
  }

  const all = variable.includeAll ? [ALL, ...options] : options;
  const display = (o: string) => (o === ALL ? 'All' : o);

  if (variable.multi) {
    const v = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <Autocomplete
        multiple
        size="small"
        loading={isLoading}
        options={all}
        value={v}
        getOptionLabel={display}
        onChange={(_e, nv) => {
          // Selecting "All" clears specifics; selecting a specific clears "All"
          const last = nv[nv.length - 1];
          onChange(last === ALL ? [ALL] : nv.filter((x) => x !== ALL));
        }}
        disableCloseOnSelect
        limitTags={2}
        renderTags={(vals, getTagProps) => vals.map((o, i) => <Chip size="small" label={display(o)} {...getTagProps({ index: i })} key={o} />)}
        renderInput={(p) => <TextField {...p} label={label} />}
        sx={{ minWidth: 220, maxWidth: 420 }}
      />
    );
  }

  return (
    <Autocomplete
      size="small"
      loading={isLoading}
      options={all}
      value={(value as string) ?? null}
      getOptionLabel={display}
      onChange={(_e, nv) => nv != null && onChange(nv)}
      renderInput={(p) => <TextField {...p} label={label} />}
      sx={{ minWidth: 180 }}
    />
  );
}

export function VariablesBar(props: {
  dashboardId: string;
  variables: Variable[];
  values: VarValues;
  onChange: (name: string, v: string | string[]) => void;
  onOptions: (name: string, values: string[]) => void;
  publicToken?: string;
}) {
  if (!props.variables.length) return null;
  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" sx={{ mb: 1.5 }}>
      {props.variables.map((v) => (
        <VariablePicker
          key={v.name}
          dashboardId={props.dashboardId}
          variable={v}
          value={props.values[v.name]}
          onChange={(nv) => props.onChange(v.name, nv)}
          onOptions={props.onOptions}
          publicToken={props.publicToken}
        />
      ))}
    </Stack>
  );
}

/** Expands "$__all" into the concrete option list before sending to the API. */
export function resolveVariableValues(vars: Variable[], values: VarValues, options: Record<string, string[]>) {
  const out: Record<string, string | string[]> = {};
  for (const v of vars) {
    let val = values[v.name] ?? v.default;
    if (val === undefined) continue;
    const arr = Array.isArray(val) ? val : [val];
    if (arr.includes(ALL)) val = options[v.name] ?? [];
    out[v.name] = v.multi || v.includeAll ? (Array.isArray(val) ? val : [val]) : val;
  }
  return out;
}
