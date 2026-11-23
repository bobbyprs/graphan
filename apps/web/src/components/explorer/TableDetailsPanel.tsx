import { useState } from 'react';
import { Alert, Box, Button, Chip, Grid2 as Grid, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Typography } from '@mui/material';
import KeyIcon from '@mui/icons-material/Key';
import ChevronLeft from '@mui/icons-material/ChevronLeft';
import ChevronRight from '@mui/icons-material/ChevronRight';
import { useDdl, useTableDetails, useTablePreview } from '@/api/hooks';
import type { DataSourceType, DbObjectKind } from '@/api/types';
import { SqlEditor } from '@/components/common/SqlEditor';
import { selectRows } from '@/utils/sqlScripts';
import { errorMessage } from '@/api/client';
import { ResultsGrid } from '@/components/common/ResultsGrid';
import { formatBytes, formatNumber, relativeTime } from '@/utils/format';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Paper sx={{ p: 1.5 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h6">{value}</Typography>
    </Paper>
  );
}

export function TableDetailsPanel({
  dsId,
  dsType,
  schema,
  table,
  kind = 'table',
  highlight,
  onQuery,
}: {
  dsId: string;
  dsType: DataSourceType;
  schema: string;
  table: string;
  kind?: DbObjectKind;
  highlight?: string;
  onQuery: (sql: string, title: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const { data, error, isLoading } = useTableDetails(dsId, schema, table);
  const preview = useTablePreview(tab === 1 ? dsId : undefined, schema, table, page, pageSize);
  const ddl = useDdl(tab === 4 ? dsId : undefined, schema, table, kind);

  if (error) return <Alert severity="error">{errorMessage(error)}</Alert>;
  if (isLoading || !data) return null;

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} spacing={1.5}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h6" sx={{ flex: 1 }} noWrap>{schema}.{table}</Typography>
        <Button size="small" variant="outlined" onClick={() => onQuery(selectRows(dsType, { schema, name: table }, 100), table)}>Query tool</Button>
      </Stack>
      <Grid container spacing={1.5}>
        <Grid size={{ xs: 6, md: 3 }}><Stat label="Rows" value={formatNumber(data.stats.rowCount)} /></Grid>
        <Grid size={{ xs: 6, md: 3 }}><Stat label="Columns" value={String(data.columns.length)} /></Grid>
        <Grid size={{ xs: 6, md: 3 }}><Stat label="Size" value={formatBytes(data.stats.totalBytes)} /></Grid>
        <Grid size={{ xs: 6, md: 3 }}><Stat label="Last analyzed" value={data.stats.lastAnalyzed ? relativeTime(data.stats.lastAnalyzed) : '–'} /></Grid>
      </Grid>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)}>
        <Tab label="Structure" />
        <Tab label="Data" />
        <Tab label={`Indexes (${data.indexes.length})`} />
        <Tab label={`Relationships (${data.foreignKeys.length + data.referencedBy.length})`} />
        <Tab label="SQL" />
      </Tabs>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 0 && (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow><TableCell>#</TableCell><TableCell>Column</TableCell><TableCell>Type</TableCell><TableCell>Nullable</TableCell><TableCell>Default</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {data.columns.map((c) => (
                <TableRow key={c.name} selected={c.name === highlight}>
                  <TableCell>{c.ordinal}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      {c.isPrimaryKey && <KeyIcon sx={{ fontSize: 14, color: 'warning.main' }} />}
                      <code>{c.name}</code>
                    </Stack>
                  </TableCell>
                  <TableCell><code>{c.dataType}{c.maxLength ? `(${c.maxLength})` : ''}</code></TableCell>
                  <TableCell>{c.nullable ? 'yes' : 'no'}</TableCell>
                  <TableCell sx={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><code>{c.defaultValue ?? ''}</code></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {tab === 1 && (
          <Stack sx={{ height: '100%', minHeight: 400 }} spacing={1}>
            {preview.error && <Alert severity="error">{errorMessage(preview.error)}</Alert>}
            <Box sx={{ flex: 1, minHeight: 360 }}>
              <ResultsGrid result={preview.data} pagination={false} />
            </Box>
            <Stack direction="row" alignItems="center" justifyContent="flex-end" spacing={1}>
              <Typography variant="caption">
                Rows {page * pageSize + 1}–{page * pageSize + (preview.data?.rowCount ?? 0)}
                {data.stats.rowCount != null ? ` of ~${formatNumber(data.stats.rowCount)}` : ''}
              </Typography>
              <Button size="small" startIcon={<ChevronLeft />} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</Button>
              <Button size="small" endIcon={<ChevronRight />} disabled={(preview.data?.rowCount ?? 0) < pageSize} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </Stack>
          </Stack>
        )}
        {tab === 4 && (
          <Stack spacing={1}>
            {ddl.error && <Alert severity="error">{errorMessage(ddl.error)}</Alert>}
            <Stack direction="row" justifyContent="flex-end">
              <Button size="small" disabled={!ddl.data} onClick={() => onQuery(ddl.data!, `${table} (DDL)`)}>
                Open in Query Tool
              </Button>
            </Stack>
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
              <SqlEditor value={ddl.isLoading ? '-- generating…' : (ddl.data ?? '')} onChange={() => undefined} readOnly height={460} path={`ddl-${schema}-${table}.sql`} />
            </Box>
          </Stack>
        )}
        {tab === 2 && (
          <Table size="small">
            <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Columns</TableCell><TableCell>Flags</TableCell></TableRow></TableHead>
            <TableBody>
              {data.indexes.map((i) => (
                <TableRow key={i.name}>
                  <TableCell><code>{i.name}</code></TableCell>
                  <TableCell><code>{i.columns.join(', ')}</code></TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {i.primary && <Chip size="small" color="warning" label="PRIMARY" />}
                      {i.unique && <Chip size="small" label="UNIQUE" />}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {tab === 3 && (
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>References (outgoing foreign keys)</Typography>
              {data.foreignKeys.length === 0 && <Typography variant="body2" color="text.secondary">None</Typography>}
              {data.foreignKeys.map((f) => (
                <Typography key={f.name} variant="body2" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                  ({f.columns.join(', ')}) → {f.refSchema}.{f.refTable} ({f.refColumns.join(', ')}) <Typography component="span" variant="caption" color="text.secondary">{f.name}</Typography>
                </Typography>
              ))}
            </Box>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Referenced by</Typography>
              {data.referencedBy.length === 0 && <Typography variant="body2" color="text.secondary">None</Typography>}
              {data.referencedBy.map((r) => (
                <Typography key={r.name} variant="body2" sx={{ fontFamily: 'monospace', mb: 0.5 }}>
                  {r.schema}.{r.table} <Typography component="span" variant="caption" color="text.secondary">{r.name}</Typography>
                </Typography>
              ))}
            </Box>
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
