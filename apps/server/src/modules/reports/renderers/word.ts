import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import { PAGE_TOKEN, type RCell, type RenderedReport, type RItem, type RTableRow } from '../rendered';
import { decodeDataUri, MM, PAGE_PT, svgToPng } from './assets';

const TWIP_PER_PT = 20;
const hex = (c?: string) => c?.replace('#', '').slice(0, 6);
const GROUP = ['DCE6F5', 'E9EFF8', 'F3F6FB', 'F7F9FC', 'FAFBFD'];
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const LINE = { style: BorderStyle.SINGLE, size: 2, color: 'D9DDE3' };
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;

/** Text with {{Globals.PageNumber}} / {{Globals.TotalPages}} turned into Word fields. */
function runsWithPageFields(s: string, size: number, color?: string): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let last = 0;
  for (const m of s.matchAll(PAGE_TOKEN)) {
    if (m.index! > last) out.push(new TextRun({ text: s.slice(last, m.index), size, color }));
    out.push(new TextRun({ children: [m[1].toLowerCase() === 'pagenumber' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES], size, color }));
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(new TextRun({ text: s.slice(last), size, color }));
  return out;
}

function threePart(o: { left: string; center: string; right: string }, fs: number) {
  const size = Math.round((fs - 1) * 2);
  const cell = (t: string, a: keyof typeof ALIGN) =>
    new TableCell({ borders: { top: NONE, bottom: NONE, left: NONE, right: NONE }, children: [new Paragraph({ alignment: ALIGN[a], children: runsWithPageFields(t, size, '6B7280') })] });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: [new TableRow({ children: [cell(o.left, 'left'), cell(o.center, 'center'), cell(o.right, 'right')] })],
  });
}

const cellPara = (c: RCell, align: keyof typeof ALIGN, size: number) =>
  new Paragraph({ alignment: ALIGN[align], children: [new TextRun({ text: c.t, bold: c.bold, color: hex(c.color ?? (c.link ? '#1F5BD6' : undefined)), underline: c.link ? {} : undefined, size })] });

function tcell(children: Paragraph[], opts: { fill?: string; span?: number; indent?: number } = {}) {
  return new TableCell({
    children,
    columnSpan: opts.span,
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
    margins: { top: 30, bottom: 30, left: 60 + (opts.indent ?? 0), right: 60 },
    borders: { top: LINE, bottom: LINE, left: NONE, right: NONE },
  });
}

function table(it: Extract<RItem, { type: 'table' }>, fs: number, widthTw: number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  if (it.title) out.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: it.title, bold: true, size: (fs + 2) * 2 })] }));
  if (it.empty) return [...out, new Paragraph({ children: [new TextRun({ text: it.empty, italics: true, color: '6B7280', size: fs * 2 })] })];
  const n = it.columns.length;
  const size = Math.round((n > 10 ? Math.max(5.5, fs - (n - 10) * 0.25) : fs) * 2);
  const sum = it.columns.reduce((a, c) => a + c.width, 0);
  const colW = it.columns.map((c) => Math.round((widthTw * c.width) / sum));
  const head = new TableRow({
    tableHeader: it.repeatHeader,
    children: it.columns.map((c) => tcell([new Paragraph({ alignment: ALIGN[c.align], children: [new TextRun({ text: c.header, bold: true, color: 'FFFFFF', size })] })], { fill: '2F3B52' })),
  });
  const segments: RTableRow[][] = [[]];
  for (const r of it.rows) {
    if (r.pageBreakBefore && segments[segments.length - 1].length) segments.push([]);
    segments[segments.length - 1].push(r);
  }
  segments.forEach((rows, si) => {
    if (si > 0) out.push(new Paragraph({ children: [new PageBreak()] }));
    const body = rows.map((r, ri) => {
      if (r.kind === 'group') {
        return new TableRow({
          cantSplit: true,
          children: [tcell([new Paragraph({ children: [new TextRun({ text: `${r.label ?? ''}  (${(r.count ?? 0).toLocaleString()})`, bold: true, size })] })], { span: n, fill: GROUP[Math.min(r.level, 4)], indent: r.level * 160 })],
        });
      }
      const fill = r.kind === 'total' ? 'E2E6EC' : r.kind === 'subtotal' ? 'F1F3F6' : it.zebra && ri % 2 ? 'FAFAFB' : undefined;
      return new TableRow({
        cantSplit: true,
        children: r.cells.map((c, i) => tcell([cellPara(c, it.columns[i].align, size)], { fill: hex(c.bg) ?? fill, indent: i === 0 ? (r.kind === 'data' ? it.groupLevels : r.level) * 160 : 0 })),
      });
    });
    out.push(new Table({ layout: TableLayoutType.FIXED, columnWidths: colW, width: { size: widthTw, type: WidthType.DXA }, rows: [head, ...body] }));
  });
  out.push(new Paragraph({ text: '' }));
  return out;
}

function matrix(it: Extract<RItem, { type: 'matrix' }>, fs: number, widthTw: number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  if (it.title) out.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: it.title, bold: true, size: (fs + 2) * 2 })] }));
  if (it.empty) return [...out, new Paragraph({ children: [new TextRun({ text: it.empty, italics: true, size: fs * 2 })] })];
  const heads = [...it.rowHeaders, ...it.columns, ...(it.rowTotals ? ['Total'] : [])];
  const size = Math.round((heads.length > 10 ? Math.max(5, fs - (heads.length - 10) * 0.3) : fs) * 2);
  const w = Math.round(widthTw / heads.length);
  const rows = [
    new TableRow({
      tableHeader: true,
      children: heads.map((h, i) => tcell([new Paragraph({ alignment: i < it.rowHeaders.length ? AlignmentType.LEFT : AlignmentType.RIGHT, children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size })] })], { fill: '2F3B52' })),
    }),
    ...it.rows.map(
      (r) =>
        new TableRow({
          children: [
            ...r.labels.map((l) => tcell([new Paragraph({ children: [new TextRun({ text: l, size })] })])),
            ...r.cells.map((c) => tcell([cellPara(c, 'right', size)])),
            ...(r.total ? [tcell([cellPara(r.total, 'right', size)], { fill: 'F1F3F6' })] : []),
          ],
        }),
    ),
  ];
  if (it.columnTotals) {
    rows.push(
      new TableRow({
        children: [
          tcell([new Paragraph({ children: [new TextRun({ text: 'Total', bold: true, size })] })], { fill: 'E2E6EC', span: it.rowHeaders.length }),
          ...[...it.columnTotals, ...(it.grandTotal ? [it.grandTotal] : [])].map((c) => tcell([cellPara(c, 'right', size)], { fill: 'E2E6EC' })),
        ],
      }),
    );
  }
  out.push(new Table({ layout: TableLayoutType.FIXED, columnWidths: heads.map(() => w), width: { size: widthTw, type: WidthType.DXA }, rows }), new Paragraph({ text: '' }));
  return out;
}

function image(png: Buffer, wPx: number, hPx: number, maxWidthPx: number, align: keyof typeof ALIGN = 'left') {
  const scale = Math.min(1, maxWidthPx / wPx);
  return new Paragraph({ alignment: ALIGN[align], children: [new ImageRun({ type: 'png', data: png, transformation: { width: Math.round(wPx * scale), height: Math.round(hPx * scale) } })] });
}

export async function renderWord(m: RenderedReport): Promise<Buffer> {
  const [w, h] = PAGE_PT[m.page.size];
  const landscape = m.page.orientation === 'landscape';
  const [mt, mr, mb, ml] = m.page.margins.map((x) => Math.round(x * MM * TWIP_PER_PT));
  const pageWTw = Math.round((landscape ? h : w) * TWIP_PER_PT);
  const contentTw = pageWTw - ml - mr;
  const contentPx = Math.round((contentTw / TWIP_PER_PT) * (96 / 72));
  const fs = m.page.fontSize;
  const children: (Paragraph | Table)[] = [];

  if (m.showTitle) {
    children.push(new Paragraph({ children: [new TextRun({ text: m.title, bold: true, size: (fs + 9) * 2 })] }));
    if (m.description) children.push(new Paragraph({ children: [new TextRun({ text: m.description, color: '6B7280', size: fs * 2 })] }));
  }
  if (m.showParameters) {
    const vis = m.parameters.filter((p) => !p.hidden);
    if (vis.length) children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: vis.map((p) => `${p.label}: ${p.display || '—'}`).join('   ·   '), color: '6B7280', size: (fs - 1) * 2 })] }));
  }

  for (const it of m.items) {
    switch (it.type) {
      case 'text':
        children.push(
          ...it.text.split('\n').map(
            (line) =>
              new Paragraph({
                alignment: ALIGN[it.style.align ?? 'left'],
                children: [new TextRun({ text: line, bold: it.style.bold, italics: it.style.italic, color: hex(it.style.color), size: Math.round((it.style.fontSize ?? fs) * 2), shading: it.style.background ? { type: ShadingType.CLEAR, fill: hex(it.style.background)!, color: 'auto' } : undefined })],
              }),
          ),
        );
        break;
      case 'table':
        children.push(...table(it, fs, contentTw));
        break;
      case 'matrix':
        children.push(...matrix(it, fs, contentTw));
        break;
      case 'chart': {
        if (it.title) children.push(new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: it.title, bold: true, size: (fs + 2) * 2 })] }));
        if (!it.svg) {
          children.push(new Paragraph({ children: [new TextRun({ text: it.empty ?? 'No data', italics: true, size: fs * 2 })] }));
          break;
        }
        const img = svgToPng(it.svg, contentPx * 2);
        children.push(image(img.png, img.width / 2, img.height / 2, contentPx));
        break;
      }
      case 'kpi':
        if (it.title) children.push(new Paragraph({ children: [new TextRun({ text: it.title, bold: true, size: (fs + 2) * 2 })] }));
        children.push(
          new Table({
            width: { size: contentTw, type: WidthType.DXA },
            columnWidths: it.cards.map(() => Math.round(contentTw / it.cards.length)),
            rows: [
              new TableRow({
                children: it.cards.map(
                  (c) =>
                    new TableCell({
                      shading: { type: ShadingType.CLEAR, fill: 'F5F7FA', color: 'auto' },
                      borders: { top: NONE, bottom: NONE, left: { style: BorderStyle.SINGLE, size: 24, color: 'FFFFFF' }, right: { style: BorderStyle.SINGLE, size: 24, color: 'FFFFFF' } },
                      margins: { top: 100, bottom: 100, left: 120, right: 120 },
                      children: [
                        new Paragraph({ children: [new TextRun({ text: c.label, color: '6B7280', size: (fs - 1) * 2 })] }),
                        new Paragraph({ children: [new TextRun({ text: c.value, bold: true, size: (fs + 8) * 2, color: hex(c.color) })] }),
                        ...(c.note ? [new Paragraph({ children: [new TextRun({ text: c.note, color: '6B7280', size: (fs - 2) * 2 })] })] : []),
                      ],
                    }),
                ),
              }),
            ],
          }),
          new Paragraph({ text: '' }),
        );
        break;
      case 'image': {
        const { mime, data } = decodeDataUri(it.src);
        if (mime.includes('svg')) {
          const img = svgToPng(data.toString('utf8'), it.width * 2);
          children.push(image(img.png, img.width / 2, img.height / 2, contentPx, it.align));
        } else {
          children.push(new Paragraph({ alignment: ALIGN[it.align], children: [new ImageRun({ type: mime.includes('png') ? 'png' : 'jpg', data, transformation: { width: it.width, height: Math.round(it.width / 2) } })] }));
        }
        break;
      }
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      case 'divider':
        children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D9DDE3', space: 1 } }, text: '' }));
        break;
      case 'error':
        children.push(new Paragraph({ children: [new TextRun({ text: `#Error ${it.title ?? ''}: ${it.message}`, color: 'B91C1C', size: fs * 2 })] }));
        break;
    }
  }

  const doc = new Document({
    creator: 'Graphan',
    title: m.title,
    styles: { default: { document: { run: { font: 'Calibri', size: fs * 2 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: Math.round(w * TWIP_PER_PT), height: Math.round(h * TWIP_PER_PT), orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
            margin: { top: mt, right: mr, bottom: mb, left: ml, header: Math.round(mt / 3), footer: Math.round(mb / 3) },
          },
        },
        headers: { default: new Header({ children: [threePart(m.header, fs)] }) },
        footers: { default: new Footer({ children: [threePart(m.footer, fs)] }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
