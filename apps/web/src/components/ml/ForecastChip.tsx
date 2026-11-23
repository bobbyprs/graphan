import { Box, Chip, Divider, Stack, Tooltip, Typography } from '@mui/material';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { ForecastMeta, PanelOptions, QueryResult } from '@/api/types';
import { formatValue } from '@/utils/format';

/** Qualitative accuracy from MASE (mean absolute scaled error; < 1 beats a naive forecast). */
export function accuracyLabel(mase: number): { label: string; color: 'success' | 'info' | 'warning' | 'error' } {
  if (!Number.isFinite(mase)) return { label: 'Unvalidated', color: 'warning' };
  if (mase < 0.5) return { label: 'High accuracy', color: 'success' };
  if (mase < 1) return { label: 'Good accuracy', color: 'info' };
  if (mase < 1.5) return { label: 'Fair accuracy', color: 'warning' };
  return { label: 'Low accuracy', color: 'error' };
}

export function ForecastSummary({ m, unit }: { m: ForecastMeta; unit?: PanelOptions['unit'] }) {
  const fmt = (v: number) => formatValue(v, unit);
  if (m.error) {
    return (
      <Typography variant="caption" component="div">
        <b>{m.field}</b>: not forecast — {m.error}
      </Typography>
    );
  }
  const acc = accuracyLabel(m.metrics.mase);
  return (
    <Box>
      <Typography variant="caption" component="div" sx={{ fontWeight: 600 }}>
        {m.field} · {m.label}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        {acc.label} · MASE {Number.isFinite(m.metrics.mase) ? m.metrics.mase.toFixed(2) : '–'} · sMAPE {Number.isFinite(m.metrics.smape) ? `${m.metrics.smape.toFixed(1)}%` : '–'}
      </Typography>
      <Typography variant="caption" component="div" color="text.secondary">
        Step {m.step}
        {m.period ? ` · season of ${m.period} steps` : ' · no seasonality'}
        {m.trendPct !== null ? ` · ${m.trendPct >= 0 ? '+' : ''}${m.trendPct.toFixed(1)}% vs recent` : ''}
        {m.anomalyCount ? ` · ${m.anomalyCount} anomal${m.anomalyCount === 1 ? 'y' : 'ies'}` : ''}
      </Typography>
      {m.next && (
        <Typography variant="caption" component="div" color="text.secondary">
          Next: <b>{fmt(m.next.yhat)}</b> ({Math.round(m.confidence * 100)}% PI {fmt(m.next.lower)} – {fmt(m.next.upper)})
        </Typography>
      )}
      {m.leaderboard.length > 1 && (
        <Box component="table" sx={{ mt: 0.5, fontSize: 11, borderSpacing: 0, '& td': { pr: 1.5, py: 0.1 } }}>
          <tbody>
            {m.leaderboard.slice(0, 4).map((l, i) => (
              <tr key={l.id} style={{ fontWeight: l.id === m.model ? 700 : 400 }}>
                <td>{i + 1}.</td>
                <td>{l.label}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.mase.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </Box>
      )}
    </Box>
  );
}

/** Panel-header chip: which model is forecasting, how accurate it was in backtests. */
export function ForecastChip({ meta, unit }: { meta: NonNullable<QueryResult['meta']>; unit?: PanelOptions['unit'] }) {
  const fc = meta.forecast ?? [];
  const warnings = meta.warnings ?? [];
  if (!fc.length && !warnings.length) return null;
  const ok = fc.filter((m) => !m.error);
  const primary = ok[0];
  const acc = primary ? accuracyLabel(primary.metrics.mase) : null;
  return (
    <Tooltip
      arrow
      title={
        <Stack spacing={1} divider={<Divider flexItem />} sx={{ py: 0.5, maxWidth: 320 }}>
          {fc.map((m) => (
            <ForecastSummary key={m.field} m={m} unit={unit} />
          ))}
          {warnings.map((w) => (
            <Typography key={w} variant="caption">
              {w}
            </Typography>
          ))}
          {primary && (
            <Typography variant="caption" color="text.secondary">
              Ranked by MASE on {primary.backtest.origins} rolling backtest{primary.backtest.origins === 1 ? '' : 's'} of {primary.backtest.horizon} steps. Lower is better; below 1 beats a naive forecast.
            </Typography>
          )}
        </Stack>
      }
    >
      <Chip
        size="small"
        variant="outlined"
        color={acc?.color ?? 'warning'}
        icon={primary ? <AutoGraphIcon sx={{ fontSize: '14px !important' }} /> : <WarningAmberIcon sx={{ fontSize: '14px !important' }} />}
        label={primary ? primary.label : 'Forecast'}
        sx={{ height: 20, mr: 0.5, fontSize: 11, maxWidth: 160, display: { xs: 'none', sm: 'flex' }, cursor: 'help' }}
      />
    </Tooltip>
  );
}
