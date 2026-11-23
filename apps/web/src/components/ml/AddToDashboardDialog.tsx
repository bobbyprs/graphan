import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Radio, RadioGroup, Stack, TextField } from '@mui/material';
import { api, errorMessage, workspaceStore } from '@/api/client';
import { useDashboards } from '@/api/hooks';
import type { Dashboard, Panel } from '@/api/types';
import { uid } from '@/utils/format';

interface Props {
  open: boolean;
  onClose: () => void;
  panel: Omit<Panel, 'id' | 'gridPos'>;
  timeRange: { from: string; to: string };
}

/** Appends a panel to an existing dashboard (optimistic-lock aware) or creates a new dashboard with it. */
export function AddToDashboardDialog({ open, onClose, panel, timeRange }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: dashboards = [] } = useDashboards();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [dashboardId, setDashboardId] = useState('');
  const [title, setTitle] = useState(panel.title);
  const [newTitle, setNewTitle] = useState('Forecasts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveMode = dashboards.length ? mode : 'new';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let id: string;
      if (effectiveMode === 'new') {
        const p: Panel = { ...panel, title, id: uid('panel'), gridPos: { x: 0, y: 0, w: 24, h: 10 } };
        const d = (await api.post<Dashboard>('/dashboards', { title: newTitle, tags: ['ml'], definition: { panels: [p], variables: [], time: timeRange, timezone: 'browser', graphTooltip: 'shared' } })).data;
        id = d.id;
      } else {
        const d = (await api.get<Dashboard>(`/dashboards/${dashboardId}`)).data;
        const y = Math.max(0, ...d.definition.panels.map((x) => x.gridPos.y + x.gridPos.h));
        const p: Panel = { ...panel, title, id: uid('panel'), gridPos: { x: 0, y, w: 24, h: 10 } };
        await api.put(`/dashboards/${d.id}`, { version: d.version, definition: { ...d.definition, panels: [...d.definition.panels, p] }, message: 'Added forecast panel from ML Studio' });
        id = d.id;
      }
      await qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'dashboards'] });
      await qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'dashboard', id] });
      onClose();
      navigate(`/dashboards/${id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Add forecast to a dashboard</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Panel title" value={title} onChange={(e) => setTitle(e.target.value)} />
          {dashboards.length > 0 && (
            <RadioGroup row value={effectiveMode} onChange={(e) => setMode(e.target.value as 'existing' | 'new')}>
              <FormControlLabel value="existing" control={<Radio size="small" />} label="Existing dashboard" />
              <FormControlLabel value="new" control={<Radio size="small" />} label="New dashboard" />
            </RadioGroup>
          )}
          {effectiveMode === 'existing' ? (
            <TextField select label="Dashboard" value={dashboardId} onChange={(e) => setDashboardId(e.target.value)}>
              {dashboards.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.title}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <TextField label="New dashboard title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !title.trim() || (effectiveMode === 'existing' ? !dashboardId : !newTitle.trim())}>
          Add &amp; open
        </Button>
      </DialogActions>
    </Dialog>
  );
}
