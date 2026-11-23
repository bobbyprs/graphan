import { Box, Chip, IconButton, LinearProgress, Paper, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Inventory2Icon from '@mui/icons-material/Inventory2Outlined';
import { useDeleteMlModel, useMlModels } from '@/api/hooks';
import { EmptyState, useConfirm } from '@/components/common/misc';
import { relativeTime } from '@/utils/format';
import { ALGORITHMS } from './RegressionStudio';

export function ModelRegistry({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: models = [], isLoading } = useMlModels();
  const del = useDeleteMlModel();
  const { confirm, dialog } = useConfirm();
  if (isLoading) return <LinearProgress />;
  if (!models.length)
    return <EmptyState icon={<Inventory2Icon sx={{ fontSize: 48 }} />} title="No trained models yet" description="Every model you train in the Predict tab is saved here so you and your team can reopen it and run what-if predictions." />;

  return (
    <Paper variant="outlined" sx={{ bgcolor: 'surface.panel', overflowX: 'auto' }}>
      {dialog}
      <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow>
            <TableCell>Model</TableCell>
            <TableCell>Target</TableCell>
            <TableCell>Algorithm</TableCell>
            <TableCell align="right">R²</TableCell>
            <TableCell align="right">RMSE</TableCell>
            <TableCell>Data source</TableCell>
            <TableCell>Trained</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {models.map((m) => (
            <TableRow key={m.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
              <TableCell sx={{ fontWeight: 600 }}>{m.name}</TableCell>
              <TableCell>
                <Chip size="small" label={m.target} variant="outlined" />
              </TableCell>
              <TableCell>{ALGORITHMS.find((a) => a.id === m.algorithm)?.label ?? m.algorithm}</TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                <Box component="span" sx={{ color: m.metrics.r2 > 0.7 ? 'success.main' : m.metrics.r2 > 0.3 ? 'warning.main' : 'error.main' }}>
                  {m.metrics.r2.toFixed(3)}
                </Box>
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{m.metrics.rmse.toLocaleString(undefined, { maximumFractionDigits: 3 })}</TableCell>
              <TableCell>{m.dataSource?.name ?? '–'}</TableCell>
              <TableCell>
                <Typography variant="caption" color="text.secondary">
                  {relativeTime(m.createdAt)} · {m.owner.name}
                </Typography>
              </TableCell>
              <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                <Tooltip title="Open">
                  <IconButton size="small" onClick={() => onOpen(m.id)} aria-label="Open model">
                    <OpenInNewIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton size="small" aria-label="Delete model" onClick={async () => (await confirm(`Delete “${m.name}”?`, 'Predictions using this model will stop working.')) && del.mutate(m.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
