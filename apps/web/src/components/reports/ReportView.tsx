import { Fragment, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { Box, Link, Stack, Typography } from '@mui/material';
import type { DrillLink, RCell, RItem, RTableRow, RenderedReport } from '@/api/reports';

/** Page-like rendering of a report (always "paper" white, like SSRS / print preview). */

const C = {
  ink: '#111827',
  muted: '#6B7280',
  line: '#E5E7EB',
  head: '#2F3B52',
  group: ['#DCE6F5', '#E9EFF8', '#F3F6FB', '#F7F9FC', '#FAFBFD'],
  subtotal: '#F1F3F6',
  total: '#E2E6EC',
  zebra: '#FAFAFB',
  link: '#1F5BD6',
};

const PAGE_TOKEN = /\{\{\s*Globals\.(PageNumber|TotalPages)\s*\}\}/gi;
const interactivePage = (s: string) => s.replace(PAGE_TOKEN, (_m, k: string) => (k.toLowerCase() === 'pagenumber' ? '1' : '1'));

function Cell({ c, align, onDrill, pad }: { c: RCell; align: string; onDrill?: (l: DrillLink) => void; pad?: number }) {
  return (
    <td
      style={{ textAlign: align as 'left', fontWeight: c.bold ? 600 : undefined, color: c.color ?? (c.link && onDrill ? C.link : undefined), background: c.bg, paddingLeft: pad, cursor: c.link && onDrill ? 'pointer' : undefined, textDecoration: c.link && onDrill ? 'underline' : undefined }}
      onClick={c.link && onDrill ? () => onDrill(c.link!) : undefined}
      title={c.link ? 'Open drill-through report' : undefined}
    >
      {c.t}
    </td>
  );
}

function sortValue(c: RCell) {
  const v = c.v;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) ? n : String(v ?? c.t).toLowerCase();
}

function TableItem({ it, onDrill }: { it: Extract<RItem, { type: 'table' }>; onDrill?: (l: DrillLink) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(it.rows.filter((r) => r.kind === 'group' && r.collapsed && r.key).map((r) => r.key!)));
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  // Interactive sort reorders detail rows within each contiguous run (i.e. inside their group)
  const rows = useMemo(() => {
    if (!sort) return it.rows;
    const out: RTableRow[] = [];
    let run: RTableRow[] = [];
    const flush = () => {
      run.sort((a, b) => {
        const x = sortValue(a.cells[sort.col]);
        const y = sortValue(b.cells[sort.col]);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
      out.push(...run);
      run = [];
    };
    for (const r of it.rows) {
      if (r.kind === 'data') run.push(r);
      else {
        flush();
        out.push(r);
      }
    }
    flush();
    return out;
  }, [it.rows, sort]);

  if (it.empty) return <Typography sx={{ color: C.muted, fontStyle: 'italic', my: 1 }}>{it.empty}</Typography>;
  const n = it.columns.length;
  const toggle = (k: string) => setCollapsed((s) => (s.has(k) ? (s.delete(k), new Set(s)) : new Set(s.add(k))));
  let zebra = 0;
  return (
    <Box sx={{ overflowX: 'auto', mb: 2 }}>
      <table className="rpt-table">
        <thead>
          <tr>
            {it.columns.map((c, i) => (
              <th
                key={i}
                style={{ textAlign: c.align, cursor: 'pointer' }}
                onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}
                title="Sort"
              >
                {c.header}
                {sort?.col === i ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            if (r.anc.some((a) => collapsed.has(a))) return null;
            if (r.kind === 'group') {
              const isCollapsed = collapsed.has(r.key!);
              return (
                <tr key={ri} className="rpt-group" style={{ background: C.group[Math.min(r.level, 4)] }}>
                  <td colSpan={n} style={{ paddingLeft: 6 + r.level * 16, cursor: 'pointer' }} onClick={() => toggle(r.key!)}>
                    <span style={{ display: 'inline-block', width: 14, color: C.muted }}>{isCollapsed ? '⊞' : '⊟'}</span>
                    {r.label} <span style={{ color: C.muted, fontWeight: 400 }}>({(r.count ?? 0).toLocaleString()})</span>
                  </td>
                </tr>
              );
            }
            const bg = r.kind === 'total' ? C.total : r.kind === 'subtotal' ? C.subtotal : it.zebra && zebra++ % 2 ? C.zebra : undefined;
            return (
              <tr key={ri} style={{ background: bg }}>
                {r.cells.map((c, ci) => (
                  <Cell key={ci} c={c} align={it.columns[ci].align} onDrill={onDrill} pad={ci === 0 ? 6 + (r.kind === 'data' ? it.groupLevels : r.level) * 16 : undefined} />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}

function MatrixItem({ it }: { it: Extract<RItem, { type: 'matrix' }> }) {
  if (it.empty) return <Typography sx={{ color: C.muted, fontStyle: 'italic', my: 1 }}>{it.empty}</Typography>;
  return (
    <Box sx={{ overflowX: 'auto', mb: 2 }}>
      <table className="rpt-table">
        <thead>
          <tr>
            {it.rowHeaders.map((h) => (
              <th key={h}>{h}</th>
            ))}
            {it.columns.map((c, i) => (
              <th key={i} style={{ textAlign: 'right' }}>
                {c}
              </th>
            ))}
            {it.rowTotals && <th style={{ textAlign: 'right' }}>Total</th>}
          </tr>
        </thead>
        <tbody>
          {it.rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? C.zebra : undefined }}>
              {r.labels.map((l, j) => (
                <td key={j}>{l}</td>
              ))}
              {r.cells.map((c, j) => (
                <Cell key={j} c={c} align="right" />
              ))}
              {r.total && <Cell c={{ ...r.total, bg: C.subtotal }} align="right" />}
            </tr>
          ))}
          {it.columnTotals && (
            <tr style={{ background: C.total, fontWeight: 600 }}>
              <td colSpan={it.rowHeaders.length}>Total</td>
              {it.columnTotals.map((c, j) => (
                <Cell key={j} c={c} align="right" />
              ))}
              {it.grandTotal && <Cell c={it.grandTotal} align="right" />}
            </tr>
          )}
        </tbody>
      </table>
      {!!it.truncatedColumns && <Typography variant="caption" sx={{ color: C.muted }}>{it.truncatedColumns} more column(s) not shown</Typography>}
    </Box>
  );
}

function Item({ it, onDrill }: { it: RItem; onDrill?: (l: DrillLink) => void }) {
  const title = 'title' in it && it.title ? <Typography sx={{ fontWeight: 600, fontSize: 15, mt: 1.5, mb: 0.75, color: C.ink }}>{it.title}</Typography> : null;
  switch (it.type) {
    case 'text':
      return (
        <Typography
          sx={{
            whiteSpace: 'pre-wrap',
            fontSize: it.style.fontSize ? it.style.fontSize + 3 : undefined,
            fontWeight: it.style.bold ? 600 : undefined,
            fontStyle: it.style.italic ? 'italic' : undefined,
            color: it.style.color ?? C.ink,
            bgcolor: it.style.background,
            px: it.style.background ? 1 : 0,
            py: it.style.background ? 0.5 : 0,
            textAlign: it.style.align ?? 'left',
            mb: 1,
          }}
        >
          {it.text}
        </Typography>
      );
    case 'table':
      return (
        <>
          {title}
          <TableItem it={it} onDrill={onDrill} />
        </>
      );
    case 'matrix':
      return (
        <>
          {title}
          <MatrixItem it={it} />
        </>
      );
    case 'chart':
      return (
        <>
          {title}
          {it.empty ? (
            <Typography sx={{ color: C.muted, fontStyle: 'italic', mb: 2 }}>{it.empty}</Typography>
          ) : (
            <Box sx={{ mb: 2 }}>
              <ReactECharts option={it.option} style={{ height: it.height, width: '100%' }} notMerge opts={{ renderer: 'svg' }} theme="light" />
            </Box>
          )}
        </>
      );
    case 'kpi':
      return (
        <>
          {title}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: `repeat(${it.cards.length}, 1fr)` }, gap: 1.25, mb: 2 }}>
            {it.cards.map((c, i) => (
              <Box key={i} sx={{ bgcolor: '#F5F7FA', borderRadius: 1, px: 2, py: 1.5 }}>
                <Typography sx={{ fontSize: 12, color: C.muted }}>{c.label}</Typography>
                <Typography sx={{ fontSize: 26, fontWeight: 600, color: c.color ?? C.ink, lineHeight: 1.25 }}>{c.value}</Typography>
                {c.note && <Typography sx={{ fontSize: 11, color: C.muted }}>{c.note}</Typography>}
              </Box>
            ))}
          </Box>
        </>
      );
    case 'image':
      return (
        <Box sx={{ textAlign: it.align, mb: 1 }}>
          <img src={it.src} alt={it.title ?? ''} style={{ width: it.width, maxWidth: '100%' }} />
        </Box>
      );
    case 'pageBreak':
      return (
        <Box sx={{ my: 3, borderTop: '1px dashed #CBD2DC', position: 'relative', '@media print': { pageBreakAfter: 'always', border: 0 } }}>
          <Typography sx={{ position: 'absolute', top: -9, left: '50%', transform: 'translateX(-50%)', bgcolor: '#fff', px: 1, fontSize: 10, color: '#9CA3AF' }}>page break</Typography>
        </Box>
      );
    case 'divider':
      return <Box sx={{ borderTop: `1px solid ${C.line}`, my: 1.5 }} />;
    case 'error':
      return (
        <Typography sx={{ color: '#B91C1C', bgcolor: '#FEF2F2', px: 1.5, py: 1, borderRadius: 1, mb: 1.5, fontSize: 13 }}>
          #Error{it.title ? ` in "${it.title}"` : ''}: {it.message}
        </Typography>
      );
  }
}

function HeaderFooter({ o }: { o: RenderedReport['header'] }) {
  if (!o.left && !o.center && !o.right) return null;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 2, fontSize: 11, color: C.muted, py: 1 }}>
      <span>{interactivePage(o.left)}</span>
      <span style={{ textAlign: 'center' }}>{interactivePage(o.center)}</span>
      <span style={{ textAlign: 'right' }}>{interactivePage(o.right)}</span>
    </Box>
  );
}

export function ReportView({ model, onDrill, zoom = 1 }: { model: RenderedReport; onDrill?: (l: DrillLink) => void; zoom?: number }) {
  const width = model.page.orientation === 'landscape' ? 1120 : 820;
  const visibleParams = model.parameters.filter((p) => !p.hidden);
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <Box
        className="rpt-page"
        sx={{
          width: '100%',
          maxWidth: width,
          zoom,
          bgcolor: '#fff',
          color: C.ink,
          boxShadow: '0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.06)',
          borderRadius: 0.5,
          px: { xs: 2, sm: 4 },
          py: 2,
          fontSize: model.page.fontSize + 4,
          '& table.rpt-table': { borderCollapse: 'collapse', width: '100%', fontSize: model.page.fontSize + 3.5 },
          '& table.rpt-table th': { bgcolor: C.head, color: '#fff', fontWeight: 600, px: 0.75, py: 0.6, textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', top: 0, userSelect: 'none' },
          '& table.rpt-table td': { px: 0.75, py: 0.45, borderBottom: `1px solid ${C.line}`, verticalAlign: 'top' },
          '& tr.rpt-group td': { fontWeight: 600 },
          '@media print': { boxShadow: 'none', maxWidth: 'none', px: 0 },
        }}
      >
        <HeaderFooter o={model.header} />
        {model.showTitle && (
          <>
            <Typography sx={{ fontSize: 26, fontWeight: 600, color: C.ink, lineHeight: 1.2, mt: 1 }}>{model.title}</Typography>
            {model.description && <Typography sx={{ color: C.muted, fontSize: 13 }}>{model.description}</Typography>}
          </>
        )}
        {model.showParameters && visibleParams.length > 0 && (
          <Typography sx={{ color: C.muted, fontSize: 12, mt: 0.5 }}>
            {visibleParams.map((p, i) => (
              <Fragment key={p.name}>
                {i > 0 && '  ·  '}
                <b>{p.label}:</b> {p.display || '—'}
              </Fragment>
            ))}
          </Typography>
        )}
        {(model.showTitle || model.showParameters) && <Box sx={{ borderTop: `2px solid ${C.head}`, my: 1.5 }} />}
        {(model.documentMap?.length ?? 0) > 0 && (
          <Box sx={{ mb: 1.5, p: 1, border: `1px solid ${C.line}`, borderRadius: 1, '@media print': { display: 'none' } }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, mb: 0.5 }}>Contents</Typography>
            <Stack component="nav" spacing={0.25}>
              {model.documentMap.map((d) => (
                <Link
                  key={d.id}
                  component="button"
                  type="button"
                  underline="hover"
                  sx={{ textAlign: 'left', fontSize: 13, color: C.head, pl: d.level * 1.5, width: 'fit-content' }}
                  onClick={() => document.getElementById(`rpt-item-${d.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {d.label}
                </Link>
              ))}
            </Stack>
          </Box>
        )}
        {model.items.map((it) => (
          <Box key={it.id} id={`rpt-item-${it.id}`} sx={{ scrollMarginTop: 72 }}>
            <Item it={it} onDrill={onDrill} />
          </Box>
        ))}
        <HeaderFooter o={model.footer} />
      </Box>
    </Box>
  );
}
