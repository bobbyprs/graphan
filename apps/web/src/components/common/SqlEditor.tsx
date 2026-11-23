import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
// Editor core with all editor features (find/replace, comments, multi-cursor, folding…)
// plus only the two languages we use (SQL, JSON for MongoDB) — not all ~80 languages.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { useTheme } from '@mui/material';

// Bundle Monaco locally (no CDN) — works offline and under strict CSP.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new jsonWorker() : new editorWorker()),
};
loader.config({ monaco });

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'FULL OUTER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'LIKE', 'DISTINCT', 'COUNT', 'SUM',
  'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'UNION ALL', 'COALESCE', 'CAST', 'DESC', 'ASC',
];

const MACROS = [
  { label: '$__timeFilter(column)', insert: '\\$__timeFilter(${1:column})', doc: 'column BETWEEN dashboard time range (bound parameters)' },
  { label: '$__timeGroup(column, auto)', insert: '\\$__timeGroup(${1:column}, ${2:auto})', doc: 'Buckets a timestamp column (auto | 1m | 1h | 1d ...)' },
  { label: '$__timeFrom', insert: '\\$__timeFrom', doc: 'Start of dashboard time range' },
  { label: '$__timeTo', insert: '\\$__timeTo', doc: 'End of dashboard time range' },
  { label: '$__interval_s', insert: '\\$__interval_s', doc: 'Auto interval in seconds' },
];

export interface CompletionTable {
  schema: string;
  table: string;
  columns: string[];
}

/** Known relationship (many-to-one) used to complete JOIN clauses. */
export interface CompletionJoin {
  left: { schema: string; table: string; column: string };
  right: { schema: string; table: string; column: string };
  confidence?: number;
  source?: string;
}

const NOT_ALIAS = new Set(['on', 'where', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'join', 'group', 'order', 'limit', 'having', 'union', 'as', 'using', 'natural', 'and', 'or', 'set', 'window', 'offset', 'fetch', 'lateral']);
const ident = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const bare = (s: string) => s.replace(/^["`[]|["`\]]$/g, '').toLowerCase();

/** Tables already in the query (FROM / JOIN) with their aliases. */
function referencedTables(sql: string) {
  const out: { schema?: string; table: string; alias: string }[] = [];
  const re = /\b(?:from|join)\s+((?:["`[]?[\w$]+["`\]]?\.)?["`[]?[\w$]+["`\]]?)(?:\s+(?:as\s+)?(["`[]?[\w$]+["`\]]?))?/gi;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const parts = m[1].split('.');
    const table = bare(parts[parts.length - 1]);
    const schema = parts.length > 1 ? bare(parts[0]) : undefined;
    const al = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2].replace(/^["`[]|["`\]]$/g, '') : parts[parts.length - 1].replace(/^["`[]|["`\]]$/g, '');
    out.push({ schema, table, alias: al });
  }
  return out;
}

/** "tblflashsessionlog" → "fs", "customers" → "c" (unique within the query). */
function aliasFor(table: string, used: Set<string>) {
  const base = table.toLowerCase().replace(/^(tbl|tb|t_|vw_|v_)/, '').replace(/(master|mst)$/, '');
  const words = base.split(/[_\W]+/).filter(Boolean);
  let a = (words.length > 1 ? words.map((w) => w[0]).join('') : base.slice(0, 1)) || 't';
  if (used.has(a) && base.length > 1) a = base.slice(0, 2);
  let n = 2;
  const root = a;
  while (used.has(a)) a = `${root}${n++}`;
  return a;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun?: (selected?: string) => void;
  language?: 'sql' | 'json';
  height?: number | string;
  catalog?: CompletionTable[];
  /** relationships for JOIN … ON completion (from the Smart builder data model) */
  joins?: CompletionJoin[];
  variables?: string[];
  readOnly?: boolean;
  /** Distinct model per path (keeps undo history per query tab) */
  path?: string;
  /** pgAdmin-style shortcuts: F5/Ctrl+Enter run, F7 explain, Shift+F7 explain analyze, Shift+Alt+F format */
  onCommand?: (cmd: EditorCommand) => void;
  onReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}

export type EditorCommand = 'run' | 'explain' | 'explainAnalyze' | 'format' | 'save';
export { monaco };

/** Monaco SQL editor with schema-aware completion, macros and Ctrl/Cmd+Enter to run. */
export function SqlEditor({ value, onChange, onRun, language = 'sql', height = 260, catalog, joins, variables, readOnly, path, onCommand, onReady }: Props) {
  const theme = useTheme();
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const cmdRef = useRef(onCommand);
  cmdRef.current = onCommand;
  const catalogRef = useRef({ catalog, variables, joins });
  catalogRef.current = { catalog, variables, joins };

  // One completion provider per mount, reading the latest catalog via ref
  useEffect(() => {
    if (language !== 'sql' || readOnly) return;
    const disp = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' ', '$'],
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const K = monaco.languages.CompletionItemKind;
        const { catalog: cat = [], variables: vars = [], joins: rels = [] } = catalogRef.current;
        const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: word.startColumn });
        // After "JOIN ": complete the whole clause for tables related to ones already in the query
        if (rels.length && /\bjoin\s+$/i.test(before)) {
          const sql = model.getValue();
          const refs = referencedTables(sql);
          const used = new Set(refs.map((r) => r.alias.toLowerCase()));
          const seen = new Set<string>();
          const items: monaco.languages.CompletionItem[] = [];
          const matches = (r: { schema?: string; table: string }, side: CompletionJoin['left']) => r.table === side.table.toLowerCase() && (!r.schema || r.schema === side.schema.toLowerCase());
          for (const ref of refs)
            for (const j of rels)
              for (const [mine, other] of [
                [j.left, j.right],
                [j.right, j.left],
              ] as const) {
                if (!matches(ref, mine) || refs.some((x) => matches(x, other))) continue;
                const a = aliasFor(other.table, used);
                const text = `${ident(other.schema)}.${ident(other.table)} ${a} ON ${a}.${ident(other.column)} = ${ref.alias}.${ident(mine.column)}`;
                if (seen.has(text)) continue;
                seen.add(text);
                items.push({
                  label: `${other.table} ${a} ON ${a}.${other.column} = ${ref.alias}.${mine.column}`,
                  kind: K.Reference,
                  insertText: text,
                  range,
                  detail: `join · ${j.source === 'declared' ? 'foreign key' : j.source ?? 'detected'}${j.confidence ? ` · ${j.confidence}%` : ''}`,
                  documentation: mine === j.left ? `Many ${j.left.table} rows → one ${j.right.table}` : `One ${j.right.table} → many ${j.left.table} rows`,
                  sortText: `0${100 - (j.confidence ?? 100)}${other.table}`,
                });
              }
          if (items.length) return { suggestions: items };
        }
        const dotted = /([\w"]+)\.$/.exec(before);
        if (dotted) {
          const t = dotted[1].replace(/"/g, '').toLowerCase();
          const tbl = cat.find((c) => c.table.toLowerCase() === t);
          const schemaTables = cat.filter((c) => c.schema.toLowerCase() === t);
          return {
            suggestions: [
              ...(tbl?.columns.map((c) => ({ label: c, kind: K.Field, insertText: c, range, detail: tbl.table })) ?? []),
              ...schemaTables.map((c) => ({ label: c.table, kind: K.Struct, insertText: c.table, range })),
            ],
          };
        }
        return {
          suggestions: [
            ...SQL_KEYWORDS.map((kw) => ({ label: kw, kind: K.Keyword, insertText: kw, range })),
            ...cat.map((c) => ({ label: c.table, kind: K.Struct, insertText: c.table, range, detail: `${c.schema} · ${c.columns.length} cols` })),
            ...cat.flatMap((c) => c.columns.map((col) => ({ label: col, kind: K.Field, insertText: col, range, detail: c.table, sortText: `z${col}` }))),
            ...MACROS.map((m) => ({
              label: m.label,
              kind: K.Function,
              insertText: m.insert,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: m.doc,
              range,
            })),
            ...vars.map((v) => ({ label: `\${${v}}`, kind: K.Variable, insertText: `\\\${${v}}`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, detail: 'dashboard variable' })),
          ],
        };
      },
    });
    return () => disp.dispose();
  }, [language, readOnly]);

  const onMount: OnMount = (editor) => {
    const run = () => {
      if (cmdRef.current) return cmdRef.current('run');
      const sel = editor.getSelection();
      const selected = sel && !sel.isEmpty() ? editor.getModel()?.getValueInRange(sel) : undefined;
      runRef.current?.(selected);
    };
    const { KeyMod, KeyCode } = monaco;
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, run);
    editor.addCommand(KeyCode.F5, run);
    editor.addCommand(KeyCode.F7, () => cmdRef.current?.('explain'));
    editor.addCommand(KeyMod.Shift | KeyCode.F7, () => cmdRef.current?.('explainAnalyze'));
    editor.addCommand(KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF, () => cmdRef.current?.('format'));
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => cmdRef.current?.('save'));
    onReady?.(editor);
  };

  return (
    <Editor
      height={height}
      language={language}
      theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'light'}
      value={value}
      path={path}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Consolas, monospace',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        tabSize: 2,
        renderLineHighlight: 'line',
        padding: { top: 8 },
        suggest: { showWords: false },
      }}
    />
  );
}
