import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, MenuItem, Paper, Snackbar, Stack, Tab, Tabs, TextField } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import TerminalIcon from '@mui/icons-material/Terminal';
import { api, errorMessage } from '@/api/client';
import { useCompletion, useDataSources } from '@/api/hooks';
import type { DbObject, QueryResult, TableDetails } from '@/api/types';
import { DsIcon, StatusChip } from '@/components/common/misc';
import { SchemaTree, type TreeAction } from '@/components/explorer/SchemaTree';
import { TableDetailsPanel } from '@/components/explorer/TableDetailsPanel';
import { QueryTool, type QueryToolRequest } from '@/components/explorer/QueryTool';
import { countRows, crudScript, qualified, selectRows } from '@/utils/sqlScripts';

type OpenTab = { key: string; o: DbObject; highlight?: string };

export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const { data: dataSources = [] } = useDataSources();
  const dsId = params.get('ds') ?? dataSources[0]?.id ?? '';
  const ds = dataSources.find((d) => d.id === dsId);
  const dsType = ds?.type ?? 'POSTGRES';

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [active, setActive] = useState('query');
  const [request, setRequest] = useState<QueryToolRequest>();
  const [toast, setToast] = useState<string | null>(null);
  const { data: catalog } = useCompletion(dsId || undefined);

  const toQueryTool = (title: string, sql: string, run = false) => {
    setRequest({ nonce: Date.now(), title, sql, run });
    setActive('query');
  };

  const openDetails = (o: DbObject, highlight?: string) => {
    const key = `${o.schema}.${o.name}`;
    setTabs((t) => (t.some((x) => x.key === key) ? t.map((x) => (x.key === key ? { ...x, highlight } : x)) : [...t, { key, o, highlight }]));
    setActive(key);
  };

  const describe = async (o: DbObject) =>
    (await api.get<TableDetails>(`/explorer/${dsId}/schemas/${encodeURIComponent(o.schema)}/tables/${encodeURIComponent(o.name)}`)).data;

  // pgAdmin-style context-menu actions from the object browser
  const onAction = async (a: TreeAction, o: DbObject) => {
    try {
      switch (a) {
        case 'properties':
          return openDetails(o);
        case 'view-100':
          return toQueryTool(o.name, selectRows(dsType, o, 100), true);
        case 'view-all':
          return toQueryTool(o.name, selectRows(dsType, o), true);
        case 'count': {
          const { data } = await api.post<QueryResult>('/queries/execute', { dataSourceId: dsId, sql: countRows(dsType, o) });
          const n = Object.values(data.rows[0] ?? {})[0];
          return setToast(`Table rows counted: ${Number(n ?? 0).toLocaleString()} rows in ${o.schema}.${o.name}`);
        }
        case 'copy-name':
          await navigator.clipboard.writeText(qualified(dsType, o.schema, o.name));
          return setToast('Copied to clipboard');
        case 'script-create': {
          const { data } = await api.get<{ ddl: string }>(`/explorer/${dsId}/schemas/${encodeURIComponent(o.schema)}/ddl`, { params: { name: o.name, kind: o.kind } });
          return toQueryTool(`${o.name} (CREATE)`, data.ddl);
        }
        default: {
          const kind = a.replace('script-', '') as 'select' | 'insert' | 'update' | 'delete';
          return toQueryTool(`${o.name} (${kind.toUpperCase()})`, crudScript(dsType, await describe(o), kind));
        }
      }
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ height: { md: 'calc(100vh - 96px)' }, minHeight: 0 }}>
      {/* Object browser */}
      <Paper sx={{ width: { md: 310 }, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: { xs: 320, md: 0 }, maxHeight: { xs: 420, md: 'none' } }}>
        <Box sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
          <TextField
            select
            fullWidth
            label="Data source"
            value={dsId}
            onChange={(e) => {
              setParams({ ds: e.target.value });
              setTabs([]);
              setActive('query');
            }}
          >
            {dataSources.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <DsIcon type={d.type} size={20} />
                  <span>{d.name}</span>
                </Stack>
              </MenuItem>
            ))}
          </TextField>
          {ds && (
            <Box sx={{ mt: 1 }}>
              <StatusChip status={ds.status} latency={ds.lastLatencyMs} checkedAt={ds.lastCheckedAt} error={ds.lastError} />
            </Box>
          )}
        </Box>
        <Box sx={{ flex: 1, minHeight: 0 }}>{dsId && <SchemaTree key={dsId} dsId={dsId} onAction={onAction} onOpenColumn={(o, c) => openDetails(o, c)} />}</Box>
      </Paper>

      {/* Workspace: Query Tool + object property tabs */}
      <Paper sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', p: 1.5, minHeight: { xs: 700, md: 0 } }}>
        <Tabs value={active} onChange={(_e, v) => setActive(v)} variant="scrollable" sx={{ mb: 1, borderBottom: 1, borderColor: 'divider', minHeight: 38, '& .MuiTab-root': { minHeight: 38 } }}>
          <Tab value="query" icon={<TerminalIcon sx={{ fontSize: 18 }} />} iconPosition="start" label="Query Tool" />
          {tabs.map((t) => (
            <Tab
              key={t.key}
              value={t.key}
              label={
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <span>{t.o.name}</span>
                  <CloseIcon
                    sx={{ fontSize: 14 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTabs((all) => all.filter((x) => x.key !== t.key));
                      if (active === t.key) setActive('query');
                    }}
                  />
                </Stack>
              }
            />
          ))}
        </Tabs>

        {/* Kept mounted while hidden so query tabs, results and undo history survive tab switches */}
        <Box sx={{ flex: 1, minHeight: 0, display: active === 'query' ? 'flex' : 'none', flexDirection: 'column' }}>
          {dsId && <QueryTool key={dsId} dsId={dsId} dsType={ds?.type} catalog={catalog} request={request} />}
        </Box>
        {tabs
          .filter((t) => t.key === active)
          .map((t) => (
            <Box key={t.key} sx={{ flex: 1, minHeight: 0 }}>
              <TableDetailsPanel dsId={dsId} dsType={dsType} schema={t.o.schema} table={t.o.name} kind={t.o.kind} highlight={t.highlight} onQuery={(sql, title) => toQueryTool(title, sql)} />
            </Box>
          ))}
      </Paper>

      <Snackbar open={!!toast} autoHideDuration={4000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} />
    </Stack>
  );
}
