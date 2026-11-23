import { decodeDataUri, MM, PAGE_PT, robotoFonts, svgToPng } from './assets';
import { substitutePage, type RCell, type RenderedReport, type RItem, type RTableRow } from '../rendered';

// pdfmake 0.2 has no bundled types
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter = require('pdfmake') as new (fonts: unknown) => { createPdfKitDocument(def: unknown): NodeJS.ReadableStream & { end(): void } };

type Node = Record<string, unknown> | string;

const C = {
  headerBg: '#2F3B52',
  headerFg: '#FFFFFF',
  group: ['#DCE6F5', '#E9EFF8', '#F3F6FB', '#F7F9FC', '#FAFBFD'],
  subtotalBg: '#F1F3F6',
  totalBg: '#E2E6EC',
  zebra: '#FAFAFB',
  line: '#D9DDE3',
  muted: '#6B7280',
  link: '#1F5BD6',
};

let printer: InstanceType<typeof PdfPrinter> | undefined;
function getPrinter() {
  const f = robotoFonts();
  printer ??= new PdfPrinter({ Roboto: { normal: f.regular, bold: f.medium, italics: f.italic, bolditalics: f.mediumItalic } });
  return printer;
}

const tableLayout = (zebra: boolean, rows: RTableRow[] | null) => ({
  hLineWidth: (i: number) => (i === 0 ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => C.line,
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2,
  paddingBottom: () => 2,
  fillColor: (i: number) => {
    if (i === 0) return C.headerBg;
    const r = rows?.[i - 1];
    if (!r) return zebra && i % 2 === 0 ? C.zebra : null;
    if (r.kind === 'group') return C.group[Math.min(r.level, C.group.length - 1)];
    if (r.kind === 'subtotal') return C.subtotalBg;
    if (r.kind === 'total') return C.totalBg;
    return zebra && i % 2 === 0 ? C.zebra : null;
  },
});

function cellNode(c: RCell, align: string, fontSize: number): Node {
  return {
    text: c.t,
    alignment: align,
    bold: c.bold,
    color: c.color ?? (c.link ? C.link : undefined),
    decoration: c.link ? 'underline' : undefined,
    fillColor: c.bg,
    fontSize,
  };
}

function widthsFor(weights: number[], contentWidth: number): number[] {
  const n = weights.length;
  const usable = contentWidth - n * 6 - (n + 1) * 0.5;
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.max(14, (usable * w) / sum));
}

function itemTitle(title: string | undefined, fs: number): Node[] {
  return title ? [{ text: title, bold: true, fontSize: fs + 2, margin: [0, 6, 0, 4] }] : [];
}

function tableNodes(it: Extract<RItem, { type: 'table' }>, fs: number, contentWidth: number): Node[] {
  const out: Node[] = [...itemTitle(it.title, fs)];
  if (it.empty) return [...out, { text: it.empty, italics: true, color: C.muted, margin: [0, 2, 0, 8] }];
  const n = it.columns.length;
  const size = n > 10 ? Math.max(5.5, fs - (n - 10) * 0.25) : fs;
  const widths = widthsFor(it.columns.map((c) => c.width), contentWidth);
  const head = it.columns.map((c) => ({ text: c.header, bold: true, color: C.headerFg, alignment: c.align, fontSize: size }));

  // pdfmake can't break pages inside a table, so "page break between groups" splits the table
  const segments: RTableRow[][] = [[]];
  for (const r of it.rows) {
    if (r.pageBreakBefore && segments[segments.length - 1].length) segments.push([]);
    segments[segments.length - 1].push(r);
  }
  segments.forEach((rows, si) => {
    const body = rows.map((r) => {
      if (r.kind === 'group') {
        return [{ text: `${r.label ?? ''}${r.count !== undefined ? `  (${r.count.toLocaleString()})` : ''}`, colSpan: n, bold: true, fontSize: size, margin: [r.level * 8, 0, 0, 0] }, ...Array(n - 1).fill({})];
      }
      return r.cells.map((c, i) => {
        const node = cellNode(c, it.columns[i].align, size) as Record<string, unknown>;
        if (i === 0 && r.kind === 'data' && it.groupLevels) node.margin = [Math.min(it.groupLevels, 4) * 8, 0, 0, 0];
        if (i === 0 && r.kind === 'subtotal') node.margin = [r.level * 8, 0, 0, 0];
        return node;
      });
    });
    out.push({
      table: { headerRows: it.repeatHeader ? 1 : 0, widths, body: [head, ...body], dontBreakRows: true },
      layout: tableLayout(it.zebra, rows),
      margin: [0, 0, 0, 10],
      pageBreak: si > 0 ? 'before' : undefined,
    });
  });
  return out;
}

function matrixNodes(it: Extract<RItem, { type: 'matrix' }>, fs: number, contentWidth: number): Node[] {
  const out: Node[] = [...itemTitle(it.title, fs)];
  if (it.empty) return [...out, { text: it.empty, italics: true, color: C.muted }];
  const nCols = it.rowHeaders.length + it.columns.length + (it.rowTotals ? 1 : 0);
  const size = nCols > 10 ? Math.max(5, fs - (nCols - 10) * 0.3) : fs;
  const widths = widthsFor([...it.rowHeaders.map(() => 1.6), ...it.columns.map(() => 1), ...(it.rowTotals ? [1.1] : [])], contentWidth);
  const head = [...it.rowHeaders, ...it.columns, ...(it.rowTotals ? ['Total'] : [])].map((h, i) => ({ text: h, bold: true, color: C.headerFg, alignment: i < it.rowHeaders.length ? 'left' : 'right', fontSize: size }));
  const body: Node[][] = it.rows.map((r) => [
    ...r.labels.map((l) => ({ text: l, fontSize: size })),
    ...r.cells.map((c) => cellNode(c, 'right', size)),
    ...(r.total ? [{ ...(cellNode(r.total, 'right', size) as object), fillColor: C.subtotalBg }] : []),
  ]);
  if (it.columnTotals) {
    body.push([
      { text: 'Total', bold: true, fontSize: size, fillColor: C.totalBg },
      ...it.rowHeaders.slice(1).map(() => ({ text: '', fillColor: C.totalBg })),
      ...it.columnTotals.map((c) => ({ ...(cellNode(c, 'right', size) as object), fillColor: C.totalBg })),
      ...(it.grandTotal ? [{ ...(cellNode(it.grandTotal, 'right', size) as object), fillColor: C.totalBg }] : []),
    ]);
  }
  out.push({ table: { headerRows: 1, widths, body: [head, ...body], dontBreakRows: true }, layout: tableLayout(true, null), margin: [0, 0, 0, 6] });
  if (it.truncatedColumns) out.push({ text: `${it.truncatedColumns} more column(s) not shown`, fontSize: fs - 1, color: C.muted });
  return [...out, { text: '', margin: [0, 0, 0, 6] }];
}

function itemNodes(it: RItem, fs: number, contentWidth: number): Node[] {
  switch (it.type) {
    case 'text':
      return [
        {
          text: it.text,
          fontSize: it.style.fontSize ?? fs,
          bold: it.style.bold,
          italics: it.style.italic,
          color: it.style.color,
          background: it.style.background,
          alignment: it.style.align ?? 'left',
          margin: [0, 2, 0, 6],
        },
      ];
    case 'table':
      return tableNodes(it, fs, contentWidth);
    case 'matrix':
      return matrixNodes(it, fs, contentWidth);
    case 'chart':
      // unbreakable: keep the title on the same page as its chart
      return [
        {
          unbreakable: true,
          stack: [
            ...itemTitle(it.title, fs),
            it.svg ? { image: `data:image/png;base64,${svgToPng(it.svg, 2000).png.toString('base64')}`, width: contentWidth, margin: [0, 0, 0, 10] } : { text: it.empty ?? 'No data', italics: true, color: C.muted, margin: [0, 0, 0, 8] },
          ],
        },
      ];
    case 'kpi': {
      const cards = it.cards.map((c) => ({
        stack: [
          { text: c.label, fontSize: fs - 1, color: C.muted },
          { text: c.value, fontSize: fs + 8, bold: true, color: c.color ?? '#111827', margin: [0, 2, 0, 0] },
          ...(c.note ? [{ text: c.note, fontSize: fs - 2, color: C.muted }] : []),
        ],
        fillColor: '#F5F7FA',
        margin: [6, 6, 6, 6],
      }));
      return [
        ...itemTitle(it.title, fs),
        { table: { widths: cards.map(() => '*'), body: [cards] }, layout: { hLineWidth: () => 0, vLineWidth: (i: number) => (i === 0 || i === cards.length ? 0 : 4), vLineColor: () => '#FFFFFF' }, margin: [0, 0, 0, 10] },
      ];
    }
    case 'image': {
      const { mime, data } = decodeDataUri(it.src);
      const width = Math.min(it.width * 0.75, contentWidth);
      return [mime.includes('svg') ? { image: `data:image/png;base64,${svgToPng(data.toString('utf8'), it.width * 3).png.toString('base64')}`, width, alignment: it.align, margin: [0, 0, 0, 6] } : { image: it.src, width, alignment: it.align, margin: [0, 0, 0, 6] }];
    }
    case 'pageBreak':
      return [{ text: '', pageBreak: 'after' }];
    case 'divider':
      return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 0.7, lineColor: C.line }], margin: [0, 4, 0, 8] }];
    case 'error':
      return [{ text: `${it.title ? `${it.title}: ` : ''}#Error — ${it.message}`, color: '#B91C1C', margin: [0, 2, 0, 6] }];
  }
}

function headerFooter(o: { left: string; center: string; right: string }, page: number, total: number, margins: number[], top: boolean, fs: number) {
  if (!o.left && !o.center && !o.right) return null;
  return {
    columns: [
      { text: substitutePage(o.left, page, total), alignment: 'left' },
      { text: substitutePage(o.center, page, total), alignment: 'center' },
      { text: substitutePage(o.right, page, total), alignment: 'right' },
    ],
    fontSize: fs - 1.5,
    color: C.muted,
    margin: top ? [margins[3], Math.max(6, margins[1] / 2 - 4), margins[1], 0] : [margins[3], 4, margins[1], 0],
  };
}

export function buildPdfDefinition(m: RenderedReport) {
  const [w, h] = PAGE_PT[m.page.size];
  const landscape = m.page.orientation === 'landscape';
  const pageWidth = landscape ? h : w;
  const margins = [m.page.margins[3] * MM, m.page.margins[0] * MM, m.page.margins[1] * MM, m.page.margins[2] * MM]; // pdfmake: left, top, right, bottom
  const contentWidth = pageWidth - margins[0] - margins[2];
  const fs = m.page.fontSize;

  const content: Node[] = [];
  if (m.showTitle) {
    content.push({ text: m.title, fontSize: fs + 9, bold: true, margin: [0, 0, 0, 2] });
    if (m.description) content.push({ text: m.description, color: C.muted, margin: [0, 0, 0, 2] });
  }
  if (m.showParameters) {
    const visible = m.parameters.filter((p) => !p.hidden);
    if (visible.length) content.push({ text: visible.map((p) => `${p.label}: ${p.display || '—'}`).join('   ·   '), fontSize: fs - 1, color: C.muted, margin: [0, 0, 0, 8] });
  }
  if (m.showTitle || m.showParameters) content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 1, lineColor: C.headerBg }], margin: [0, 0, 0, 10] });
  for (const it of m.items) content.push(...itemNodes(it, fs, contentWidth));

  return {
    info: { title: m.title, author: m.user, creator: 'Graphan', subject: m.description ?? undefined },
    pageSize: m.page.size,
    pageOrientation: m.page.orientation,
    pageMargins: margins,
    defaultStyle: { font: 'Roboto', fontSize: fs, lineHeight: 1.15 },
    header: (page: number, total: number) => headerFooter(m.header, page, total, margins, true, fs),
    footer: (page: number, total: number) => headerFooter(m.footer, page, total, margins, false, fs),
    content,
  };
}

export function renderPdf(m: RenderedReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = getPrinter().createPdfKitDocument(buildPdfDefinition(m));
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
