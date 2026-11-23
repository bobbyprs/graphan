import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import EmojiEventsIcon from '@mui/icons-material/EmojiEventsOutlined';
import SaveIcon from '@mui/icons-material/BookmarkAddedOutlined';
import { useMlPredict } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { FeatureInput, TrainResult } from '@/api/types';
import { formatValue } from '@/utils/format';
import { actualVsPredictedChart, importanceChart, partialDependenceChart, residualChart } from './charts';
import { KIND_META } from './ProfileView';

const fmt = (v: number | null | undefined, d = 3) => (v == null || !Number.isFinite(v) ? '–' : formatValue(v, 'short', d));

function Card({ title, subtitle, children, sx }: { title: string; subtitle?: string; children: React.ReactNode; sx?: object }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'surface.panel', minWidth: 0, ...sx }}>
      <Typography variant="subtitle2">{title}</Typography>
      {subtitle && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          {subtitle}
        </Typography>
      )}
      {children}
    </Paper>
  );
}

function Stat({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <Tooltip title={help}>
      <Box sx={{ cursor: 'help' }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography sx={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      </Box>
    </Tooltip>
  );
}

export function RegressionResults({ r }: { r: TrainResult }) {
  const theme = useTheme();
  const best = r.leaderboard.find((l) => l.id === r.best) ?? r.leaderboard[0];
  const maxR2 = Math.max(0.01, ...r.leaderboard.map((l) => l.r2));

  return (
    <Stack spacing={2}>
      {r.warnings.length > 0 && (
        <Alert severity="warning" variant="outlined">
          {r.warnings.length === 1 ? r.warnings[0] : (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {r.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </Box>
          )}
        </Alert>
      )}

      {/* Hero */}
      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel', borderColor: 'primary.main' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ md: 'center' }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
            <EmojiEventsIcon color="primary" sx={{ fontSize: 36 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.2 }}>
                Best model for {r.target}
              </Typography>
              <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
                {best.label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Explains <b>{Math.max(0, Math.round(best.r2 * 100))}%</b> of the variation
                {best.liftPct !== null && best.id !== 'baseline' ? ` · ${best.liftPct}% lower error than guessing the average` : ''}
              </Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
            <Stat label="R²" value={fmt(best.r2)} help="Share of variance explained on unseen data (cross-validated). 1 is perfect, 0 is no better than the mean." />
            <Stat label="RMSE" value={fmt(best.rmse)} help={`Typical prediction error in ${r.target} units (root mean squared, cross-validated).`} />
            <Stat label="MAE" value={fmt(best.mae)} help="Average absolute error on unseen data." />
            <Stat label="MAPE" value={best.mape == null ? '–' : `${fmt(best.mape, 1)}%`} help="Average error as a percentage of the actual value." />
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
          <Chip size="small" icon={<SaveIcon />} label={`Saved as “${r.model.name}”`} />
          <Chip size="small" variant="outlined" label={`${r.rows.used.toLocaleString()} rows · ${r.folds}-fold CV on ${r.rows.cv.toLocaleString()}`} />
          <Chip size="small" variant="outlined" label={`${r.features.length} features`} />
          <Chip size="small" variant="outlined" label={`${(r.durationMs / 1000).toFixed(1)} s`} />
        </Stack>
      </Paper>

      {/* Leaderboard */}
      <Card title="Model leaderboard" subtitle="Every algorithm trained and scored with the same cross-validation folds. Hover a model for how it works.">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Model</TableCell>
                <TableCell sx={{ minWidth: 160 }}>R²</TableCell>
                <TableCell align="right">RMSE</TableCell>
                <TableCell align="right">MAE</TableCell>
                <TableCell align="right">MAPE</TableCell>
                <TableCell align="right">vs baseline</TableCell>
                <TableCell align="right">Time</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {r.leaderboard.map((l, i) => (
                <TableRow key={l.id} selected={l.id === r.best}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell>
                    <Tooltip title={`${l.description}${l.params ? ` · ${Object.entries(l.params).map(([k, v]) => `${k}=${fmt(v)}`).join(', ')}` : ''}`}>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ cursor: 'help' }}>
                        <span style={{ fontWeight: l.id === r.best ? 700 : 400 }}>{l.label}</span>
                        <Chip size="small" label={l.family} variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                      </Stack>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <LinearProgress variant="determinate" value={Math.max(0, (l.r2 / maxR2) * 100)} sx={{ flex: 1, height: 6, borderRadius: 3 }} />
                      <Typography variant="caption" sx={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(l.r2)}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(l.rmse)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(l.mae)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.mape == null ? '–' : `${fmt(l.mape, 1)}%`}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: (l.liftPct ?? 0) > 0 ? 'success.main' : 'text.secondary' }}>
                    {l.id === 'baseline' || l.liftPct == null ? '–' : `${l.liftPct > 0 ? '−' : '+'}${Math.abs(l.liftPct)}% error`}
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>{l.trainMs < 1000 ? `${l.trainMs} ms` : `${(l.trainMs / 1000).toFixed(1)} s`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, alignItems: 'start' }}>
        <Card title="What drives the prediction" subtitle="Permutation importance: how much error grows when a column is shuffled on held-out rows.">
          <ReactECharts option={importanceChart(r, theme)} style={{ height: Math.max(180, Math.min(15, r.importance.length) * 26 + 40) }} notMerge />
        </Card>
        <WhatIf r={r} />
        <Card title="Actual vs predicted" subtitle="Out-of-fold predictions — points on the dashed line are perfect.">
          <ReactECharts option={actualVsPredictedChart(r, theme)} style={{ height: 300 }} notMerge />
        </Card>
        <Card title="Error distribution" subtitle="Residuals should centre on zero; skew or long tails hint at missing features.">
          <ReactECharts option={residualChart(r, theme)} style={{ height: 300 }} notMerge />
        </Card>
      </Box>

      {r.partialDependence.length > 0 && (
        <Card title="How each top feature moves the prediction" subtitle="Partial dependence: average prediction as one feature varies and everything else stays as observed.">
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', xl: 'repeat(4, 1fr)' } }}>
            {r.partialDependence.map((pd) => (
              <Box key={pd.feature} sx={{ minWidth: 0 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {pd.feature}
                </Typography>
                <ReactECharts option={partialDependenceChart(pd, r.target, theme)} style={{ height: 180 }} notMerge />
              </Box>
            ))}
          </Box>
        </Card>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: r.coefficients ? '1fr 1fr' : '1fr' } }}>
        {r.coefficients && (
          <Card title="Coefficients" subtitle={`Change in ${r.target} per one standard deviation of each input.`}>
            <Table size="small">
              <TableBody>
                {r.coefficients.slice(0, 15).map((c) => (
                  <TableRow key={c.name}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{c.name}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: c.coef >= 0 ? 'success.main' : 'error.main' }}>
                      {c.coef >= 0 ? '+' : ''}
                      {fmt(c.coef)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        <Card title="Inputs" subtitle="Columns the model learned from, and those it skipped.">
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            {r.features.map((f) => (
              <Chip key={f.name} size="small" icon={KIND_META[f.kind].icon} label={f.name} variant="outlined" />
            ))}
          </Stack>
          {r.excluded.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              Skipped: {r.excluded.map((e) => `${e.name} (${e.reason})`).join(' · ')}
            </Typography>
          )}
        </Card>
      </Box>
    </Stack>
  );
}

// ───────────── What-if ─────────────

function FeatureField({ f, value, onChange }: { f: FeatureInput; value: unknown; onChange: (v: unknown) => void }) {
  if (f.kind === 'categorical' || f.kind === 'boolean') {
    return (
      <TextField select size="small" label={f.name} value={value ?? ''} onChange={(e) => onChange(e.target.value)} fullWidth>
        {(f.options ?? []).map((o) => (
          <MenuItem key={o} value={o}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }
  if (f.kind === 'datetime') {
    return (
      <TextField
        size="small"
        type="date"
        label={f.name}
        value={typeof value === 'string' ? value.slice(0, 10) : ''}
        onChange={(e) => onChange(e.target.value)}
        fullWidth
        InputLabelProps={{ shrink: true }}
      />
    );
  }
  const min = f.min ?? 0;
  const max = f.max ?? 100;
  const n = typeof value === 'number' ? value : Number(value);
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <TextField size="small" type="number" label={f.name} value={Number.isFinite(n) ? n : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} sx={{ width: 140, flexShrink: 0 }} />
      {max > min && (
        <Slider size="small" min={min} max={max} step={(max - min) / 200} value={Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min} onChange={(_e, v) => onChange(Number((v as number).toPrecision(6)))} aria-label={f.name} />
      )}
    </Stack>
  );
}

function WhatIf({ r }: { r: TrainResult }) {
  const top = useMemo(() => {
    const rank = new Map(r.importance.map((i, k) => [i.feature, k]));
    return [...r.features].sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99));
  }, [r]);
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(r.features.map((f) => [f.name, f.default])));
  const [confidence, setConfidence] = useState<0.8 | 0.9 | 0.95>(0.9);
  const predict = useMlPredict();

  useEffect(() => setInputs(Object.fromEntries(r.features.map((f) => [f.name, f.default]))), [r]);
  useEffect(() => {
    const t = setTimeout(() => predict.mutate({ id: r.model.id, inputs: [inputs], confidence }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, confidence, r.model.id]);

  const p = predict.data?.predictions[0];
  const { min, max } = r.targetStats;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100))}%`;

  return (
    <Card title="What-if predictor" subtitle="Change inputs to see the model's prediction live, with a distribution-free (conformal) interval.">
      <Paper variant="outlined" sx={{ p: 1.5, my: 1, bgcolor: 'transparent' }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Predicted {r.target}
            </Typography>
            <Stack direction="row" alignItems="baseline" spacing={1}>
              <Typography sx={{ fontSize: 30, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{p ? fmt(p.prediction) : '–'}</Typography>
              {predict.isPending && <CircularProgress size={14} />}
            </Stack>
            {p && (
              <Typography variant="caption" color="text.secondary">
                {Math.round(confidence * 100)}% of outcomes fall in {fmt(p.lower)} – {fmt(p.upper)}
              </Typography>
            )}
          </Box>
          <ToggleButtonGroup size="small" exclusive value={confidence} onChange={(_e, v) => v && setConfidence(v)}>
            {[0.8, 0.9, 0.95].map((c) => (
              <ToggleButton key={c} value={c}>
                {Math.round(c * 100)}%
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Stack>
        {p && (
          <Tooltip title={`Observed range ${fmt(min)} – ${fmt(max)}`}>
            <Box sx={{ position: 'relative', height: 14, mt: 1.5, bgcolor: 'action.hover', borderRadius: 7 }}>
              <Box sx={{ position: 'absolute', top: 3, bottom: 3, left: pos(p.lower), width: `calc(${pos(p.upper)} - ${pos(p.lower)})`, bgcolor: 'primary.main', opacity: 0.3, borderRadius: 4 }} />
              <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: pos(p.prediction), width: 3, ml: '-1.5px', bgcolor: 'primary.main', borderRadius: 2 }} />
            </Box>
          </Tooltip>
        )}
        {predict.error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {errorMessage(predict.error)}
          </Alert>
        )}
      </Paper>
      <Stack spacing={1.5} sx={{ maxHeight: 340, overflow: 'auto', pt: 1, pr: 0.5 }}>
        {top.map((f) => (
          <FeatureField key={f.name} f={f} value={inputs[f.name]} onChange={(v) => setInputs((s) => ({ ...s, [f.name]: v }))} />
        ))}
      </Stack>
    </Card>
  );
}
