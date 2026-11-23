import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Chip, LinearProgress, List, ListItem, ListItemIcon, ListItemText, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import LightbulbIcon from '@mui/icons-material/LightbulbOutlined';
import { useAutoDashboard, useCreateDashboard, useDataSources, useObjects, useSchemas } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { PanelType, SuggestedDashboard } from '@/api/types';
import { DsIcon } from '@/components/common/misc';
import { VIZ_TYPES } from '@/components/dashboard/PanelEditor';
import { useCan } from '@/auth/AuthContext';

/** Mini 24-column layout preview of the generated panels. */
function LayoutPreview({ s }: { s: SuggestedDashboard }) {
  const rows = Math.max(...s.definition.panels.map((p) => p.gridPos.y + p.gridPos.h));
  const icon = (t: PanelType) => VIZ_TYPES.find((v) => v.type === t)?.icon;
  return (
    <Box sx={{ position: 'relative', width: '100%', aspectRatio: `24 / ${rows * 0.9}`, maxHeight: 420 }}>
      {s.definition.panels.map((p) => (
        <Paper
          key={p.id}
          variant="outlined"
          sx={{
            position: 'absolute',
            left: `${(p.gridPos.x / 24) * 100}%`,
            top: `${(p.gridPos.y / rows) * 100}%`,
            width: `calc(${(p.gridPos.w / 24) * 100}% - 4px)`,
            height: `calc(${(p.gridPos.h / rows) * 100}% - 4px)`,
            p: 0.75,
            overflow: 'hidden',
            bgcolor: 'surface.panel',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.25,
          }}
        >
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'text.secondary', '& svg': { fontSize: 14 } }}>
            {icon(p.type)}
            <Typography variant="caption" noWrap sx={{ fontWeight: 600, color: 'text.primary' }}>
              {p.title}
            </Typography>
          </Stack>
          {p.transforms?.forecast?.enabled && <Chip size="small" label="forecast" sx={{ height: 16, fontSize: 9, alignSelf: 'flex-start' }} />}
        </Paper>
      ))}
    </Box>
  );
}

export function AutoDashboard() {
  const navigate = useNavigate();
  const can = useCan();
  const { data: dataSources = [] } = useDataSources();
  const sqlSources = dataSources.filter((d) => d.type !== 'MONGODB');
  const [dsId, setDsId] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const { data: schemas = [] } = useSchemas(dsId || undefined);
  const { data: objects = [] } = useObjects(dsId || undefined, schema || undefined);
  const gen = useAutoDashboard();
  const create = useCreateDashboard();

  useEffect(() => {
    if (!dsId && sqlSources[0]) setDsId(sqlSources[0].id);
  }, [sqlSources, dsId]);
  useEffect(() => {
    const ds = dataSources.find((d) => d.id === dsId);
    if (schemas.length && !schemas.includes(schema)) setSchema(ds?.options.defaultSchema ?? (schemas.includes('public') ? 'public' : schemas[0]));
  }, [schemas, schema, dsId, dataSources]);

  const tables = objects.filter((o) => ['table', 'view', 'materialized_view'].includes(o.kind));

  const save = () =>
    gen.data &&
    create.mutate(
      { title: gen.data.title, description: gen.data.description, tags: ['auto', 'ml'], definition: gen.data.definition },
      { onSuccess: (d) => navigate(`/dashboards/${d.id}`) },
    );

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel' }}>
        <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 2 }}>
          <AutoAwesomeIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Generate a dashboard from your database
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Pick a table. Graphan reads its schema and a sample of rows, finds the time column, measures and dimensions, and builds KPIs, a forecast with anomaly
              detection, breakdowns, a filter with drill-down and a detail table.
            </Typography>
          </Box>
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <TextField select size="small" label="Data source" value={dsId} onChange={(e) => (setDsId(e.target.value), setSchema(''), setTable(''))} sx={{ minWidth: 220 }}>
            {sqlSources.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DsIcon type={d.type} size={20} />
                  <span>{d.name}</span>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Schema" value={schema} onChange={(e) => (setSchema(e.target.value), setTable(''))} sx={{ minWidth: 160 }}>
            {schemas.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Table" value={table} onChange={(e) => setTable(e.target.value)} sx={{ minWidth: 220, flex: 1 }}>
            {tables.map((t) => (
              <MenuItem key={t.name} value={t.name}>
                {t.name}
                {t.rowEstimate != null && (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    ~{t.rowEstimate.toLocaleString()} rows
                  </Typography>
                )}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" startIcon={<AutoAwesomeIcon />} disabled={!table || gen.isPending} onClick={() => gen.mutate({ dataSourceId: dsId, schema, table })}>
            Generate
          </Button>
        </Stack>
      </Paper>

      {gen.isPending && <LinearProgress />}
      {gen.error && <Alert severity="error">{errorMessage(gen.error)}</Alert>}

      {gen.data && (
        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel' }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }} sx={{ mb: 1.5 }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6">{gen.data.title}</Typography>
              <Typography variant="caption" color="text.secondary">
                {gen.data.definition.panels.length} panels · {gen.data.definition.variables.length} filter variable{gen.data.definition.variables.length === 1 ? '' : 's'} · time range {gen.data.definition.time.from} → now
              </Typography>
            </Box>
            {can.createDashboards && (
              <Button variant="contained" onClick={save} disabled={create.isPending}>
                Create dashboard
              </Button>
            )}
          </Stack>
          {create.error && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(create.error)}</Alert>}
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' } }}>
            <LayoutPreview s={gen.data} />
            <List dense disablePadding>
              {gen.data.insights.map((i) => (
                <ListItem key={i} disableGutters>
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <LightbulbIcon fontSize="small" color="warning" />
                  </ListItemIcon>
                  <ListItemText primary={i} primaryTypographyProps={{ variant: 'body2' }} />
                </ListItem>
              ))}
            </List>
          </Box>
        </Paper>
      )}
    </Stack>
  );
}
