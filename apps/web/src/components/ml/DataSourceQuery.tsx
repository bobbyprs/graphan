import { useEffect } from 'react';
import { Box, Button, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TableRowsIcon from '@mui/icons-material/TableRowsOutlined';
import { useCompletion, useDataSources, useObjects, useSchemas } from '@/api/hooks';
import type { DataSourceType } from '@/api/types';
import { SqlEditor } from '@/components/common/SqlEditor';
import { DsIcon } from '@/components/common/misc';
import { TimeRangePicker } from '@/components/dashboard/TimeControls';

export interface QuerySpec {
  dataSourceId: string;
  sql: string;
  timeRange: { from: string; to: string };
}

export function quoteIdent(type: DataSourceType | undefined, name: string) {
  if (type === 'MYSQL') return `\`${name.replace(/`/g, '``')}\``;
  if (type === 'MSSQL') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

interface Props {
  value: QuerySpec;
  onChange: (v: QuerySpec) => void;
  onRun: () => void;
  running?: boolean;
  runLabel: string;
  hint?: string;
}

/** Data source + "start from a table" shortcut + SQL editor; shared by every ML Studio tab. */
export function DataSourceQuery({ value, onChange, onRun, running, runLabel, hint }: Props) {
  const { data: dataSources = [] } = useDataSources();
  const ds = dataSources.find((d) => d.id === value.dataSourceId);
  const { data: catalog } = useCompletion(value.dataSourceId || undefined);
  const { data: schemas = [] } = useSchemas(value.dataSourceId || undefined);
  const defaultSchema = ds?.options.defaultSchema ?? (schemas.includes('public') ? 'public' : schemas[0]);
  const { data: objects = [] } = useObjects(value.dataSourceId || undefined, defaultSchema);
  const tables = objects.filter((o) => ['table', 'view', 'materialized_view'].includes(o.kind));

  useEffect(() => {
    if (!value.dataSourceId && dataSources[0]) onChange({ ...value, dataSourceId: dataSources.find((d) => d.type !== 'MONGODB')?.id ?? dataSources[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSources]);

  const pickTable = (name: string) => {
    const t = tables.find((o) => o.name === name);
    if (!t) return;
    const ref = ds?.type === 'SQLITE' ? quoteIdent(ds.type, t.name) : `${quoteIdent(ds?.type, t.schema)}.${quoteIdent(ds?.type, t.name)}`;
    onChange({ ...value, sql: `SELECT *\nFROM ${ref}` });
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel' }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
          <TextField select size="small" label="Data source" value={value.dataSourceId} onChange={(e) => onChange({ ...value, dataSourceId: e.target.value })} sx={{ minWidth: 240 }}>
            {dataSources.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DsIcon type={d.type} size={20} />
                  <span>{d.name}</span>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Start from a table"
            value=""
            onChange={(e) => pickTable(e.target.value)}
            sx={{ minWidth: 220 }}
            disabled={!tables.length}
            InputProps={{ startAdornment: <TableRowsIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }}
          >
            {tables.map((t) => (
              <MenuItem key={`${t.schema}.${t.name}`} value={t.name}>
                {t.name}
                {t.rowEstimate != null && (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    ~{t.rowEstimate.toLocaleString()} rows
                  </Typography>
                )}
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ flex: 1 }} />
          <TimeRangePicker value={value.timeRange} onChange={(timeRange) => onChange({ ...value, timeRange })} />
          <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={onRun} disabled={running || !value.dataSourceId || !value.sql.trim()}>
            {runLabel}
          </Button>
        </Stack>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
          <SqlEditor value={value.sql} onChange={(sql) => onChange({ ...value, sql })} onRun={() => onRun()} language={ds?.type === 'MONGODB' ? 'json' : 'sql'} catalog={catalog} height={150} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          {hint ?? 'Each row is one example. Up to 50,000 rows are used.'} Macros such as <code>$__timeFilter(col)</code> use the time range above. Ctrl/⌘+Enter runs.
        </Typography>
      </Stack>
    </Paper>
  );
}
