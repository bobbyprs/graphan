import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid2 as Grid,
  IconButton,
  InputAdornment,
  Link,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import LockIcon from '@mui/icons-material/LockOutlined';
import LinkIcon from '@mui/icons-material/Link';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard';
import { useCreateFromTemplate, useDashboards, useDataSources, useDeleteDashboard, useDuplicateDashboard, useTemplates } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import { useCan } from '@/auth/AuthContext';
import { EmptyState, PageHeader, useConfirm } from '@/components/common/misc';
import { relativeTime } from '@/utils/format';

function NewDashboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: templates = [] } = useTemplates();
  const { data: dataSources = [] } = useDataSources();
  const create = useCreateFromTemplate();
  const [templateId, setTemplateId] = useState('blank');
  const [title, setTitle] = useState('');
  const [dsId, setDsId] = useState('');
  const tpl = templates.find((t) => t.id === templateId);
  const eligible = dataSources.filter((d) => tpl?.dataSourceType === 'ANY' || d.type === tpl?.dataSourceType);

  // Switching template clears a stale error and pre-selects the sample data source when there is one
  const selectTemplate = (id: string) => {
    create.reset();
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (id !== 'blank' && !dsId) {
      const sample = dataSources.find((d) => (t?.dataSourceType === 'ANY' || d.type === t?.dataSourceType) && /sample/i.test(d.name));
      if (sample) setDsId(sample.id);
    }
  };

  const submit = async () => {
    const d = await create.mutateAsync({ templateId, dataSourceId: dsId || null, title: title || undefined });
    onClose();
    navigate(`/dashboards/${d.id}`);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New dashboard</DialogTitle>
      <DialogContent>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Start from
        </Typography>
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          {templates.map((t) => (
            <Grid key={t.id} size={{ xs: 12, sm: 4 }}>
              <Card variant="outlined" sx={{ height: '100%', borderColor: t.id === templateId ? 'primary.main' : 'divider', borderWidth: t.id === templateId ? 2 : 1 }}>
                <CardActionArea sx={{ height: '100%', alignItems: 'flex-start' }} onClick={() => selectTemplate(t.id)}>
                  <CardContent>
                    <Typography variant="subtitle1" fontWeight={600}>
                      {t.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {t.description}
                    </Typography>
                    <Stack direction="row" spacing={0.5}>
                      <Chip size="small" label={`${t.panelCount} panels`} />
                      {t.dataSourceType !== 'ANY' && <Chip size="small" variant="outlined" label={t.dataSourceType} />}
                    </Stack>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          ))}
        </Grid>
        <Stack spacing={2}>
          <TextField label="Title" placeholder={tpl?.title} value={title} onChange={(e) => setTitle(e.target.value)} />
          {templateId !== 'blank' && (
            <>
              <Alert severity="info" variant="outlined">
                The <b>{tpl?.title}</b> template is a demo built on the sample database&apos;s tables. To chart your own database (e.g. a UAT/production DB), choose{' '}
                <Link component="button" type="button" onClick={() => selectTemplate('blank')} sx={{ verticalAlign: 'baseline' }}>
                  Blank dashboard
                </Link>{' '}
                and add panels with your own queries.
              </Alert>
              <TextField select label="Data source for template queries" value={dsId} onChange={(e) => { create.reset(); setDsId(e.target.value); }} helperText="Use the data source that contains the sample schema (e.g. Sample Sales DB)">
                {eligible.map((d) => (
                  <MenuItem key={d.id} value={d.id}>
                    {d.name}
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}
          {create.error && <Alert severity="error">{errorMessage(create.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={create.isPending || (templateId !== 'blank' && !dsId)}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DashboardsPage() {
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; id: string } | null>(null);
  const { data = [], isLoading } = useDashboards(search || undefined);
  const can = useCan();
  const del = useDeleteDashboard();
  const dup = useDuplicateDashboard();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();

  return (
    <Box>
      <PageHeader
        title="Dashboards"
        subtitle="Visualize data from any connected database"
        actions={
          can.createDashboards && (
            <>
              {can.explore && (
                <Button variant="outlined" startIcon={<AutoAwesomeIcon />} onClick={() => navigate('/analyze')}>
                  Generate from database
                </Button>
              )}
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
                New dashboard
              </Button>
            </>
          )
        }
      />
      <TextField
        placeholder="Search dashboards"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ mb: 2, width: { xs: '100%', sm: 360 } }}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
      />
      {!isLoading && data.length === 0 ? (
        <EmptyState
          icon={<SpaceDashboardIcon sx={{ fontSize: 48 }} />}
          title="No dashboards yet"
          description="Create a dashboard from scratch or start from a template."
          action={can.createDashboards && <Button variant="contained" onClick={() => setNewOpen(true)}>New dashboard</Button>}
        />
      ) : (
        <Box sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Tags</TableCell>
                <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>Owner</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell width={48} />
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.id} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Link component={RouterLink} to={`/dashboards/${d.id}`} underline="hover" fontWeight={500}>
                        {d.title}
                      </Link>
                      {d.isPrivate && <Tooltip title="Private"><LockIcon sx={{ fontSize: 15 }} color="disabled" /></Tooltip>}
                      {d.shareToken && <Tooltip title="Public link enabled"><LinkIcon sx={{ fontSize: 16 }} color="warning" /></Tooltip>}
                      {d.refreshInterval && <Chip size="small" variant="outlined" label={`⟳ ${d.refreshInterval}`} sx={{ height: 20 }} />}
                    </Stack>
                    {d.description && (
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 480 }}>
                        {d.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
                    <Stack direction="row" spacing={0.5}>{d.tags.map((t) => <Chip key={t} size="small" label={t} />)}</Stack>
                  </TableCell>
                  <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{d.owner.name}</TableCell>
                  <TableCell>{relativeTime(d.updatedAt)}</TableCell>
                  <TableCell>
                    <IconButton onClick={(e) => setMenu({ el: e.currentTarget, id: d.id })} aria-label="Dashboard actions">
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => (navigate(`/dashboards/${menu!.id}`), setMenu(null))}>Open</MenuItem>
        {can.createDashboards && (
          <MenuItem
            onClick={async () => {
              const d = await dup.mutateAsync(menu!.id);
              setMenu(null);
              navigate(`/dashboards/${d.id}`);
            }}
          >
            Duplicate
          </MenuItem>
        )}
        <MenuItem
          sx={{ color: 'error.main' }}
          onClick={async () => {
            const id = menu!.id;
            setMenu(null);
            if (await confirm('Delete dashboard?', 'This permanently deletes the dashboard and its version history.')) del.mutate(id);
          }}
        >
          Delete
        </MenuItem>
      </Menu>
      {newOpen && <NewDashboardDialog open onClose={() => setNewOpen(false)} />}
      {dialog}
    </Box>
  );
}
