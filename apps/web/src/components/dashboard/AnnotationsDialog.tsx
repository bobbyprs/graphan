import { useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { useAnnotations, useAnnotationMutations } from '@/api/hooks';
import { errorMessage } from '@/api/client';

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16); // yyyy-MM-ddThh:mm for datetime-local
};

/** Manage Grafana-style annotations for a dashboard: add a marker, review and delete. */
export function AnnotationsDialog({ dashboardId, onClose }: { dashboardId: string; onClose: () => void }) {
  const { data: annotations = [] } = useAnnotations(dashboardId);
  const m = useAnnotationMutations(dashboardId);
  const [time, setTime] = useState(nowLocal());
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');

  const add = async () => {
    await m.create.mutateAsync({
      time: new Date(time).toISOString(),
      text: text.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setText('');
    setTags('');
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Annotations</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Mark an event (a deploy, incident, campaign…). It appears as a dashed marker on this dashboard&apos;s time-series panels.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              label="Time"
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 210 }}
            />
            <TextField label="Note" value={text} onChange={(e) => setText(e.target.value)} fullWidth placeholder="e.g. Deployed v2.3" />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField label="Tags (comma separated)" value={tags} onChange={(e) => setTags(e.target.value)} fullWidth placeholder="deploy, release" />
            <Button variant="contained" onClick={add} disabled={!text.trim() || m.create.isPending}>
              Add
            </Button>
          </Stack>
          {m.create.error && <Alert severity="error">{errorMessage(m.create.error)}</Alert>}
          {m.remove.error && <Alert severity="error">{errorMessage(m.remove.error)}</Alert>}

          <List dense sx={{ maxHeight: 280, overflow: 'auto' }}>
            {annotations.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
                No annotations yet.
              </Typography>
            )}
            {annotations.map((a) => (
              <ListItem
                key={a.id}
                secondaryAction={
                  <IconButton edge="end" aria-label="Delete annotation" onClick={() => m.remove.mutate(a.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={a.text}
                  secondary={
                    <>
                      {new Date(a.time).toLocaleString()}
                      {a.tags.map((t) => (
                        <Chip key={t} label={t} size="small" sx={{ ml: 0.5, height: 18 }} />
                      ))}
                    </>
                  }
                />
              </ListItem>
            ))}
          </List>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
