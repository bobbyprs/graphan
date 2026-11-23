import { useMemo, useState } from 'react';
import { Box, Chip, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import type { ExplainResult } from '@/api/types';

type PgNode = Record<string, unknown> & { 'Node Type': string; Plans?: PgNode[] };

interface FlatNode {
  depth: number;
  node: PgNode;
  exclusiveMs: number | null;
}

/** Postgres reports inclusive time per loop; exclusive = inclusive*loops − Σ children. */
function flatten(root: PgNode, analyzed: boolean): FlatNode[] {
  const out: FlatNode[] = [];
  const total = (n: PgNode) => Number(n['Actual Total Time'] ?? 0) * Number(n['Actual Loops'] ?? 1);
  const walk = (n: PgNode, depth: number) => {
    const kids = n.Plans ?? [];
    const ex = analyzed ? Math.max(0, total(n) - kids.reduce((a, k) => a + total(k), 0)) : null;
    out.push({ depth, node: n, exclusiveMs: ex });
    kids.forEach((k) => walk(k, depth + 1));
  };
  walk(root, 0);
  return out;
}

function describe(n: PgNode) {
  const parts: string[] = [];
  if (n['Relation Name']) parts.push(`on ${n['Schema'] ? `${n['Schema']}.` : ''}${n['Relation Name']}${n['Alias'] && n['Alias'] !== n['Relation Name'] ? ` ${n['Alias']}` : ''}`);
  if (n['Index Name']) parts.push(`using ${n['Index Name']}`);
  if (n['Join Type']) parts.push(`${n['Join Type']} join`);
  if (n['Strategy']) parts.push(String(n['Strategy']));
  return parts.join(' ');
}

const DETAIL_KEYS = ['Filter', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'Recheck Cond', 'Sort Key', 'Group Key', 'Rows Removed by Filter', 'Output'];

/** pgAdmin-style plan analysis: indented node tree with costs, row estimates vs actuals and exclusive-time heat bars. */
export function ExplainView({ result }: { result: ExplainResult }) {
  const [tab, setTab] = useState(0);
  const root = useMemo(() => {
    if (result.format !== 'postgres-json') return null;
    const arr = result.plan as { Plan: PgNode; 'Planning Time'?: number; 'Execution Time'?: number }[];
    return arr?.[0] ?? null;
  }, [result]);

  if (!root) {
    return (
      <Box component="pre" sx={{ m: 0, p: 1.5, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflow: 'auto', height: '100%' }}>
        {result.text}
      </Box>
    );
  }

  const analyzed = root['Execution Time'] !== undefined;
  const rows = flatten(root.Plan, analyzed);
  const maxEx = Math.max(0.0001, ...rows.map((r) => r.exclusiveMs ?? 0));
  const maxCost = Math.max(0.0001, ...rows.map((r) => Number(r.node['Total Cost'] ?? 0)));

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, pt: 0.5 }}>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ minHeight: 32, '& .MuiTab-root': { minHeight: 32, py: 0 } }}>
          <Tab label="Analysis" />
          <Tab label="JSON" />
        </Tabs>
        <Box sx={{ flex: 1 }} />
        {root['Planning Time'] !== undefined && <Chip size="small" label={`Planning ${Number(root['Planning Time']).toFixed(3)} ms`} />}
        {analyzed && <Chip size="small" color="primary" label={`Execution ${Number(root['Execution Time']).toFixed(3)} ms`} />}
      </Stack>
      {tab === 1 ? (
        <Box component="pre" sx={{ m: 0, p: 1.5, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, overflow: 'auto', flex: 1 }}>
          {JSON.stringify(result.plan, null, 2)}
        </Box>
      ) : (
        <Box sx={{ overflow: 'auto', flex: 1, fontSize: 12 }}>
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& td, & th': { borderBottom: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left', whiteSpace: 'nowrap' } }}>
            <thead>
              <tr>
                <th>#</th>
                <th style={{ width: '50%' }}>Node</th>
                {analyzed && <th>Exclusive</th>}
                {analyzed && <th>Inclusive</th>}
                <th>Rows (est → actual)</th>
                {analyzed && <th>Loops</th>}
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const n = r.node;
                const est = Number(n['Plan Rows'] ?? 0);
                const act = n['Actual Rows'] !== undefined ? Number(n['Actual Rows']) * Number(n['Actual Loops'] ?? 1) : null;
                const misestimate = act !== null && est > 0 && (act / est > 10 || est / Math.max(act, 1) > 10);
                const heat = analyzed ? (r.exclusiveMs ?? 0) / maxEx : Number(n['Total Cost'] ?? 0) / maxCost;
                const details = DETAIL_KEYS.filter((key) => n[key] !== undefined).map((key) => `${key}: ${Array.isArray(n[key]) ? (n[key] as string[]).join(', ') : n[key]}`);
                return (
                  <Box component="tr" key={i} sx={{ bgcolor: heat > 0.5 ? 'rgba(242,73,92,.12)' : heat > 0.2 ? 'rgba(255,152,48,.10)' : undefined }}>
                    <td style={{ opacity: 0.5 }}>{i + 1}</td>
                    <td>
                      <Box sx={{ pl: r.depth * 2.5, whiteSpace: 'normal' }}>
                        <Typography component="span" sx={{ fontSize: 12, fontWeight: 600 }}>
                          {r.depth > 0 && '→ '}
                          {n['Node Type']}
                        </Typography>{' '}
                        <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
                          {describe(n)}
                        </Typography>
                        {details.map((d) => (
                          <Typography key={d} sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace', pl: 2 }}>
                            {d}
                          </Typography>
                        ))}
                      </Box>
                    </td>
                    {analyzed && (
                      <td>
                        <Stack direction="row" alignItems="center" spacing={0.75}>
                          <Box sx={{ width: 60, height: 6, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                            <Box sx={{ width: `${heat * 100}%`, height: '100%', bgcolor: heat > 0.5 ? 'error.main' : heat > 0.2 ? 'warning.main' : 'success.main' }} />
                          </Box>
                          <span>{(r.exclusiveMs ?? 0).toFixed(3)} ms</span>
                        </Stack>
                      </td>
                    )}
                    {analyzed && <td>{(Number(n['Actual Total Time'] ?? 0) * Number(n['Actual Loops'] ?? 1)).toFixed(3)} ms</td>}
                    <td>
                      <Tooltip title={misestimate ? 'Row estimate is off by more than 10× — consider ANALYZE on the table' : ''}>
                        <span style={{ color: misestimate ? '#FF9830' : undefined }}>
                          {est.toLocaleString()}
                          {act !== null && ` → ${act.toLocaleString()}`}
                        </span>
                      </Tooltip>
                    </td>
                    {analyzed && <td>{String(n['Actual Loops'] ?? '')}</td>}
                    <td>
                      {Number(n['Startup Cost'] ?? 0).toFixed(2)}..{Number(n['Total Cost'] ?? 0).toFixed(2)}
                    </td>
                  </Box>
                );
              })}
            </tbody>
          </Box>
        </Box>
      )}
    </Stack>
  );
}
