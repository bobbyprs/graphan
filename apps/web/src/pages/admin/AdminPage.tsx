import { useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import { errorMessage } from '@/api/client';
import { useAdminMutations, useAudit, useMembers, useTeams } from '@/api/hooks';
import type { Role } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader, useConfirm } from '@/components/common/misc';
import { relativeTime } from '@/utils/format';

const ROLES: { role: Role; desc: string }[] = [
  { role: 'ADMIN', desc: 'Everything incl. users, teams & audit' },
  { role: 'DEVELOPER', desc: 'Manage data sources, alerts, all dashboards; write queries' },
  { role: 'ANALYST', desc: 'Explore & query data, build dashboards' },
  { role: 'VIEWER', desc: 'View dashboards and alerts' },
];

function MembersTab() {
  const { data = [] } = useMembers();
  const m = useAdminMutations();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'VIEWER' as Role });
  const [temp, setTemp] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  return (
    <>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
        <Button variant="contained" startIcon={<PersonAddIcon />} onClick={() => setOpen(true)}>Add member</Button>
      </Stack>
      {temp && (
        <Alert severity="success" onClose={() => setTemp(null)} sx={{ mb: 1 }}>
          User created. One-time temporary password: <code>{temp}</code> — share it securely; ask the user to change it after signing in.
        </Alert>
      )}
      <Paper sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead><TableRow><TableCell>User</TableCell><TableCell>Role</TableCell><TableCell>Last login</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {data.map((mb) => (
              <TableRow key={mb.id}>
                <TableCell>
                  <Typography variant="body2" fontWeight={500}>{mb.user.name} {!mb.user.isActive && <Chip size="small" label="disabled" />}</Typography>
                  <Typography variant="caption" color="text.secondary">{mb.user.email}</Typography>
                </TableCell>
                <TableCell>
                  <TextField select value={mb.role} onChange={(e) => m.setRole.mutate({ userId: mb.user.id, role: e.target.value as Role })} disabled={mb.user.id === user?.id} sx={{ minWidth: 140 }}>
                    {ROLES.map((r) => <MenuItem key={r.role} value={r.role}>{r.role}</MenuItem>)}
                  </TextField>
                </TableCell>
                <TableCell>{relativeTime(mb.user.lastLoginAt)}</TableCell>
                <TableCell align="right">
                  {mb.user.id !== user?.id && (
                    <IconButton aria-label="Remove member" onClick={async () => (await confirm(`Remove ${mb.user.name} from workspace?`)) && m.removeMember.mutate(mb.user.id)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      {(m.setRole.error || m.removeMember.error) && <Alert severity="error" sx={{ mt: 1 }}>{errorMessage(m.setRole.error ?? m.removeMember.error)}</Alert>}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add member</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <TextField label="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <MenuItem key={r.role} value={r.role}>
                  <Box><Typography variant="body2">{r.role}</Typography><Typography variant="caption" color="text.secondary">{r.desc}</Typography></Box>
                </MenuItem>
              ))}
            </TextField>
            {m.addMember.error && <Alert severity="error">{errorMessage(m.addMember.error)}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={async () => {
              const r = await m.addMember.mutateAsync(form);
              if (r.tempPassword) setTemp(r.tempPassword);
              setOpen(false);
              setForm({ email: '', name: '', role: 'VIEWER' });
            }}
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>
      {dialog}
    </>
  );
}

function TeamsTab() {
  const { data: teams = [] } = useTeams();
  const { data: members = [] } = useMembers();
  const m = useAdminMutations();
  const [name, setName] = useState('');
  const users = members.map((x) => x.user);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1}>
        <TextField label="New team name" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="contained" startIcon={<GroupAddIcon />} disabled={!name} onClick={async () => { await m.createTeam.mutateAsync({ name }); setName(''); }}>Create team</Button>
      </Stack>
      {m.createTeam.error && <Alert severity="error">{errorMessage(m.createTeam.error)}</Alert>}
      {teams.map((t) => (
        <Paper key={t.id} sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>{t.name}</Typography>
            <IconButton aria-label="Delete team" onClick={() => m.deleteTeam.mutate(t.id)}><DeleteIcon fontSize="small" /></IconButton>
          </Stack>
          <Autocomplete
            multiple
            options={users}
            getOptionLabel={(u) => `${u.name} (${u.email})`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            value={users.filter((u) => t.members.some((tm) => tm.user.id === u.id))}
            onChange={(_e, v) => m.setTeamMembers.mutate({ id: t.id, userIds: v.map((u) => u.id) })}
            renderInput={(p) => <TextField {...p} label="Members" />}
          />
        </Paper>
      ))}
    </Stack>
  );
}

function AuditTab() {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [action, setAction] = useState('');
  const { data } = useAudit({ action, page, pageSize });
  return (
    <Paper sx={{ overflowX: 'auto' }}>
      <Box sx={{ p: 1 }}>
        <TextField placeholder="Filter by action (e.g. datasource, dashboard.update)" value={action} onChange={(e) => (setAction(e.target.value), setPage(0))} sx={{ width: { xs: '100%', sm: 400 } }} />
      </Box>
      <Table size="small">
        <TableHead><TableRow><TableCell>Time</TableCell><TableCell>User</TableCell><TableCell>Action</TableCell><TableCell>Entity</TableCell><TableCell>Details</TableCell><TableCell>IP</TableCell></TableRow></TableHead>
        <TableBody>
          {data?.items.map((a) => (
            <TableRow key={a.id}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(a.createdAt).toLocaleString()}</TableCell>
              <TableCell>{a.user?.name ?? 'system'}</TableCell>
              <TableCell><Chip size="small" label={a.action} color={a.action.includes('fail') || a.action.includes('delete') ? 'warning' : 'default'} /></TableCell>
              <TableCell><code>{a.entityType}{a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}</code></TableCell>
              <TableCell sx={{ maxWidth: 320, fontFamily: 'monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.metadata ? JSON.stringify(a.metadata) : ''}</TableCell>
              <TableCell>{a.ip}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePagination
        component="div"
        count={data?.total ?? 0}
        page={page}
        rowsPerPage={pageSize}
        onPageChange={(_e, p) => setPage(p)}
        onRowsPerPageChange={(e) => (setPageSize(Number(e.target.value)), setPage(0))}
        rowsPerPageOptions={[25, 50, 100]}
      />
    </Paper>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState(0);
  return (
    <Box>
      <PageHeader title="Administration" subtitle="Workspace members, roles, teams and audit trail" />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Members & roles" />
        <Tab label="Teams" />
        <Tab label="Audit log" />
      </Tabs>
      {tab === 0 && <MembersTab />}
      {tab === 1 && <TeamsTab />}
      {tab === 2 && <AuditTab />}
    </Box>
  );
}
