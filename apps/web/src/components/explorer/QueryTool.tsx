import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import TroubleshootIcon from '@mui/icons-material/Troubleshoot';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import SaveIcon from '@mui/icons-material/SaveOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import HistoryIcon from '@mui/icons-material/History';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { api, downloadPost, errorMessage } from '@/api/client';
import { useDeleteSavedQuery, useQueryHistory, useSavedQueries, useSaveQuery } from '@/api/hooks';
import type { DataSourceType, ExplainResult, QueryErrorDetails, QueryResult } from '@/api/types';
import { monaco, SqlEditor, type CompletionTable, type EditorCommand } from '@/components/common/SqlEditor';
import { ResultsGrid } from '@/components/common/ResultsGrid';
import { splitSql, statementAt } from '@/utils/sqlSplit';
import { relativeTime } from '@/utils/format';
import { ExplainView } from './ExplainView';
import { useDataModel } from '@/api/advisor';
import { useCan } from '@/auth/AuthContext';

// ───────────── types ─────────────
interface QTab {
  id: string;
  title: string;
  sql: string;
  savedId?: string;
}

interface ResultSet {
  sql: string;
  result: QueryResult;
}

interface Msg {
  level: 'info' | 'error';
  text: string;
  sql: string;
  details?: QueryErrorDetails;
  at: number;
}

interface RunState {
  running: boolean;
  startedAt?: number;
  results: ResultSet[];
  activeResult: number;
  messages: Msg[];
  explain?: ExplainResult;
  bottom: 'data' | 'messages' | 'explain';
}

export interface QueryToolRequest {
  nonce: number;
  title: string;
  sql: string;
  run?: boolean;
}

const EMPTY_RUN: RunState = { running: false, results: [], activeResult: 0, messages: [], bottom: 'data' };
const LIMITS = [100, 500, 1000, 5000, 10000, 0];
const FORMATTER_LANG: Partial<Record<DataSourceType, string>> = {
  POSTGRES: 'postgresql',
  MYSQL: 'mysql',
  MSSQL: 'transactsql',
  ORACLE: 'plsql',
  SQLITE: 'sqlite',
};

let tabSeq = Date.now();
const newId = () => `q${(tabSeq++).toString(36)}`;
const pathOf = (id: string) => `graphan-${id}.sql`;
const storageKey = (dsId: string) => `graphan.querytool.${dsId}`;

function loadTabs(dsId: string, isMongo: boolean): QTab[] {
  try {
    const raw = localStorage.getItem(storageKey(dsId));
    const tabs = raw ? (JSON.parse(raw) as QTab[]) : [];
    if (tabs.length) return tabs;
  } catch {
    /* ignore */
  }
  return [{ id: newId(), title: 'Query 1', sql: isMongo ? '{\n  "collection": "",\n  "find": {},\n  "limit": 100\n}' : '' }];
}

function errorDetails(e: unknown): QueryErrorDetails | undefined {
  return axios.isAxiosError(e) ? (e.response?.data as { error?: { details?: QueryErrorDetails } })?.error?.details : undefined;
}

function toTsv(r: QueryResult) {
  const cols = r.columns.map((c) => c.name);
  const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\t\n\r]/g, ' ');
  return [cols.join('\t'), ...r.rows.map((row) => cols.map((c) => cell(row[c])).join('\t'))].join('\n');
}

function snippet(sql: string) {
  const s = sql.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// ───────────── component ─────────────
export function QueryTool({ dsId, dsType, catalog, request }: { dsId: string; dsType?: DataSourceType; catalog?: CompletionTable[]; request?: QueryToolRequest }) {
  const isMongo = dsType === 'MONGODB';
  const [tabs, setTabs] = useState<QTab[]>(() => loadTabs(dsId, isMongo));
  // Joins found by the Smart builder (and corrected in its data model) complete JOIN … ON clauses
  const canExplore = useCan().explore;
  const { data: dataModel } = useDataModel(dsId, canExplore && !isMongo);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [limit, setLimit] = useState(1000);
  const [editorHeight, setEditorHeight] = useState(240);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<'history' | 'saved' | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [, tick] = useState(0);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const aborters = useRef<Record<string, AbortController>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const history = useQueryHistory(drawer === 'history' ? dsId : undefined);
  const saved = useSavedQueries();
  const saveQuery = useSaveQuery();
  const deleteSaved = useDeleteSavedQuery();

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const run = runs[active.id] ?? EMPTY_RUN;

  // Persist tabs (per data source) so work survives reloads
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(dsId), JSON.stringify(tabs.map(({ id, title, sql, savedId }) => ({ id, title, sql, savedId }))));
    } catch {
      /* storage unavailable */
    }
  }, [tabs, dsId]);

  // Elapsed-time ticker while anything runs
  useEffect(() => {
    if (!Object.values(runs).some((r) => r.running)) return;
    const t = setInterval(() => tick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [runs]);

  const patchRun = (id: string, fn: (r: RunState) => RunState) => setRuns((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY_RUN) }));
  const updateTab = (id: string, patch: Partial<QTab>) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const addTab = useCallback((title?: string, sql = '') => {
    const id = newId();
    setTabs((ts) => [...ts, { id, title: title ?? `Query ${ts.length + 1}`, sql }]);
    setActiveId(id);
    return id;
  }, []);

  const closeTab = (id: string) => {
    aborters.current[id]?.abort();
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (!next.length) next.push({ id: newId(), title: 'Query 1', sql: '' });
      if (id === activeId) setActiveId(next[Math.max(0, ts.findIndex((t) => t.id === id) - 1)]?.id ?? next[0].id);
      return next;
    });
  };

  const setMarkers = (tabId: string, list: monaco.editor.IMarkerData[]) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(pathOf(tabId)));
    if (model) monaco.editor.setModelMarkers(model, 'graphan', list);
  };

  // ── Execute (F5): selection if any, otherwise the whole script; one result per statement ──
  const execute = useCallback(
    async (tabId: string, source: string, baseOffset = 0) => {
      const statements = isMongo ? [{ text: source.trim(), start: 0, end: source.length }] : splitSql(source);
      if (!statements.length || !statements[0].text) return;
      aborters.current[tabId]?.abort();
      const ac = new AbortController();
      aborters.current[tabId] = ac;
      setMarkers(tabId, []);
      patchRun(tabId, (r) => ({ ...r, running: true, startedAt: Date.now(), results: [], activeResult: 0, messages: [] }));

      const results: ResultSet[] = [];
      const messages: Msg[] = [];
      for (const st of statements) {
        try {
          const { data } = await api.post<QueryResult>(
            '/queries/execute',
            { dataSourceId: dsId, sql: st.text, maxRows: limit || 100_000, timeRange: { from: 'now-24h', to: 'now' } },
            { signal: ac.signal },
          );
          const isSet = data.columns.length > 0;
          if (isSet) results.push({ sql: st.text, result: data });
          messages.push({
            level: 'info',
            sql: st.text,
            at: Date.now(),
            text: isSet
              ? `Successfully run. Total query runtime: ${data.durationMs} msec. ${data.rowCount} rows affected${data.truncated ? ` (truncated at the ${limit || 'maximum'} row limit)` : ''}.`
              : `Query returned successfully in ${data.durationMs} msec.${data.affectedRows != null ? ` ${data.affectedRows} rows affected.` : ''}`,
          });
        } catch (e) {
          const cancelled = axios.isCancel(e) || ac.signal.aborted;
          const details = errorDetails(e);
          messages.push({ level: 'error', sql: st.text, at: Date.now(), text: cancelled ? 'Query cancelled by user.' : errorMessage(e).replace(/^Query failed: /, 'ERROR:  '), details });
          if (details?.position) {
            const model = monaco.editor.getModel(monaco.Uri.parse(pathOf(tabId)));
            if (model) {
              const p = model.getPositionAt(baseOffset + st.start + details.position - 1);
              const word = model.getWordAtPosition(p);
              setMarkers(tabId, [
                {
                  severity: monaco.MarkerSeverity.Error,
                  message: errorMessage(e),
                  startLineNumber: p.lineNumber,
                  startColumn: word?.startColumn ?? p.column,
                  endLineNumber: p.lineNumber,
                  endColumn: word?.endColumn ?? p.column + 1,
                },
              ]);
              if (tabId === activeId) editorRef.current?.revealLineInCenterIfOutsideViewport(p.lineNumber);
            }
          }
          break; // like pgAdmin: stop the script at the first error
        }
      }
      delete aborters.current[tabId];
      const failed = messages.some((m) => m.level === 'error');
      patchRun(tabId, (r) => ({
        ...r,
        running: false,
        results,
        messages,
        activeResult: Math.max(0, results.length - 1),
        bottom: failed || !results.length ? 'messages' : 'data',
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dsId, isMongo, limit, activeId],
  );

  const executeActive = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (ed && model && sel && !sel.isEmpty()) void execute(active.id, model.getValueInRange(sel), model.getOffsetAt(sel.getStartPosition()));
    else void execute(active.id, active.sql);
  };

  // ── Explain (F7) / Explain Analyze (Shift+F7): selection or the statement under the cursor ──
  const explain = async (analyze: boolean) => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    let sql = active.sql;
    if (model && sel && !sel.isEmpty()) sql = model.getValueInRange(sel);
    else if (model && ed?.getPosition()) sql = statementAt(active.sql, model.getOffsetAt(ed.getPosition()!))?.text ?? active.sql;
    if (!sql.trim()) return;
    const id = active.id;
    const ac = new AbortController();
    aborters.current[id] = ac;
    patchRun(id, (r) => ({ ...r, running: true, startedAt: Date.now() }));
    try {
      const { data } = await api.post<ExplainResult>('/queries/explain', { dataSourceId: dsId, sql, analyze, timeRange: { from: 'now-24h', to: 'now' } }, { signal: ac.signal });
      patchRun(id, (r) => ({
        ...r,
        running: false,
        explain: data,
        bottom: 'explain',
        messages: [...r.messages, { level: 'info', sql, at: Date.now(), text: `${analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'} completed in ${data.durationMs} msec.` }],
      }));
    } catch (e) {
      patchRun(id, (r) => ({ ...r, running: false, bottom: 'messages', messages: [...r.messages, { level: 'error', sql, at: Date.now(), text: errorMessage(e), details: errorDetails(e) }] }));
    } finally {
      delete aborters.current[id];
    }
  };

  // ── Format (Shift+Alt+F): selection or whole buffer, as an undoable edit ──
  const format = async () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const sel = ed.getSelection();
    const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
    const text = model.getValueInRange(range);
    try {
      let out: string;
      if (isMongo) out = JSON.stringify(JSON.parse(text), null, 2);
      else {
        const { format: fmt } = await import('sql-formatter');
        out = fmt(text, { language: (FORMATTER_LANG[dsType ?? 'POSTGRES'] ?? 'sql') as 'postgresql', keywordCase: 'upper', tabWidth: 2, paramTypes: { custom: [{ regex: String.raw`\$__\w+(?:\([^)]*\))?|\$\{\w+\}` }] } });
      }
      ed.executeEdits('format', [{ range, text: out, forceMoveMarkers: true }]);
      ed.pushUndoStop();
    } catch (e) {
      setToast(`Could not format: ${(e as Error).message}`);
    }
  };

  const cancel = () => aborters.current[active.id]?.abort();

  const onCommand = (cmd: EditorCommand) => {
    if (cmd === 'run') executeActive();
    else if (cmd === 'explain') void explain(false);
    else if (cmd === 'explainAnalyze') void explain(true);
    else if (cmd === 'format') void format();
    else if (cmd === 'save') openSave();
  };

  const openSave = () => {
    setSaveName(active.title.startsWith('Query ') ? '' : active.title);
    setSaveOpen(true);
  };

  // ── Requests from the object browser (View data, Scripts, Count rows…) ──
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!request || request.nonce === lastNonce.current) return;
    lastNonce.current = request.nonce;
    const id = addTab(request.title, request.sql);
    if (request.run) setTimeout(() => void execute(id, request.sql), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // ── Editor / results splitter ──
  const startDrag = (e: React.MouseEvent) => {
    const y0 = e.clientY;
    const h0 = editorHeight;
    const move = (ev: MouseEvent) => setEditorHeight(Math.min(Math.max(h0 + ev.clientY - y0, 90), window.innerHeight - 260));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const current = run.results[run.activeResult];
  const elapsed = run.running && run.startedAt ? ((Date.now() - run.startedAt) / 1000).toFixed(1) : null;
  const totalRows = useMemo(() => run.results.reduce((a, r) => a + r.result.rowCount, 0), [run.results]);
  const lastMsg = run.messages[run.messages.length - 1];

  const exportAs = async (fmt: 'csv' | 'xlsx' | 'json') => {
    const sql = current?.sql ?? active.sql;
    try {
      await downloadPost('/queries/export', { dataSourceId: dsId, sql, format: fmt, fileName: active.title, timeRange: { from: 'now-24h', to: 'now' } }, `export.${fmt}`);
    } catch (e) {
      setToast(errorMessage(e));
    }
  };

  const openFile = async (f?: File) => {
    if (!f) return;
    addTab(f.name.replace(/\.(sql|txt)$/i, ''), await f.text());
  };

  const saveFile = () => {
    const url = URL.createObjectURL(new Blob([active.sql], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${active.title.replace(/[^\w.-]+/g, '_') || 'query'}.sql`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }}>
      {/* Query tabs */}
      <Stack direction="row" alignItems="center" sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 36 }}>
        <Tabs value={active.id} onChange={(_e, v) => setActiveId(v)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 36, flex: 1, '& .MuiTab-root': { minHeight: 36, py: 0, px: 1.25 } }}>
          {tabs.map((t) => (
            <Tab
              key={t.id}
              value={t.id}
              onDoubleClick={() => setRenaming(t.id)}
              label={
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  {runs[t.id]?.running && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }} />}
                  {renaming === t.id ? (
                    <InputBase
                      autoFocus
                      defaultValue={t.title}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={(e) => {
                        updateTab(t.id, { title: e.target.value.trim() || t.title });
                        setRenaming(null);
                      }}
                      sx={{ fontSize: 13, width: 120 }}
                    />
                  ) : (
                    <span>{t.title}</span>
                  )}
                  <CloseIcon
                    sx={{ fontSize: 14, opacity: 0.6, '&:hover': { opacity: 1 } }}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  />
                </Stack>
              }
            />
          ))}
        </Tabs>
        <Tooltip title="New query tab">
          <IconButton onClick={() => addTab()} aria-label="New query tab">
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Toolbar */}
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ py: 0.75 }}>
        <Tooltip title="Open .sql file">
          <IconButton onClick={() => fileInput.current?.click()} aria-label="Open file"><FolderOpenIcon fontSize="small" /></IconButton>
        </Tooltip>
        <input ref={fileInput} type="file" accept=".sql,.txt" hidden onChange={(e) => (void openFile(e.target.files?.[0]), (e.target.value = ''))} />
        <Tooltip title="Download as .sql file">
          <IconButton onClick={saveFile} aria-label="Save file"><SaveAltIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        {run.running ? (
          <Button variant="contained" color="error" startIcon={<StopIcon />} onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <Tooltip title="Execute script, or the selection (F5 / Ctrl+Enter)">
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={executeActive} disabled={!dsId}>
              Execute
            </Button>
          </Tooltip>
        )}
        <Tooltip title="Explain (F7)">
          <span>
            <IconButton onClick={() => void explain(false)} disabled={run.running || isMongo || dsType === 'MSSQL' || dsType === 'ORACLE'} aria-label="Explain"><AccountTreeIcon fontSize="small" /></IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Explain Analyze (Shift+F7) — runs the query in a rolled-back transaction">
          <span>
            <IconButton onClick={() => void explain(true)} disabled={run.running || isMongo || dsType === 'MSSQL' || dsType === 'ORACLE' || dsType === 'SQLITE'} aria-label="Explain analyze"><TroubleshootIcon fontSize="small" /></IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Format SQL (Shift+Alt+F)">
          <IconButton onClick={() => void format()} aria-label="Format"><FormatAlignLeftIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Tooltip title="Row limit">
          <Select size="small" value={limit} onChange={(e) => setLimit(Number(e.target.value))} sx={{ height: 30, fontSize: 13 }}>
            {LIMITS.map((l) => (
              <MenuItem key={l} value={l}>
                {l ? `${l.toLocaleString()} rows` : 'No limit'}
              </MenuItem>
            ))}
          </Select>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Save query (Ctrl+S)">
          <IconButton onClick={openSave} disabled={!active.sql.trim()} aria-label="Save query"><SaveIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Tooltip title="Saved & favorite queries">
          <IconButton onClick={() => setDrawer('saved')} aria-label="Saved queries"><StarBorderIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Tooltip title="Query history">
          <IconButton onClick={() => setDrawer('history')} aria-label="History"><HistoryIcon fontSize="small" /></IconButton>
        </Tooltip>
      </Stack>

      {/* Editor */}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', flexShrink: 0 }}>
        <SqlEditor
          path={pathOf(active.id)}
          value={active.sql}
          onChange={(v) => updateTab(active.id, { sql: v })}
          onCommand={onCommand}
          onReady={(ed) => {
            editorRef.current = ed;
            ed.onDidChangeCursorPosition((e) => setCursor({ ln: e.position.lineNumber, col: e.position.column }));
            ed.focus();
          }}
          language={isMongo ? 'json' : 'sql'}
          catalog={catalog}
          joins={dataModel?.joins}
          height={editorHeight}
        />
      </Box>
      <Box onMouseDown={startDrag} sx={{ height: 8, cursor: 'row-resize', display: 'grid', placeItems: 'center', flexShrink: 0, '&:hover > div': { bgcolor: 'primary.main' } }}>
        <Box sx={{ width: 48, height: 3, borderRadius: 2, bgcolor: 'divider' }} />
      </Box>

      {/* Output */}
      <Stack sx={{ flex: 1, minHeight: 220, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
        <Stack direction="row" alignItems="center" sx={{ borderBottom: 1, borderColor: 'divider', pr: 1 }}>
          <Tabs value={run.bottom} onChange={(_e, v) => patchRun(active.id, (r) => ({ ...r, bottom: v }))} sx={{ minHeight: 34, '& .MuiTab-root': { minHeight: 34, py: 0 } }}>
            <Tab value="data" label={`Data output${run.results.length > 1 ? ` (${run.results.length})` : ''}`} />
            <Tab
              value="messages"
              label={
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <span>Messages</span>
                  {run.messages.some((m) => m.level === 'error') && <ErrorOutlineIcon color="error" sx={{ fontSize: 15 }} />}
                </Stack>
              }
            />
            <Tab value="explain" label="Explain" disabled={!run.explain} />
          </Tabs>
          <Box sx={{ flex: 1 }} />
          {run.bottom === 'data' && current && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Tooltip title="Copy all rows with headers (TSV — pastes into Excel)">
                <IconButton
                  onClick={async () => {
                    await navigator.clipboard.writeText(toTsv(current.result));
                    setToast(`Copied ${current.result.rowCount} rows`);
                  }}
                  aria-label="Copy results"
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <ButtonGroup size="small" variant="outlined">
                <Button startIcon={<DownloadIcon />} onClick={() => exportAs('csv')}>CSV</Button>
                <Button onClick={() => exportAs('xlsx')}>Excel</Button>
                <Button onClick={() => exportAs('json')}>JSON</Button>
              </ButtonGroup>
            </Stack>
          )}
        </Stack>

        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {run.bottom === 'data' && (
            <>
              {run.results.length > 1 && (
                <Stack direction="row" spacing={0.5} sx={{ p: 0.75, overflowX: 'auto', flexShrink: 0 }}>
                  {run.results.map((r, i) => (
                    <Tooltip key={i} title={r.sql}>
                      <Chip
                        size="small"
                        color={i === run.activeResult ? 'primary' : 'default'}
                        variant={i === run.activeResult ? 'filled' : 'outlined'}
                        label={`Result ${i + 1} · ${r.result.rowCount} rows`}
                        onClick={() => patchRun(active.id, (s) => ({ ...s, activeResult: i }))}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              )}
              <Box sx={{ flex: 1, minHeight: 0 }}>
                {current ? (
                  <ResultsGrid result={current.result} rowNumbers pageSize={Math.min(limit || 1000, 1000)} />
                ) : (
                  <Stack alignItems="center" justifyContent="center" sx={{ height: '100%', color: 'text.secondary' }}>
                    <Typography variant="body2">{run.running ? 'Running…' : 'Execute a query (F5) to see results here.'}</Typography>
                  </Stack>
                )}
              </Box>
            </>
          )}
          {run.bottom === 'messages' && (
            <Box sx={{ p: 1.5, overflow: 'auto', fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 }}>
              {!run.messages.length && <Typography variant="body2" color="text.secondary">No messages.</Typography>}
              {run.messages.map((m, i) => (
                <Box key={i} sx={{ mb: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="flex-start">
                    {m.level === 'error' ? <ErrorOutlineIcon color="error" sx={{ fontSize: 16, mt: 0.2 }} /> : <CheckCircleOutlineIcon color="success" sx={{ fontSize: 16, mt: 0.2 }} />}
                    <Box sx={{ whiteSpace: 'pre-wrap', color: m.level === 'error' ? 'error.main' : 'text.primary' }}>
                      {m.text}
                      {m.details?.detail && `\nDETAIL:  ${m.details.detail}`}
                      {m.details?.hint && `\nHINT:  ${m.details.hint}`}
                      {m.details?.where && `\nCONTEXT:  ${m.details.where}`}
                      {m.details?.code && `\nSQL state: ${m.details.code}`}
                      {m.details?.position && `\nCharacter: ${m.details.position}`}
                    </Box>
                  </Stack>
                  <Typography sx={{ fontSize: 11, color: 'text.secondary', pl: 3, fontFamily: 'inherit' }}>{snippet(m.sql)}</Typography>
                </Box>
              ))}
            </Box>
          )}
          {run.bottom === 'explain' && run.explain && <ExplainView result={run.explain} />}
        </Box>

        {/* Status bar */}
        <Stack direction="row" spacing={2} alignItems="center" sx={{ px: 1.5, py: 0.25, borderTop: 1, borderColor: 'divider', fontSize: 12, color: 'text.secondary', flexShrink: 0 }}>
          {run.running ? (
            <span>Running… {elapsed}s</span>
          ) : lastMsg ? (
            <span style={{ color: lastMsg.level === 'error' ? '#F2495C' : undefined }}>{lastMsg.level === 'error' ? 'Query failed' : `Query complete`}</span>
          ) : (
            <span>Ready</span>
          )}
          {!!run.results.length && <span>Total rows: {totalRows.toLocaleString()}</span>}
          {current && <span>{current.result.durationMs} ms</span>}
          <Box sx={{ flex: 1 }} />
          <span>
            Ln {cursor.ln}, Col {cursor.col}
          </span>
        </Stack>
      </Stack>

      {/* Saved queries / history */}
      <Drawer anchor="right" open={!!drawer} onClose={() => setDrawer(null)} PaperProps={{ sx: { width: { xs: '100%', sm: 440 } } }}>
        <Stack direction="row" alignItems="center" sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ flex: 1 }}>{drawer === 'history' ? 'Query history' : 'Saved queries'}</Typography>
          <IconButton onClick={() => setDrawer(null)} aria-label="Close"><CloseIcon /></IconButton>
        </Stack>
        <List dense sx={{ overflow: 'auto' }}>
          {drawer === 'history' &&
            history.data?.map((h) => (
              <ListItemButton key={h.id} onClick={() => (addTab('History', h.sql), setDrawer(null))} alignItems="flex-start">
                <ListItemText
                  primary={<Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{h.sql}</Typography>}
                  secondary={
                    <Typography variant="caption" color={h.success ? 'text.secondary' : 'error'}>
                      {relativeTime(h.createdAt)} · {h.durationMs} ms · {h.success ? `${h.rowCount ?? 0} rows` : h.error}
                    </Typography>
                  }
                />
              </ListItemButton>
            ))}
          {drawer === 'saved' &&
            saved.data
              ?.filter((q) => q.dataSourceId === dsId)
              .map((q) => (
                <ListItemButton
                  key={q.id}
                  onClick={() => {
                    const id = addTab(q.name, q.sql);
                    updateTab(id, { savedId: q.id });
                    setDrawer(null);
                  }}
                >
                  <IconButton size="small" onClick={(e) => (e.stopPropagation(), saveQuery.mutate({ id: q.id, isFavorite: !q.isFavorite }))} aria-label="Toggle favorite">
                    {q.isFavorite ? <StarIcon fontSize="small" color="warning" /> : <StarBorderIcon fontSize="small" />}
                  </IconButton>
                  <ListItemText primary={q.name} secondary={relativeTime(q.updatedAt)} sx={{ ml: 1 }} />
                  <IconButton size="small" onClick={(e) => (e.stopPropagation(), deleteSaved.mutate(q.id))} aria-label="Delete">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </ListItemButton>
              ))}
          {drawer === 'saved' && !saved.data?.some((q) => q.dataSourceId === dsId) && <Typography sx={{ p: 2 }} color="text.secondary">No saved queries for this data source yet.</Typography>}
        </List>
      </Drawer>

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{active.savedId ? 'Update saved query' : 'Save query'}</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="Name" value={saveName} onChange={(e) => setSaveName(e.target.value)} sx={{ mt: 1 }} />
          {saveQuery.error && <Alert severity="error" sx={{ mt: 1 }}>{errorMessage(saveQuery.error)}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!saveName}
            onClick={async () => {
              const r = (await saveQuery.mutateAsync({ id: active.savedId, dataSourceId: dsId, name: saveName, sql: active.sql })) as { id: string };
              updateTab(active.id, { title: saveName, savedId: r.id });
              setSaveOpen(false);
              setToast('Query saved');
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast(null)} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} />
    </Stack>
  );
}
