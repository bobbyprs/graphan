import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Divider,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/api/client';
import { useDashboardVersions, useDataSources, useMembers, useTeams } from '@/api/hooks';
import type { Dashboard, PermissionLevel, Variable } from '@/api/types';

export interface DashboardMeta {
  title: string;
  description?: string | null;
  tags: string[];
  refreshInterval?: string | null;
  scheduleCron?: string | null;
  isPrivate: boolean;
  variables: Variable[];
}

interface Props {
  open: boolean;
  dashboard: Dashboard;
  meta: DashboardMeta;
  onClose: () => void;
  onApply: (m: DashboardMeta) => void;
}

function VariableEditor({ variables, onChange }: { variables: Variable[]; onChange: (v: Variable[]) => void }) {
  const { data: dataSources = [] } = useDataSources();
  const upd = (i: number, patch: Partial<Variable>) => onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <Stack spacing={2}>
      {variables.map((v, i) => (
        <Box key={i} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField label="Name" value={v.name} onChange={(e) => upd(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} helperText={`Use as \${${v.name || 'name'}}`} />
            <TextField label="Label" value={v.label ?? ''} onChange={(e) => upd(i, { label: e.target.value || undefined })} />
            <TextField select label="Type" value={v.type} onChange={(e) => upd(i, { type: e.target.value as Variable['type'] })} sx={{ minWidth: 130 }}>
              <MenuItem value="query">Query</MenuItem>
              <MenuItem value="custom">Custom list</MenuItem>
              <MenuItem value="textbox">Text box</MenuItem>
              <MenuItem value="interval">Interval</MenuItem>
            </TextField>
            <IconButton onClick={() => onChange(variables.filter((_x, j) => j !== i))} aria-label="Remove variable">
              <DeleteIcon />
            </IconButton>
          </Stack>
          {v.type === 'query' && (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField select label="Data source" value={v.dataSourceId ?? ''} onChange={(e) => upd(i, { dataSourceId: e.target.value })}>
                {dataSources.map((d) => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="Query (first column = values)" value={v.query ?? ''} onChange={(e) => upd(i, { query: e.target.value })} multiline InputProps={{ sx: { fontFamily: 'monospace' } }} />
            </Stack>
          )}
          {(v.type === 'custom' || v.type === 'interval') && (
            <TextField
              sx={{ mt: 1 }}
              fullWidth
              label="Values (comma separated)"
              placeholder={v.type === 'interval' ? '1m,5m,1h,1d' : 'a,b,c'}
              value={(v.options ?? []).join(',')}
              onChange={(e) => upd(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          )}
          {v.type !== 'textbox' && (
            <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
              <FormControlLabel control={<Switch checked={v.multi} onChange={(e) => upd(i, { multi: e.target.checked })} />} label="Multi-value" />
              <FormControlLabel
                control={<Switch checked={v.includeAll} onChange={(e) => upd(i, { includeAll: e.target.checked, default: e.target.checked ? ['$__all'] : undefined })} />}
                label='Include "All"'
              />
            </Stack>
          )}
        </Box>
      ))}
      <Box>
        <Button startIcon={<AddIcon />} onClick={() => onChange([...variables, { name: `var${variables.length + 1}`, type: 'custom', options: [], multi: false, includeAll: false }])}>
          Add variable
        </Button>
      </Box>
    </Stack>
  );
}

function PermissionsEditor({ dashboard }: { dashboard: Dashboard }) {
  const { data: members = [] } = useMembers();
  const { data: teams = [] } = useTeams();
  const [grants, setGrants] = useState(dashboard.permissions ?? []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    try {
      await api.put(`/dashboards/${dashboard.id}/permissions`, { grants: grants.map((g) => ({ userId: g.userId ?? undefined, teamId: g.teamId ?? undefined, level: g.level })) });
      setMsg({ ok: true, text: 'Permissions saved' });
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  };
  if (dashboard.access !== 'ADMIN') return <Alert severity="info">Only dashboard admins can manage permissions.</Alert>;
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Workspace Admins/Developers can always manage this dashboard. Non-private dashboards are viewable by every workspace member.
      </Typography>
      {grants.map((g, i) => (
        <Stack key={i} direction="row" spacing={1}>
          <TextField
            select
            label="User or team"
            value={g.userId ? `u:${g.userId}` : `t:${g.teamId}`}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(':');
              setGrants(grants.map((x, j) => (j === i ? { ...x, userId: kind === 'u' ? id : null, teamId: kind === 't' ? id : null } : x)));
            }}
            sx={{ flex: 1 }}
          >
            {teams.map((t) => (
              <MenuItem key={t.id} value={`t:${t.id}`}>
                Team · {t.name}
              </MenuItem>
            ))}
            {members.map((m) => (
              <MenuItem key={m.user.id} value={`u:${m.user.id}`}>
                {m.user.name} ({m.user.email})
              </MenuItem>
            ))}
          </TextField>
          <TextField select label="Level" value={g.level} onChange={(e) => setGrants(grants.map((x, j) => (j === i ? { ...x, level: e.target.value as PermissionLevel } : x)))} sx={{ width: 120 }}>
            {['VIEW', 'EDIT', 'ADMIN'].map((l) => (
              <MenuItem key={l} value={l}>
                {l}
              </MenuItem>
            ))}
          </TextField>
          <IconButton onClick={() => setGrants(grants.filter((_x, j) => j !== i))} aria-label="Remove grant">
            <DeleteIcon />
          </IconButton>
        </Stack>
      ))}
      <Stack direction="row" spacing={1}>
        <Button
          startIcon={<AddIcon />}
          disabled={!members.length && !teams.length}
          onClick={() => setGrants([...grants, { id: String(Math.random()), teamId: teams[0]?.id ?? null, userId: teams[0] ? null : members[0]?.user.id, level: 'VIEW' }])}
        >
          Add grant
        </Button>
        <Button variant="contained" onClick={save}>
          Save permissions
        </Button>
      </Stack>
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  );
}

function SharingPanel({ dashboard }: { dashboard: Dashboard }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(dashboard.shareToken ?? null);
  const [err, setErr] = useState<string | null>(null);
  const url = token ? `${window.location.origin}/public/${token}` : '';
  const toggle = async (enabled: boolean) => {
    try {
      const r = await api.post<{ shareToken: string | null }>(`/dashboards/${dashboard.id}/share`, { enabled });
      setToken(r.data.shareToken);
      qc.invalidateQueries();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  return (
    <Stack spacing={2}>
      <FormControlLabel control={<Switch checked={!!token} onChange={(e) => toggle(e.target.checked)} disabled={dashboard.access !== 'ADMIN'} />} label="Public read-only link" />
      <Typography variant="body2" color="text.secondary">
        Anyone with the link can view this dashboard without signing in. Only saved panel queries run; viewers cannot change SQL. Disable to revoke the link instantly.
      </Typography>
      {token && (
        <Stack direction="row" spacing={1}>
          <TextField value={url} fullWidth InputProps={{ readOnly: true }} />
          <IconButton onClick={() => navigator.clipboard.writeText(url)} aria-label="Copy link">
            <ContentCopyIcon />
          </IconButton>
        </Stack>
      )}
      {err && <Alert severity="error">{err}</Alert>}
      <Divider />
      <EmbedPanel dashboard={dashboard} />
    </Stack>
  );
}

function EmbedPanel({ dashboard }: { dashboard: Dashboard }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(!!dashboard.embedEnabled);
  const [err, setErr] = useState<string | null>(null);
  const vars = dashboard.definition.variables.map((v) => v.name);
  const toggle = async (on: boolean) => {
    try {
      const r = await api.post<{ embedEnabled: boolean }>(`/dashboards/${dashboard.id}/embed`, { enabled: on });
      setEnabled(r.data.embedEnabled);
      qc.invalidateQueries();
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const snippet = `// In your application's BACKEND (Node example; any JWT library works)
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  {
    resource: { dashboard: '${dashboard.id}' },
    params: { ${vars.length ? `${vars[0]}: currentUser.${vars[0]}` : '/* locked variables, e.g. tenant_id: user.tenantId */'} },
    user: currentUser.email,                          // optional, shown in Graphan audit log
    exp: Math.floor(Date.now() / 1000) + 10 * 60,     // 10 minutes (max 1 hour)
  },
  process.env.GRAPHAN_EMBED_SECRET,                 // same value as Graphan's EMBED_SECRET
);
const iframeUrl = '${window.location.origin}/embed/dashboard/' + token;

// In your page:
// <iframe src={iframeUrl} width="100%" height="800" frameborder="0"></iframe>`;
  return (
    <Stack spacing={2}>
      <FormControlLabel control={<Switch checked={enabled} onChange={(e) => toggle(e.target.checked)} disabled={dashboard.access !== 'ADMIN'} />} label="Embed in other applications (signed)" />
      <Typography variant="body2" color="text.secondary">
        Your application signs a short-lived token with the server&apos;s <code>EMBED_SECRET</code>, so only users your app has logged in can view the dashboard.
        Variables passed in <code>params</code> are locked and hidden from the viewer, so you can use them to restrict rows (e.g. <code>WHERE tenant_id = $&#123;tenant_id&#125;</code>).
      </Typography>
      {enabled && (
        <>
          <Typography variant="caption" color="text.secondary">
            Dashboard ID: <code>{dashboard.id}</code>
            {vars.length > 0 && <> · Variables: {vars.map((v) => <code key={v}>{v} </code>)}</>}
          </Typography>
          <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', fontSize: 12, overflow: 'auto' }}>
            {snippet}
          </Box>
          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => navigator.clipboard.writeText(snippet)}>
              Copy example
            </Button>
          </Stack>
        </>
      )}
      {err && <Alert severity="error">{err}</Alert>}
    </Stack>
  );
}

function VersionsPanel({ dashboard, open }: { dashboard: Dashboard; open: boolean }) {
  const qc = useQueryClient();
  const { data = [] } = useDashboardVersions(dashboard.id, open);
  const restore = async (v: number) => {
    await api.post(`/dashboards/${dashboard.id}/versions/${v}/restore`);
    qc.invalidateQueries();
  };
  return (
    <List dense>
      {data.map((v) => (
        <ListItem
          key={v.id}
          secondaryAction={
            v.version !== dashboard.version && dashboard.access !== 'VIEW' ? (
              <Button size="small" onClick={() => restore(v.version)}>
                Restore
              </Button>
            ) : (
              <Typography variant="caption">current</Typography>
            )
          }
        >
          <ListItemText primary={`Version ${v.version}${v.message ? ` — ${v.message}` : ''}`} secondary={new Date(v.createdAt).toLocaleString()} />
        </ListItem>
      ))}
    </List>
  );
}

export function DashboardSettingsDialog({ open, dashboard, meta, onClose, onApply }: Props) {
  const [tab, setTab] = useState(0);
  const [m, setM] = useState(meta);
  useEffect(() => {
    if (open) setM(meta);
  }, [open, meta]);
  const editable = dashboard.access !== 'VIEW';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Dashboard settings</DialogTitle>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }} variant="scrollable">
        <Tab label="General" />
        <Tab label="Variables" />
        <Tab label="Permissions" />
        <Tab label="Sharing" />
        <Tab label="Versions" />
      </Tabs>
      <DialogContent sx={{ minHeight: 380 }}>
        {tab === 0 && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Title" value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} disabled={!editable} />
            <TextField label="Description" value={m.description ?? ''} onChange={(e) => setM({ ...m, description: e.target.value })} multiline minRows={2} disabled={!editable} />
            <TextField
              label="Tags (comma separated)"
              value={m.tags.join(', ')}
              onChange={(e) => setM({ ...m, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
              disabled={!editable}
            />
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Default auto-refresh"
                value={m.refreshInterval ?? ''}
                onChange={(e) => setM({ ...m, refreshInterval: e.target.value || null })}
                sx={{ minWidth: 200 }}
                disabled={!editable}
              >
                <MenuItem value="">Off</MenuItem>
                {['10s', '30s', '1m', '5m', '15m', '1h'].map((r) => (
                  <MenuItem key={r} value={r}>
                    {r}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Scheduled refresh (cron)"
                placeholder="*/5 * * * *"
                helperText="Server pre-warms panel caches and notifies viewers"
                value={m.scheduleCron ?? ''}
                onChange={(e) => setM({ ...m, scheduleCron: e.target.value || null })}
                sx={{ flex: 1 }}
                disabled={!editable}
              />
            </Stack>
            <FormControlLabel
              control={<Switch checked={m.isPrivate} onChange={(e) => setM({ ...m, isPrivate: e.target.checked })} disabled={!editable} />}
              label="Private (only owner, explicit grants and admins)"
            />
          </Stack>
        )}
        {tab === 1 && <VariableEditor variables={m.variables} onChange={(variables) => setM({ ...m, variables })} />}
        {tab === 2 && <PermissionsEditor dashboard={dashboard} />}
        {tab === 3 && <SharingPanel dashboard={dashboard} />}
        {tab === 4 && <VersionsPanel dashboard={dashboard} open={open && tab === 4} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {(tab === 0 || tab === 1) && editable && (
          <Button variant="contained" onClick={() => onApply(m)}>
            Apply
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
