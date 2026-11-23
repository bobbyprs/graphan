import { Alert, Autocomplete, Box, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import type { ForecastConfig, PanelOptions, PanelType, QueryResult, TsModelId } from '@/api/types';
import { isForecastColumn } from '@/components/viz/echartsOptions';
import { ForecastSummary } from './ForecastChip';

export const DEFAULT_FORECAST: ForecastConfig = {
  enabled: true,
  horizon: 12,
  model: 'auto',
  seasonality: 'auto',
  confidence: 0.95,
  anomalies: true,
  sensitivity: 'medium',
};

export const TS_MODELS: { id: 'auto' | TsModelId; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto (recommended)', hint: 'Backtests every model and keeps the most accurate' },
  { id: 'ensemble', label: 'Ensemble (top 3)', hint: 'Average of the three best models' },
  { id: 'holt_winters', label: 'Holt-Winters', hint: 'Trend + additive seasonality' },
  { id: 'holt_winters_mul', label: 'Holt-Winters (multiplicative)', hint: 'Seasonality proportional to level' },
  { id: 'theta', label: 'Theta', hint: 'Robust M3-competition winner' },
  { id: 'fourier', label: 'Trend + Fourier', hint: 'Regression on trend and harmonics' },
  { id: 'ar', label: 'Autoregressive (AR)', hint: 'Lagged values, order chosen by AIC' },
  { id: 'holt', label: 'Holt (damped trend)', hint: 'Trend without seasonality' },
  { id: 'ses', label: 'Exponential smoothing', hint: 'Level only' },
  { id: 'seasonal_naive', label: 'Seasonal naive', hint: 'Repeat last season' },
  { id: 'drift', label: 'Drift', hint: 'Last value + average slope' },
  { id: 'naive', label: 'Naive', hint: 'Repeat last value' },
];

interface Props {
  value?: ForecastConfig;
  onChange: (v: ForecastConfig | undefined) => void;
  result?: QueryResult;
  panelType: PanelType;
  options: PanelOptions;
  /** Hide the on/off switch (ML Studio, where forecasting is the point) */
  alwaysOn?: boolean;
}

export function ForecastSettings({ value, onChange, result, panelType, options, alwaysOn }: Props) {
  const cfg = value ?? { ...DEFAULT_FORECAST, enabled: false };
  const set = (patch: Partial<ForecastConfig>) => onChange({ ...cfg, ...patch });
  const columns = (result?.columns ?? []).map((c) => c.name).filter((c) => !isForecastColumn(c));
  const numeric = columns.filter((c) => result?.rows.some((r) => typeof r[c] === 'number'));
  const supported = ['line', 'area', 'bar', 'kpi', 'table'].includes(panelType);
  const seasonMode = typeof cfg.seasonality === 'number' ? 'custom' : cfg.seasonality;

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', gap: 1.5, alignItems: 'flex-start', bgcolor: 'transparent' }}>
        <AutoGraphIcon color="primary" sx={{ mt: 0.25 }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle2">Forecast &amp; anomaly detection</Typography>
          <Typography variant="caption" color="text.secondary">
            Trains up to 11 time-series models on this panel's data, backtests them on rolling windows and draws the winner with a prediction interval.
            Unusual points are flagged from the model's residuals.
          </Typography>
        </Box>
        {!alwaysOn && <Switch checked={cfg.enabled} onChange={(e) => onChange(e.target.checked ? { ...DEFAULT_FORECAST, ...value, enabled: true } : value ? { ...cfg, enabled: false } : undefined)} inputProps={{ 'aria-label': 'Enable forecast' }} />}
      </Paper>

      {!supported && cfg.enabled && <Alert severity="info">Forecasts are drawn on Line, Area, Bar and KPI panels (and listed in Tables).</Alert>}
      {options.seriesField && cfg.enabled && (
        <Alert severity="warning">This panel pivots by a series field. Forecasting works on wide data (one column per measure); remove the series field or rows sharing an x value will be summed.</Alert>
      )}

      {cfg.enabled && (
        <>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <Autocomplete
              multiple
              size="small"
              options={numeric}
              value={cfg.fields ?? []}
              onChange={(_e, v) => set({ fields: v.length ? v.slice(0, 5) : undefined })}
              renderInput={(p) => <TextField {...p} label="Fields to forecast" placeholder={cfg.fields?.length ? '' : 'auto: every numeric field'} />}
              sx={{ flex: 2 }}
            />
            <Autocomplete
              size="small"
              options={columns}
              value={cfg.xField ?? null}
              onChange={(_e, v) => set({ xField: v ?? undefined })}
              renderInput={(p) => <TextField {...p} label="Time field" placeholder="auto-detect" />}
              sx={{ flex: 1 }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
            <TextField
              type="number"
              label="Horizon (steps ahead)"
              value={cfg.horizon}
              onChange={(e) => set({ horizon: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
              sx={{ width: 180 }}
            />
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {[7, 12, 24, 30, 48, 90].map((h) => (
                <Chip key={h} size="small" label={h} variant={cfg.horizon === h ? 'filled' : 'outlined'} color={cfg.horizon === h ? 'primary' : 'default'} onClick={() => set({ horizon: h })} />
              ))}
            </Stack>
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField select label="Model" value={cfg.model} onChange={(e) => set({ model: e.target.value as ForecastConfig['model'] })} sx={{ flex: 1 }}>
              {TS_MODELS.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  <Stack>
                    <span>{m.label}</span>
                    <Typography variant="caption" color="text.secondary">
                      {m.hint}
                    </Typography>
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Seasonality"
              value={seasonMode}
              onChange={(e) => set({ seasonality: e.target.value === 'custom' ? 7 : (e.target.value as 'auto' | 'none') })}
              sx={{ width: { md: 170 } }}
            >
              <MenuItem value="auto">Auto-detect</MenuItem>
              <MenuItem value="none">None</MenuItem>
              <MenuItem value="custom">Custom period</MenuItem>
            </TextField>
            {seasonMode === 'custom' && (
              <TextField
                type="number"
                label="Period (steps)"
                value={cfg.seasonality}
                onChange={(e) => set({ seasonality: Math.max(2, Number(e.target.value) || 2) })}
                sx={{ width: { md: 130 } }}
              />
            )}
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ md: 'center' }}>
            <Box>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                Prediction interval
              </Typography>
              <ToggleButtonGroup size="small" exclusive value={cfg.confidence} onChange={(_e, v) => v && set({ confidence: v })}>
                {[0.8, 0.9, 0.95].map((c) => (
                  <ToggleButton key={c} value={c} sx={{ px: 1.5 }}>
                    {Math.round(c * 100)}%
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
            <Box>
              <FormControlLabel control={<Switch checked={cfg.anomalies} onChange={(e) => set({ anomalies: e.target.checked })} />} label="Flag anomalies" />
              {cfg.anomalies && (
                <ToggleButtonGroup size="small" exclusive value={cfg.sensitivity} onChange={(_e, v) => v && set({ sensitivity: v })} sx={{ ml: 1 }}>
                  <ToggleButton value="low">Low</ToggleButton>
                  <ToggleButton value="medium">Medium</ToggleButton>
                  <ToggleButton value="high">High</ToggleButton>
                </ToggleButtonGroup>
              )}
            </Box>
          </Stack>

          {result?.meta?.forecast?.length ? (
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'transparent' }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Model selection
              </Typography>
              <Stack spacing={1.5}>
                {result.meta.forecast.map((m) => (
                  <ForecastSummary key={m.field} m={m} unit={options.unit} />
                ))}
              </Stack>
            </Paper>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Run the query to see which model wins and how accurate it is.
            </Typography>
          )}
        </>
      )}
    </Stack>
  );
}
