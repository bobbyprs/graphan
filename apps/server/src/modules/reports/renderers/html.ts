import { env } from '../../../config/env';
import { substitutePage, type RCell, type RenderedReport, type RItem } from '../rendered';
import type { QueryResult } from '../../../connectors/types';
import { svgToPng } from './assets';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const GROUP = ['#DCE6F5', '#E9EFF8', '#F3F6FB', '#F7F9FC', '#FAFBFD'];

export interface HtmlAttachment {
  filename: string;
  content: Buffer;
  cid: string;
}

function linkHref(c: RCell) {
  if (!c.link) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(c.link.params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(`p.${k}`, String(x ?? '')));
  return `${env.APP_PUBLIC_URL}/reports/${c.link.reportId}?${q}`;
}

function cell(c: RCell, align: string, extra = '') {
  const style = [`text-align:${align}`, c.bold ? 'font-weight:600' : '', c.color ? `color:${c.color}` : '', c.bg ? `background:${c.bg}` : '', extra].filter(Boolean).join(';');
  const text = esc(c.t);
  const href = linkHref(c);
  return `<td style="${style}">${href ? `<a href="${esc(href)}">${text}</a>` : text}</td>`;
}

/**
 * Standalone HTML rendering. `charts: 'svg'` inlines SVG (files/browsers);
 * `charts: 'cid'` attaches PNGs referenced by Content-ID (e-mail clients don't render SVG).
 */
export function renderHtml(m: RenderedReport, opts: { charts: 'svg' | 'cid'; bodyOnly?: boolean } = { charts: 'svg' }): { html: string; attachments: HtmlAttachment[] } {
  const attachments: HtmlAttachment[] = [];
  const fs = m.page.fontSize + 3;
  const parts: string[] = [];
  const hf = (o: { left: string; center: string; right: string }) =>
    o.left || o.center || o.right
      ? `<table class="hf"><tr><td>${esc(substitutePage(o.left, 1, 1))}</td><td style="text-align:center">${esc(substitutePage(o.center, 1, 1))}</td><td style="text-align:right">${esc(substitutePage(o.right, 1, 1))}</td></tr></table>`
      : '';

  if (m.showTitle) parts.push(`<h1>${esc(m.title)}</h1>${m.description ? `<p class="muted">${esc(m.description)}</p>` : ''}`);
  if (m.showParameters) {
    const vis = m.parameters.filter((p) => !p.hidden);
    if (vis.length) parts.push(`<p class="muted params">${vis.map((p) => `<b>${esc(p.label)}:</b> ${esc(p.display || '—')}`).join(' &nbsp;·&nbsp; ')}</p>`);
  }
  const title = (t?: string) => (t ? `<h3>${esc(t)}</h3>` : '');

  const item = (it: RItem): string => {
    switch (it.type) {
      case 'text': {
        const s = it.style;
        const style = [s.fontSize ? `font-size:${s.fontSize + 3}px` : '', s.bold ? 'font-weight:600' : '', s.italic ? 'font-style:italic' : '', s.color ? `color:${s.color}` : '', s.background ? `background:${s.background};padding:4px 6px` : '', `text-align:${s.align ?? 'left'}`].filter(Boolean).join(';');
        return `<p style="${style};white-space:pre-wrap">${esc(it.text)}</p>`;
      }
      case 'table': {
        if (it.empty) return `${title(it.title)}<p class="muted"><i>${esc(it.empty)}</i></p>`;
        const n = it.columns.length;
        const rows = it.rows
          .map((r, i) => {
            if (r.kind === 'group') return `<tr class="g"><td colspan="${n}" style="background:${GROUP[Math.min(r.level, 4)]};padding-left:${6 + r.level * 14}px">${esc(r.label)} <span class="muted">(${(r.count ?? 0).toLocaleString()})</span></td></tr>`;
            const bg = r.kind === 'total' ? '#E2E6EC' : r.kind === 'subtotal' ? '#F1F3F6' : it.zebra && i % 2 ? '#FAFAFB' : '';
            return `<tr${bg ? ` style="background:${bg}"` : ''}>${r.cells.map((c, ci) => cell(c, it.columns[ci].align, ci === 0 ? `padding-left:${6 + (r.kind === 'data' ? it.groupLevels : r.level) * 14}px` : '')).join('')}</tr>`;
          })
          .join('');
        return `${title(it.title)}<table class="t"><thead><tr>${it.columns.map((c) => `<th style="text-align:${c.align}">${esc(c.header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      }
      case 'matrix': {
        if (it.empty) return `${title(it.title)}<p class="muted"><i>${esc(it.empty)}</i></p>`;
        const heads = [...it.rowHeaders.map((h) => `<th>${esc(h)}</th>`), ...it.columns.map((c) => `<th style="text-align:right">${esc(c)}</th>`), ...(it.rowTotals ? ['<th style="text-align:right">Total</th>'] : [])];
        const body = it.rows
          .map((r, i) => `<tr${i % 2 ? ' style="background:#FAFAFB"' : ''}>${r.labels.map((l) => `<td>${esc(l)}</td>`).join('')}${r.cells.map((c) => cell(c, 'right')).join('')}${r.total ? cell(r.total, 'right', 'background:#F1F3F6') : ''}</tr>`)
          .join('');
        const totals = it.columnTotals
          ? `<tr style="background:#E2E6EC;font-weight:600"><td colspan="${it.rowHeaders.length}">Total</td>${[...it.columnTotals, ...(it.grandTotal ? [it.grandTotal] : [])].map((c) => cell(c, 'right')).join('')}</tr>`
          : '';
        return `${title(it.title)}<table class="t"><thead><tr>${heads.join('')}</tr></thead><tbody>${body}${totals}</tbody></table>`;
      }
      case 'chart': {
        if (!it.svg) return `${title(it.title)}<p class="muted"><i>${esc(it.empty ?? 'No data')}</i></p>`;
        if (opts.charts === 'svg') return `${title(it.title)}<div class="chart">${it.svg}</div>`;
        const cid = `chart-${attachments.length + 1}@graphan`;
        const img = svgToPng(it.svg, 1200);
        attachments.push({ filename: `chart-${attachments.length + 1}.png`, content: img.png, cid });
        return `${title(it.title)}<img src="cid:${cid}" alt="${esc(it.title ?? 'chart')}" style="width:100%;max-width:720px;height:auto"/>`;
      }
      case 'kpi':
        return `${title(it.title)}<table class="kpi"><tr>${it.cards
          .map((c) => `<td><div class="muted">${esc(c.label)}</div><div class="v" style="${c.color ? `color:${c.color}` : ''}">${esc(c.value)}</div>${c.note ? `<div class="muted small">${esc(c.note)}</div>` : ''}</td>`)
          .join('')}</tr></table>`;
      case 'image':
        return `<p style="text-align:${it.align}"><img src="${esc(it.src)}" style="width:${it.width}px;max-width:100%"/></p>`;
      case 'pageBreak':
        return '<div style="page-break-after:always"></div>';
      case 'divider':
        return '<hr/>';
      case 'error':
        return `<p style="color:#B91C1C">#Error ${esc(it.title ?? '')}: ${esc(it.message)}</p>`;
    }
  };
  for (const it of m.items) parts.push(item(it));

  const css = `body{font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:${fs}px;color:#111827;margin:24px;max-width:1100px}
h1{font-size:${fs + 10}px;margin:0 0 4px}h3{font-size:${fs + 2}px;margin:18px 0 6px}.muted{color:#6B7280}.small{font-size:${fs - 2}px}.params{margin:4px 0 12px}
table.t{border-collapse:collapse;width:100%;margin-bottom:14px}table.t th{background:#2F3B52;color:#fff;font-weight:600;padding:5px 6px;text-align:left}
table.t td{padding:4px 6px;border-bottom:1px solid #E5E7EB}tr.g td{font-weight:600}table.t a{color:#1F5BD6}
table.kpi{border-collapse:separate;border-spacing:8px 0;margin:0 -8px 14px}table.kpi td{background:#F5F7FA;padding:10px 14px;min-width:120px}.kpi .v{font-size:${fs + 9}px;font-weight:600}
table.hf{width:100%;color:#6B7280;font-size:${fs - 2}px;margin:8px 0}.chart svg{max-width:100%;height:auto}hr{border:0;border-top:1px solid #D9DDE3}
@media print{body{margin:0}table.t thead{display:table-header-group}tr{page-break-inside:avoid}}`;
  const body = `${hf(m.header)}${parts.join('\n')}${hf(m.footer)}`;
  const html = opts.bodyOnly
    ? `<div style="font-family:Segoe UI,Roboto,Arial,sans-serif;font-size:${fs}px;color:#111827"><style>${css.replace(/body\{[^}]*\}/, '')}</style>${body}</div>`
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(m.title)}</title><style>${css}</style></head><body>${body}</body></html>`;
  return { html, attachments };
}

// ───────────────────────── CSV / JSON ─────────────────────────

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Formula-injection guard for spreadsheet apps
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV of every data region (SSRS-style: detail rows with raw values; summary-only tables export their subtotal rows). */
export function renderCsv(m: RenderedReport): Buffer {
  const blocks: string[] = [];
  for (const it of m.items) {
    if (it.type === 'table' && !it.empty) {
      const hasData = it.rows.some((r) => r.kind === 'data');
      const lines = [it.columns.map((c) => csvCell(c.header)).join(',')];
      for (const r of it.rows) {
        if (hasData ? r.kind !== 'data' : r.kind !== 'subtotal') continue;
        lines.push(r.cells.map((c) => csvCell(c.v ?? (c.t || null))).join(','));
      }
      blocks.push(lines.join('\r\n'));
    }
    if (it.type === 'matrix' && !it.empty) {
      const lines = [[...it.rowHeaders, ...it.columns, ...(it.rowTotals ? ['Total'] : [])].map(csvCell).join(',')];
      for (const r of it.rows) lines.push([...r.labels, ...r.cells.map((c) => c.v), ...(r.total ? [r.total.v] : [])].map(csvCell).join(','));
      blocks.push(lines.join('\r\n'));
    }
  }
  return Buffer.from(`﻿${blocks.join('\r\n\r\n')}\r\n`, 'utf8');
}

export function renderJson(m: RenderedReport, data?: Record<string, QueryResult>): Buffer {
  const out = {
    report: m.title,
    executedAt: m.executedAt,
    parameters: Object.fromEntries(m.parameters.map((p) => [p.name, p.display])),
    datasets: data
      ? Object.fromEntries(Object.entries(data).map(([k, r]) => [k, { columns: r.columns, rows: r.rows, truncated: r.truncated }]))
      : undefined,
    items: data ? undefined : m.items.filter((i) => i.type === 'table' || i.type === 'matrix'),
  };
  return Buffer.from(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), 'utf8');
}
