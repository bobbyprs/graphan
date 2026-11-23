import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Dialog, IconButton, Snackbar, Stack, Tooltip, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import AddchartIcon from '@mui/icons-material/Addchart';
import SettingsIcon from '@mui/icons-material/Settings';
import CloseIcon from '@mui/icons-material/Close';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import { AnnotationsDialog } from '@/components/dashboard/AnnotationsDialog';
import { useDashboard, useUpdateDashboard } from '@/api/hooks';
import { EMBED_TOKEN, errorMessage, workspaceStore } from '@/api/client';
import { useDashboardRoom, useSocketConnected, useSocketEvent } from '@/api/socket';
import type { Dashboard, DashboardDefinition, Panel } from '@/api/types';
import { DashboardGrid } from '@/components/dashboard/DashboardGrid';
import { PanelFrame } from '@/components/dashboard/PanelFrame';
import { PanelEditor } from '@/components/dashboard/PanelEditor';
import { RefreshPicker, TimeRangePicker } from '@/components/dashboard/TimeControls';
import { ALL, resolveVariableValues, VariablesBar, type VarValues } from '@/components/dashboard/VariablesBar';
import { DashboardSettingsDialog, type DashboardMeta } from '@/components/dashboard/DashboardSettingsDialog';
import { refreshToMs } from '@/utils/time';
import { uid } from '@/utils/format';

function panelSignature(p?: Panel) {
  return p ? JSON.stringify([p.dataSourceId, p.query, p.transforms]) : '';
}

export function DashboardPage({ publicToken }: { publicToken?: string }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: dashboard, error, isLoading } = useDashboard(publicToken ? undefined : id, publicToken);
  const dashboardId = dashboard?.id ?? id ?? '';
  const update = useUpdateDashboard(dashboardId);
  const connected = useSocketConnected();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardDefinition | null>(null);
  const [meta, setMeta] = useState<DashboardMeta | null>(null);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [viewPanel, setViewPanel] = useState<Panel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; severity: 'success' | 'error' | 'info' } | null>(null);
  const [varOptions, setVarOptions] = useState<Record<string, string[]>>({});

  const def = draft ?? dashboard?.definition;
  const savedPanels = useMemo(() => new Map(dashboard?.definition.panels.map((p) => [p.id, p]) ?? []), [dashboard]);

  // ── URL-synced state (shareable links, Grafana-style) ──
  const timeRange = useMemo(
    () => ({ from: params.get('from') ?? def?.time.from ?? 'now-6h', to: params.get('to') ?? def?.time.to ?? 'now' }),
    [params, def?.time.from, def?.time.to],
  );
  const refresh = params.get('refresh') ?? dashboard?.refreshInterval ?? 'off';
  const varValues: VarValues = useMemo(() => {
    const out: VarValues = {};
    for (const v of def?.variables ?? []) {
      const fromUrl = params.getAll(`var-${v.name}`);
      out[v.name] = fromUrl.length ? (v.multi ? fromUrl : fromUrl[0]) : (v.default ?? (v.includeAll ? [ALL] : v.multi ? [] : ''));
    }
    return out;
  }, [params, def?.variables]);

  const patchParams = (fn: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    fn(next);
    setParams(next, { replace: true });
  };
  const setVar = (name: string, v: string | string[]) =>
    patchParams((p) => {
      p.delete(`var-${name}`);
      (Array.isArray(v) ? v : [v]).forEach((x) => p.append(`var-${name}`, x));
    });

  const resolvedVars = useMemo(() => resolveVariableValues(def?.variables ?? [], varValues, varOptions), [def?.variables, varValues, varOptions]);
  const ready = useMemo(
    () =>
      (def?.variables ?? []).every((v) => {
        if (dashboard?.lockedParams?.includes(v.name)) return true; // fixed by the embedding app; server supplies the value
        const val = varValues[v.name];
        const usesAll = Array.isArray(val) ? val.includes(ALL) : val === ALL;
        return !usesAll || varOptions[v.name] !== undefined;
      }),
    [def?.variables, varValues, varOptions, dashboard?.lockedParams],
  );
  const onOptions = useCallback((name: string, values: string[]) => setVarOptions((o) => (o[name]?.join() === values.join() ? o : { ...o, [name]: values })), []);

  // ── Live updates ──
  useDashboardRoom(publicToken ? undefined : dashboard?.id);
  useSocketEvent<{ id: string }>(
    'dashboard:refresh',
    useCallback((e) => e.id === dashboard?.id && qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'panel', dashboard.id] }), [dashboard?.id, qc]),
  );
  useSocketEvent<{ id: string; version: number }>(
    'dashboard:updated',
    useCallback(
      (e) => {
        if (e.id !== dashboard?.id || e.version === dashboard.version) return;
        if (editing) setToast({ msg: 'Someone else saved this dashboard. Saving will conflict — reload to merge.', severity: 'info' });
        else qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'dashboard', dashboard.id] });
      },
      [dashboard?.id, dashboard?.version, editing, qc],
    ),
  );

  useEffect(() => {
    if (dashboard) document.title = `${dashboard.title} · Graphan`;
  }, [dashboard]);

  const startEdit = (d: Dashboard) => {
    setDraft(structuredClone(d.definition));
    setMeta({ title: d.title, description: d.description, tags: d.tags, refreshInterval: d.refreshInterval, scheduleCron: d.scheduleCron, isPrivate: d.isPrivate, variables: d.definition.variables });
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(null);
    setMeta(null);
    setEditing(false);
  };

  const save = async () => {
    if (!dashboard || !draft || !meta) return;
    try {
      await update.mutateAsync({
        version: dashboard.version,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        refreshInterval: meta.refreshInterval,
        scheduleCron: meta.scheduleCron,
        isPrivate: meta.isPrivate,
        definition: { ...draft, variables: meta.variables, time: timeRange },
      });
      setToast({ msg: 'Dashboard saved', severity: 'success' });
      cancelEdit();
    } catch (e) {
      setToast({ msg: errorMessage(e), severity: 'error' });
    }
  };

  const mutatePanels = (fn: (panels: Panel[]) => Panel[]) => setDraft((d) => (d ? { ...d, panels: fn(d.panels) } : d));

  const addPanel = () => {
    const maxY = Math.max(0, ...(draft?.panels ?? []).map((p) => p.gridPos.y + p.gridPos.h));
    const p: Panel = {
      id: uid('panel'),
      title: 'New panel',
      type: 'line',
      gridPos: { x: 0, y: maxY, w: 12, h: 8 },
      dataSourceId: draft?.panels.find((x) => x.dataSourceId)?.dataSourceId ?? null,
      query: '',
      options: {},
    };
    mutatePanels((ps) => [...ps, p]);
    setEditingPanel(p);
  };

  const onDrill = useCallback(
    (panel: Panel, row: Record<string, unknown>) => {
      const dd = panel.drilldown;
      if (!dd) return;
      const v = def?.variables.find((x) => x.name === dd.variable);
      const val = String(row[dd.field]);
      setVar(dd.variable, v?.multi ? [val] : val);
      setToast({ msg: `Drill-down: ${v?.label ?? dd.variable} = ${val}`, severity: 'info' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [def?.variables, params],
  );

  if (isLoading) return null;
  if (error || !dashboard || !def) return <Alert severity="error">{error ? errorMessage(error) : 'Dashboard not found'}</Alert>;

  const canEdit = !publicToken && dashboard.access !== 'VIEW';
  const embedded = publicToken === EMBED_TOKEN;
  const showTitle = !(embedded && params.get('titled') === 'false');
  const showControls = !(embedded && params.get('controls') === 'false');
  const locked = new Set(dashboard.lockedParams ?? []);
  const refreshMs = editing ? false : refreshToMs(refresh);

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} sx={{ mb: 1.5, display: showTitle || showControls ? undefined : 'none' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" noWrap sx={{ visibility: showTitle ? undefined : 'hidden' }}>
            {meta?.title ?? dashboard.title}
          </Typography>
          {dashboard.tags.map((t) => (
            <Chip key={t} size="small" label={t} variant="outlined" sx={{ display: { xs: 'none', sm: 'flex' } }} />
          ))}
          {!publicToken && (
            <Tooltip title={connected ? 'Live updates connected' : 'Live updates disconnected (polling)'}>
              <FiberManualRecordIcon sx={{ fontSize: 12, color: connected ? 'success.main' : 'text.disabled' }} />
            </Tooltip>
          )}
          {editing && <Chip size="small" color="warning" label="Editing" />}
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ display: showControls ? undefined : 'none' }}>
          <TimeRangePicker value={timeRange} onChange={(r) => patchParams((p) => (p.set('from', r.from), p.set('to', r.to)))} />
          <RefreshPicker
            value={refresh}
            onChange={(v) => patchParams((p) => p.set('refresh', v))}
            onRefresh={() => qc.invalidateQueries({ queryKey: [workspaceStore.get(), 'panel', publicToken ?? dashboard.id] })}
          />
          {canEdit && !editing && (
            <Button variant="contained" startIcon={<EditIcon />} onClick={() => startEdit(dashboard)}>
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button startIcon={<AddchartIcon />} variant="outlined" onClick={addPanel}>
                Add panel
              </Button>
              <IconButton onClick={() => setSettingsOpen(true)} aria-label="Dashboard settings">
                <SettingsIcon />
              </IconButton>
              <Button onClick={cancelEdit}>Discard</Button>
              <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={update.isPending}>
                Save
              </Button>
            </>
          )}
          {!editing && canEdit && !publicToken && (
            <Tooltip title="Annotations">
              <IconButton onClick={() => setAnnotationsOpen(true)} aria-label="Annotations">
                <BookmarkBorderIcon />
              </IconButton>
            </Tooltip>
          )}
          {!editing && canEdit && (
            <IconButton onClick={() => setSettingsOpen(true)} aria-label="Dashboard settings">
              <SettingsIcon />
            </IconButton>
          )}
        </Stack>
      </Stack>

      <VariablesBar
        dashboardId={dashboard.id}
        variables={(meta?.variables ?? def.variables).filter((v) => !locked.has(v.name))}
        values={varValues}
        onChange={setVar}
        onOptions={onOptions}
        publicToken={publicToken}
      />

      {def.panels.length === 0 ? (
        <Stack alignItems="center" spacing={2} sx={{ py: 10 }}>
          <Typography color="text.secondary">This dashboard has no panels yet.</Typography>
          {canEdit && (
            <Button
              variant="contained"
              startIcon={<AddchartIcon />}
              onClick={() => {
                if (!editing) startEdit(dashboard);
                setTimeout(addPanel, 0);
              }}
            >
              Add your first panel
            </Button>
          )}
        </Stack>
      ) : (
        <DashboardGrid
          panels={def.panels}
          editing={editing}
          onLayoutChange={(pos) => mutatePanels((ps) => ps.map((p) => (pos[p.id] ? { ...p, gridPos: pos[p.id] } : p)))}
          renderPanel={(p) => (
            <PanelFrame
              dashboardId={dashboard.id}
              version={dashboard.version}
              panel={p}
              timeRange={timeRange}
              variables={resolvedVars}
              refreshMs={refreshMs}
              publicToken={publicToken}
              editing={editing}
              ready={ready}
              dirty={editing && panelSignature(p) !== panelSignature(savedPanels.get(p.id))}
              onView={() => setViewPanel(p)}
              onDrill={onDrill}
              onEdit={editing ? () => setEditingPanel(p) : canEdit ? () => (startEdit(dashboard), setEditingPanel(p)) : undefined}
              onDuplicate={editing ? () => mutatePanels((ps) => [...ps, { ...structuredClone(p), id: uid('panel'), gridPos: { ...p.gridPos, y: p.gridPos.y + p.gridPos.h } }]) : undefined}
              onRemove={editing ? () => mutatePanels((ps) => ps.filter((x) => x.id !== p.id)) : undefined}
            />
          )}
        />
      )}

      {editingPanel && (
        <PanelEditor
          open
          panel={editingPanel}
          variables={meta?.variables ?? def.variables}
          timeRange={timeRange}
          variableValues={resolvedVars}
          onClose={() => setEditingPanel(null)}
          onApply={(np) => {
            mutatePanels((ps) => ps.map((p) => (p.id === np.id ? np : p)));
            setEditingPanel(null);
          }}
        />
      )}

      <Dialog fullScreen open={!!viewPanel} onClose={() => setViewPanel(null)}>
        {viewPanel && (
          <Box sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
              <IconButton onClick={() => setViewPanel(null)} aria-label="Close">
                <CloseIcon />
              </IconButton>
            </Stack>
            <Box sx={{ flex: 1 }}>
              <PanelFrame
                dashboardId={dashboard.id}
                version={dashboard.version}
                panel={viewPanel}
                timeRange={timeRange}
                variables={resolvedVars}
                refreshMs={refreshMs}
                publicToken={publicToken}
                editing={false}
                ready={ready}
                dirty={editing && panelSignature(viewPanel) !== panelSignature(savedPanels.get(viewPanel.id))}
                onDrill={onDrill}
              />
            </Box>
          </Box>
        )}
      </Dialog>

      {annotationsOpen && <AnnotationsDialog dashboardId={dashboard.id} onClose={() => setAnnotationsOpen(false)} />}

      {!publicToken && (
        <DashboardSettingsDialog
          open={settingsOpen}
          dashboard={dashboard}
          meta={
            meta ?? {
              title: dashboard.title,
              description: dashboard.description,
              tags: dashboard.tags,
              refreshInterval: dashboard.refreshInterval,
              scheduleCron: dashboard.scheduleCron,
              isPrivate: dashboard.isPrivate,
              variables: dashboard.definition.variables,
            }
          }
          onClose={() => setSettingsOpen(false)}
          onApply={(m) => {
            if (!editing) startEdit(dashboard);
            setMeta(m);
            setDraft((d) => ({ ...(d ?? structuredClone(dashboard.definition)), variables: m.variables }));
            setSettingsOpen(false);
            setToast({ msg: 'Settings applied — remember to save the dashboard', severity: 'info' });
          }}
        />
      )}

      <Snackbar open={!!toast} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
        {toast ? (
          <Alert severity={toast.severity} variant="filled" onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
      {publicToken && !embedded && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 2 }}>
          Shared read-only view · <span onClick={() => navigate('/login')} style={{ cursor: 'pointer', textDecoration: 'underline' }}>Sign in</span>
        </Typography>
      )}
    </Box>
  );
}
