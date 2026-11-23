import { useState } from 'react';
import { Alert, Box, Button, Chip, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import AddchartIcon from '@mui/icons-material/Addchart';
import { useMlForecast } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { ForecastConfig, Panel, QueryResult } from '@/api/types';
import { EmptyState } from '@/components/common/misc';
import { PanelRenderer } from '@/components/viz/PanelRenderer';
import { useCan } from '@/auth/AuthContext';
import { DataSourceQuery, type QuerySpec } from './DataSourceQuery';
import { DEFAULT_FORECAST, ForecastSettings } from './ForecastSettings';
import { accuracyLabel } from './ForecastChip';
import { AddToDashboardDialog } from './AddToDashboardDialog';

export function ForecastStudio({ spec, onSpec }: { spec: QuerySpec; onSpec: (s: QuerySpec) => void }) {
  const can = useCan();
  const fc = useMlForecast();
  const [cfg, setCfg] = useState<ForecastConfig>({ ...DEFAULT_FORECAST, horizon: 24 });
  const [result, setResult] = useState<QueryResult | null>(null);
  const [adding, setAdding] = useState(false);

  const run = (c = cfg) => fc.mutate({ ...spec, forecast: c }, { onSuccess: setResult });
  const panel: Panel = {
    id: 'forecast-preview',
    title: 'Forecast',
    type: 'line',
    gridPos: { x: 0, y: 0, w: 24, h: 10 },
    dataSourceId: spec.dataSourceId,
    query: spec.sql,
    options: cfg.xField ? { xField: cfg.xField, yFields: cfg.fields } : { yFields: cfg.fields },
    transforms: { forecast: cfg },
  };
  const metas = result?.meta?.forecast ?? [];
  const okMetas = metas.filter((m) => !m.error);

  return (
    <Stack spacing={2}>
      <DataSourceQuery
        value={spec}
        onChange={onSpec}
        onRun={() => run()}
        running={fc.isPending}
        runLabel="Forecast"
        hint="Return one row per period: a time column plus one or more numeric columns, e.g. SELECT $__timeGroup(created_at, 1d) AS time, SUM(amount) AS revenue … GROUP BY 1 ORDER BY 1."
      />

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: '2fr 1fr' }, alignItems: 'start' }}>
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel', minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
              Forecast
            </Typography>
            {okMetas[0] && <Chip size="small" color={accuracyLabel(okMetas[0].metrics.mase).color} variant="outlined" icon={<AutoGraphIcon />} label={`${okMetas[0].label} · ${accuracyLabel(okMetas[0].metrics.mase).label}`} />}
            {result && can.createDashboards && (
              <Button size="small" variant="outlined" startIcon={<AddchartIcon />} onClick={() => setAdding(true)}>
                Add to dashboard
              </Button>
            )}
          </Stack>
          <Box sx={{ height: 2 }}>{fc.isPending && <LinearProgress sx={{ height: 2 }} />}</Box>
          {fc.error && <Alert severity="error">{errorMessage(fc.error)}</Alert>}
          {result ? (
            <Box sx={{ height: 420 }}>
              <PanelRenderer panel={panel} result={result} />
            </Box>
          ) : (
            <EmptyState
              icon={<AutoGraphIcon sx={{ fontSize: 48 }} />}
              title="Forecast a time series"
              description="Run a query that returns a time column and numeric measures. Every model is backtested on the most recent data and the most accurate one projects the future with a prediction interval."
            />
          )}
          {metas
            .filter((m) => m.error)
            .map((m) => (
              <Alert key={m.field} severity="warning" sx={{ mt: 1 }}>
                {m.field}: {m.error}
              </Alert>
            ))}
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel' }}>
          <ForecastSettings
            value={cfg}
            onChange={(v) => {
              const next = v ?? { ...cfg, enabled: true };
              setCfg({ ...next, enabled: true });
              if (result) run({ ...next, enabled: true });
            }}
            result={result ?? undefined}
            panelType="line"
            options={{}}
            alwaysOn
          />
        </Paper>
      </Box>

      {okMetas.map((m) => (
        <Paper key={m.field} variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel' }}>
          <Typography variant="subtitle2">Backtest leaderboard · {m.field}</Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
            {m.backtest.origins} rolling origin{m.backtest.origins === 1 ? '' : 's'} × {m.backtest.horizon} steps · step {m.step}
            {m.period ? ` · seasonality ${m.period} steps (strength ${m.seasonalStrength?.toFixed(2)})` : ' · no significant seasonality'}
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Model</TableCell>
                <TableCell align="right">MASE</TableCell>
                <TableCell align="right">sMAPE</TableCell>
                <TableCell align="right">RMSE</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {m.leaderboard.map((l, i) => (
                <TableRow key={l.id} selected={l.id === m.model}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell sx={{ fontWeight: l.id === m.model ? 700 : 400 }}>{l.label}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.mase.toFixed(3)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.smape.toFixed(1)}%</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.rmse.toLocaleString(undefined, { maximumFractionDigits: 3 })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      ))}

      {adding && (
        <AddToDashboardDialog
          open
          onClose={() => setAdding(false)}
          timeRange={spec.timeRange}
          panel={{ title: `${okMetas.map((m) => m.field).join(', ') || 'Value'} forecast`, type: 'line', dataSourceId: spec.dataSourceId, query: spec.sql, options: panel.options, transforms: { forecast: cfg } }}
        />
      )}
    </Stack>
  );
}
