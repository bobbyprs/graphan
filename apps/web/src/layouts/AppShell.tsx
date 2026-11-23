import { useCallback, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Alert,
  AppBar,
  Avatar,
  Badge,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboardOutlined';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import StorageIcon from '@mui/icons-material/StorageOutlined';
import PsychologyIcon from '@mui/icons-material/PsychologyOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesomeOutlined';
import NotificationsIcon from '@mui/icons-material/NotificationsOutlined';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import { api, errorMessage } from '@/api/client';
import { useAlertRules } from '@/api/hooks';
import { useSocketEvent } from '@/api/socket';
import { useAuth, useCan } from '@/auth/AuthContext';
import { useThemeMode } from '@/theme/ThemeModeProvider';

const WIDE = 220;
const NARROW = 56;

function NavItem({ to, icon, label, collapsed, badge }: { to: string; icon: ReactNode; label: string; collapsed: boolean; badge?: number }) {
  const { pathname } = useLocation();
  const active = to === '/' ? pathname === '/' || pathname.startsWith('/dashboards') : pathname.startsWith(to);
  return (
    <Tooltip title={collapsed ? label : ''} placement="right">
      <ListItemButton
        component={NavLink}
        to={to}
        selected={active}
        sx={{
          mx: 1,
          my: 0.25,
          borderRadius: 1,
          minHeight: 38,
          px: collapsed ? 1.25 : 1.5,
          '&.Mui-selected': { bgcolor: 'action.selected', '&::before': { content: '""', position: 'absolute', left: -8, top: 6, bottom: 6, width: 3, borderRadius: 2, bgcolor: 'secondary.main' } },
        }}
      >
        <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36 }}>
          <Badge color="error" badgeContent={badge} invisible={!badge}>
            {icon}
          </Badge>
        </ListItemIcon>
        {!collapsed && <ListItemText primary={label} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 600 : 400 }} />}
      </ListItemButton>
    </Tooltip>
  );
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Change password</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField type="password" label="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          <TextField type="password" label="New password" value={next} onChange={(e) => setNext(e.target.value)} helperText="10+ chars with upper, lower, number & symbol" autoComplete="new-password" />
          {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          onClick={async () => {
            try {
              await api.post('/auth/change-password', { currentPassword: cur, newPassword: next });
              setMsg({ ok: true, text: 'Password changed. Other sessions were signed out.' });
            } catch (e) {
              setMsg({ ok: false, text: errorMessage(e) });
            }
          }}
        >
          Change
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AppShell() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const [wsMenu, setWsMenu] = useState<HTMLElement | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [alertToast, setAlertToast] = useState<{ name: string; to: string; message: string } | null>(null);
  const { user, logout, workspaceId, switchWorkspace, role } = useAuth();
  const can = useCan();
  const { mode, toggle } = useThemeMode();
  const { data: rules } = useAlertRules();
  const firing = rules?.filter((r) => r.state === 'FIRING').length ?? 0;

  useSocketEvent<{ name: string; to: string; message: string }>(
    'alert:state',
    useCallback((e) => (e.to === 'FIRING' || e.to === 'OK') && setAlertToast(e), []),
  );

  const ws = user?.memberships.find((m) => m.workspace.id === workspaceId)?.workspace;
  const width = isMobile ? WIDE : collapsed ? NARROW : WIDE;
  const narrow = !isMobile && collapsed;

  const nav = (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'surface.nav' }} onClick={() => isMobile && setMobileOpen(false)}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: narrow ? 1.5 : 2, height: 52 }}>
        <img src="/favicon.svg" width={28} height={28} alt="Graphan" />
        {!narrow && <Typography variant="h6" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>Graphan</Typography>}
      </Stack>
      <Divider />
      <List sx={{ flex: 1, pt: 1 }}>
        <NavItem to="/" icon={<SpaceDashboardIcon />} label="Dashboards" collapsed={narrow} />
        <NavItem to="/reports" icon={<DescriptionIcon />} label="Reports" collapsed={narrow} />
        {can.explore && <NavItem to="/explore" icon={<TravelExploreIcon />} label="Explore" collapsed={narrow} />}
        {can.explore && <NavItem to="/analyze" icon={<AutoAwesomeIcon />} label="Smart builder" collapsed={narrow} />}
        {can.explore && <NavItem to="/ml" icon={<PsychologyIcon />} label="ML Studio" collapsed={narrow} />}
        <NavItem to="/datasources" icon={<StorageIcon />} label="Data sources" collapsed={narrow} />
        <NavItem to="/alerts" icon={<NotificationsIcon />} label="Alerting" collapsed={narrow} badge={firing} />
        {can.admin && <NavItem to="/admin" icon={<AdminPanelSettingsIcon />} label="Administration" collapsed={narrow} />}
      </List>
      {!isMobile && (
        <Box sx={{ p: 1, display: 'flex', justifyContent: narrow ? 'center' : 'flex-end' }}>
          <IconButton onClick={() => setCollapsed((c) => !c)} aria-label="Toggle navigation">
            <ChevronLeftIcon sx={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </IconButton>
        </Box>
      )}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Drawer
        variant={isMobile ? 'temporary' : 'permanent'}
        open={isMobile ? mobileOpen : true}
        onClose={() => setMobileOpen(false)}
        sx={{ width, flexShrink: 0, '& .MuiDrawer-paper': { width, boxSizing: 'border-box', borderRight: 1, borderColor: 'divider', transition: 'width .2s', overflowX: 'hidden' } }}
      >
        {nav}
      </Drawer>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar position="sticky" color="inherit" elevation={0} sx={{ bgcolor: 'background.default' }}>
          <Toolbar variant="dense" sx={{ gap: 1, minHeight: 52 }}>
            {isMobile && (
              <IconButton onClick={() => setMobileOpen(true)} aria-label="Open navigation">
                <MenuIcon />
              </IconButton>
            )}
            <Button color="inherit" endIcon={<UnfoldMoreIcon fontSize="small" />} onClick={(e) => setWsMenu(e.currentTarget)} sx={{ fontWeight: 600 }}>
              {ws?.name ?? 'No workspace'}
            </Button>
            {role && <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>{role}</Typography>}
            <Box sx={{ flex: 1 }} />
            <Tooltip title={mode === 'dark' ? 'Light theme' : 'Dark theme'}>
              <IconButton onClick={toggle} aria-label="Toggle theme">{mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}</IconButton>
            </Tooltip>
            <IconButton onClick={(e) => setUserMenu(e.currentTarget)} aria-label="Account">
              <Avatar sx={{ width: 28, height: 28, fontSize: 13, bgcolor: 'secondary.main' }}>{user?.name.slice(0, 1).toUpperCase()}</Avatar>
            </IconButton>
          </Toolbar>
        </AppBar>
        <Box component="main" sx={{ flex: 1, p: { xs: 1.5, sm: 2 }, minWidth: 0 }}>
          <Outlet />
        </Box>
      </Box>

      <Menu anchorEl={wsMenu} open={!!wsMenu} onClose={() => setWsMenu(null)}>
        {user?.memberships.map((m) => (
          <MenuItem key={m.workspace.id} selected={m.workspace.id === workspaceId} onClick={() => (switchWorkspace(m.workspace.id), setWsMenu(null))}>
            <ListItemText primary={m.workspace.name} secondary={m.role} />
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={userMenu} open={!!userMenu} onClose={() => setUserMenu(null)}>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{user?.name}</Typography>
          <Typography variant="caption" color="text.secondary">{user?.email}</Typography>
        </Box>
        <Divider />
        <MenuItem onClick={() => (setPwOpen(true), setUserMenu(null))}>Change password</MenuItem>
        <MenuItem onClick={() => (setUserMenu(null), logout())}>Sign out</MenuItem>
      </Menu>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
      <Snackbar open={!!alertToast} autoHideDuration={6000} onClose={() => setAlertToast(null)} anchorOrigin={{ vertical: 'top', horizontal: 'right' }}>
        {alertToast ? (
          <Alert severity={alertToast.to === 'FIRING' ? 'error' : 'success'} variant="filled" onClose={() => setAlertToast(null)}>
            <b>{alertToast.name}</b> is {alertToast.to}: {alertToast.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
