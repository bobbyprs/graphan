import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import axios from 'axios';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Alert, Box, CircularProgress } from '@mui/material';
import { EMBED_TOKEN, embedStore, errorMessage } from '@/api/client';
import { useAuth, useCan } from '@/auth/AuthContext';
import { AppShell } from '@/layouts/AppShell';
import { LoginPage } from '@/pages/LoginPage';

// Route-level code splitting keeps Monaco / AG Grid / ECharts out of the initial bundle
const DashboardsPage = lazy(() => import('@/pages/DashboardsPage').then((m) => ({ default: m.DashboardsPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const DataSourcesPage = lazy(() => import('@/pages/DataSourcesPage').then((m) => ({ default: m.DataSourcesPage })));
const ExplorePage = lazy(() => import('@/pages/ExplorePage').then((m) => ({ default: m.ExplorePage })));
const AlertsPage = lazy(() => import('@/pages/AlertsPage').then((m) => ({ default: m.AlertsPage })));
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const ReportViewerPage = lazy(() => import('@/pages/ReportViewerPage').then((m) => ({ default: m.ReportViewerPage })));
const ReportDesignerPage = lazy(() => import('@/pages/ReportDesignerPage').then((m) => ({ default: m.ReportDesignerPage })));
const SmartBuilderPage = lazy(() => import('@/pages/SmartBuilderPage').then((m) => ({ default: m.SmartBuilderPage })));
const MlStudioPage = lazy(() => import('@/pages/MlStudioPage').then((m) => ({ default: m.MlStudioPage })));
const AdminPage = lazy(() => import('@/pages/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

const Loading = () => (
  <Box sx={{ display: 'grid', placeItems: 'center', height: '60vh' }}>
    <CircularProgress size={28} />
  </Box>
);

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function RequireCan({ check, children }: { check: keyof ReturnType<typeof useCan>; children: ReactNode }) {
  const can = useCan();
  return can[check] ? <>{children}</> : <Navigate to="/" replace />;
}

function PublicDashboard() {
  const { token } = useParams();
  return (
    <Box sx={{ p: 2 }}>
      <DashboardPage publicToken={token} />
    </Box>
  );
}

/**
 * Dashboard embedded in another application (iframe). The URL carries a short-lived token signed by
 * that application's backend; we exchange it once for an embed session and use that for all requests.
 * Options (query string): ?titled=false hides the title row, ?controls=false hides time/refresh pickers.
 */
function EmbeddedDashboard() {
  const { token } = useParams();
  const [state, setState] = useState<{ ready: boolean; error?: string }>({ ready: false });
  useEffect(() => {
    let cancelled = false;
    axios
      .post<{ sessionToken: string }>('/api/embed/session', { token })
      .then((r) => {
        embedStore.set(r.data.sessionToken);
        if (!cancelled) setState({ ready: true });
      })
      .catch((e) => !cancelled && setState({ ready: false, error: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [token]);
  if (state.error) return <Alert severity="error" sx={{ m: 2 }}>{state.error}</Alert>;
  if (!state.ready) return <Loading />;
  return (
    <Box sx={{ p: 1.5 }}>
      <DashboardPage publicToken={EMBED_TOKEN} />
    </Box>
  );
}

/** Paginated report embedded in another application (signed token, same flow as dashboards). */
function EmbeddedReport() {
  const { token } = useParams();
  const [state, setState] = useState<{ ready: boolean; error?: string }>({ ready: false });
  useEffect(() => {
    let cancelled = false;
    axios
      .post<{ sessionToken: string }>('/api/embed/session', { token })
      .then((r) => {
        embedStore.set(r.data.sessionToken);
        if (!cancelled) setState({ ready: true });
      })
      .catch((e) => !cancelled && setState({ ready: false, error: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [token]);
  if (state.error) return <Alert severity="error" sx={{ m: 2 }}>{state.error}</Alert>;
  if (!state.ready) return <Loading />;
  return (
    <Box sx={{ p: 1.5 }}>
      <ReportViewerPage embedded />
    </Box>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/public/:token" element={<PublicDashboard />} />
          <Route path="/embed/dashboard/:token" element={<EmbeddedDashboard />} />
          <Route path="/embed/report/:token" element={<EmbeddedReport />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardsPage />} />
            <Route path="dashboards/:id" element={<DashboardPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:id" element={<ReportViewerPage />} />
            <Route path="reports/:id/edit" element={<RequireCan check="createDashboards"><ReportDesignerPage /></RequireCan>} />
            <Route path="datasources" element={<DataSourcesPage />} />
            <Route path="explore" element={<RequireCan check="explore"><ExplorePage /></RequireCan>} />
            <Route path="analyze" element={<RequireCan check="explore"><SmartBuilderPage /></RequireCan>} />
            <Route path="ml" element={<RequireCan check="explore"><MlStudioPage /></RequireCan>} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="alerts/:id" element={<AlertsPage />} />
            <Route path="admin" element={<RequireCan check="admin"><AdminPage /></RequireCan>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
