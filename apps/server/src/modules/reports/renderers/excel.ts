import ExcelJS from 'exceljs';
import { env } from '../../../config/env';
import { excelFormat, toDate } from '../format';
import { PAGE_TOKEN, type RCell, type RenderedReport, type RItem } from '../rendered';
import { decodeDataUri, svgToPng } from './assets';

const PAPER: Record<string, number> = { LETTER: 1, LEGAL: 5, A3: 8, A4: 9, A5: 11 };
const argb = (hex?: string) => (hex ? `FF${hex.replace('#', '').padEnd(6, '0').slice(0, 6).toUpperCase()}` : undefined);
const fill = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex)! } });
const GROUP = ['#DCE6F5', '#E9EFF8', '#F3F6FB', '#F7F9FC', '#FAFBFD'];

/** Excel header/footer codes: &P page, &N pages; "&" must be doubled. */
const hf = (o: { left: string; center: string; right: string }) => {
  const x = (s: string) => s.replace(/&/g, '&&').replace(PAGE_TOKEN, (_m, k: string) => (k.toLowerCase() === 'pagenumber' ? '&P' : '&N'));
  return `&L${x(o.left)}&C${x(o.center)}&R${x(o.right)}`;
};

function link(c: RCell): string | undefined {
  if (!c.link) return undefined;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(c.link.params)) (Array.isArray(v) ? v : [v]).forEach((x) => q.append(`p.${k}`, String(x ?? '')));
  return `${env.APP_PUBLIC_URL}/reports/${c.link.reportId}?${q}`;
}

function setValue(cell: ExcelJS.Cell, c: RCell, fmt: string | undefined, m: RenderedReport) {
  const xf = excelFormat(fmt, m.fmt);
  let v: unknown = c.v;
  if (typeof v === 'string' && xf && /[ymdhs]/i.test(xf) && !/[#0]/.test(xf)) v = toDate(v) ?? v;
  if (v === null || v === undefined) cell.value = c.t === '' ? null : c.t;
  else if (typeof v === 'number' || v instanceof Date) cell.value = v;
  else if (typeof v === 'boolean') cell.value = v;
  else if (typeof v === 'bigint') cell.value = Number(v);
  else cell.value = c.t;
  if (xf && (typeof cell.value === 'number' || cell.value instanceof Date)) cell.numFmt = xf;
  const href = link(c);
  if (href) cell.value = { text: c.t, hyperlink: href };
  if (c.bold || c.color || href) cell.font = { bold: c.bold, color: c.color || href ? { argb: argb(c.color ?? '#1F5BD6') } : undefined, underline: !!href };
  if (c.bg) cell.fill = fill(c.bg);
}

export async function renderExcel(m: RenderedReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Graphan';
  wb.title = m.title;
  let sheetNo = 0;
  let ws!: ExcelJS.Worksheet;
  let row = 1;
  const widths: number[] = [];

  const newSheet = () => {
    sheetNo++;
    ws = wb.addWorksheet(sheetNo === 1 ? 'Report' : `Page ${sheetNo}`, {
      properties: { outlineProperties: { summaryBelow: true, summaryRight: false } },
      pageSetup: { paperSize: PAPER[m.page.size] as ExcelJS.PaperSize, orientation: m.page.orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
      headerFooter: { oddHeader: hf(m.header), oddFooter: hf(m.footer) },
      views: [{ showGridLines: false }],
    });
    row = 1;
    widths.length = 0;
  };
  const track = (col: number, text: string) => {
    widths[col] = Math.min(60, Math.max(widths[col] ?? 8, text.length + 2));
  };
  let maxLevel = 0;
  const finishSheet = () => {
    widths.forEach((w, i) => w && (ws.getColumn(i).width = w));
    // exceljs marks a row "collapsed" when its level >= outlineLevelRow, so keep this above the deepest level
    ws.properties.outlineLevelRow = maxLevel + 1;
    maxLevel = 0;
  };

  newSheet();
  if (m.showTitle) {
    ws.getCell(row, 1).value = m.title;
    ws.getCell(row, 1).font = { bold: true, size: 15 };
    row++;
    if (m.description) ws.getCell(row++, 1).value = m.description;
  }
  if (m.showParameters) {
    for (const p of m.parameters.filter((x) => !x.hidden)) {
      ws.getCell(row, 1).value = p.label;
      ws.getCell(row, 1).font = { bold: true, color: { argb: 'FF6B7280' } };
      ws.getCell(row, 2).value = p.display;
      row++;
    }
  }
  if (m.showTitle || m.showParameters) row++;

  const title = (t?: string) => {
    if (!t) return;
    ws.getCell(row, 1).value = t;
    ws.getCell(row, 1).font = { bold: true, size: 12 };
    row++;
  };
  const header = (labels: string[], aligns: string[]) => {
    labels.forEach((h, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = fill('#2F3B52');
      c.alignment = { horizontal: aligns[i] as 'left' };
      track(i + 1, h);
    });
    row++;
  };

  const items = async (it: RItem) => {
    switch (it.type) {
      case 'text': {
        const c = ws.getCell(row, 1);
        c.value = it.text;
        c.font = { bold: it.style.bold, italic: it.style.italic, size: it.style.fontSize ? Math.round(it.style.fontSize * 1.1) : undefined, color: it.style.color ? { argb: argb(it.style.color) } : undefined };
        row += 1;
        return;
      }
      case 'table': {
        title(it.title);
        if (it.empty) {
          ws.getCell(row++, 1).value = it.empty;
          row++;
          return;
        }
        header(
          it.columns.map((c) => c.header),
          it.columns.map((c) => c.align),
        );
        for (const r of it.rows) {
          const xr = ws.getRow(row);
          if (r.kind === 'group') {
            const c = ws.getCell(row, 1);
            c.value = `${'   '.repeat(r.level)}${r.label ?? ''} (${r.count ?? 0})`;
            c.font = { bold: true };
            for (let i = 1; i <= it.columns.length; i++) ws.getCell(row, i).fill = fill(GROUP[Math.min(r.level, GROUP.length - 1)]);
            xr.outlineLevel = r.level;
            maxLevel = Math.max(maxLevel, r.level);
          } else {
            r.cells.forEach((cell, i) => {
              const xc = ws.getCell(row, i + 1);
              setValue(xc, cell, it.columns[i].format, m);
              xc.alignment = { horizontal: it.columns[i].align };
              if (r.kind !== 'data') {
                xc.font = { ...xc.font, bold: true };
                xc.fill = fill(r.kind === 'total' ? '#E2E6EC' : '#F1F3F6');
              }
              track(i + 1, cell.t);
            });
            // Detail rows sit one outline level below their group so Excel's +/- collapses them
            xr.outlineLevel = r.kind === 'data' ? r.anc.length : r.kind === 'subtotal' ? r.level : 0;
            maxLevel = Math.max(maxLevel, xr.outlineLevel);
          }
          row++;
        }
        row++;
        return;
      }
      case 'matrix': {
        title(it.title);
        if (it.empty) {
          ws.getCell(row++, 1).value = it.empty;
          return;
        }
        const heads = [...it.rowHeaders, ...it.columns, ...(it.rowTotals ? ['Total'] : [])];
        header(
          heads,
          heads.map((_h, i) => (i < it.rowHeaders.length ? 'left' : 'right')),
        );
        for (const r of it.rows) {
          r.labels.forEach((l, i) => {
            ws.getCell(row, i + 1).value = l;
            track(i + 1, l);
          });
          [...r.cells, ...(r.total ? [r.total] : [])].forEach((c, i) => {
            const xc = ws.getCell(row, it.rowHeaders.length + i + 1);
            setValue(xc, c, it.format, m);
            track(it.rowHeaders.length + i + 1, c.t);
          });
          row++;
        }
        if (it.columnTotals) {
          ws.getCell(row, 1).value = 'Total';
          [...it.columnTotals, ...(it.grandTotal ? [it.grandTotal] : [])].forEach((c, i) => setValue(ws.getCell(row, it.rowHeaders.length + i + 1), c, it.format, m));
          for (let i = 1; i <= heads.length; i++) {
            ws.getCell(row, i).font = { bold: true };
            ws.getCell(row, i).fill = fill('#E2E6EC');
          }
          row++;
        }
        row++;
        return;
      }
      case 'chart': {
        title(it.title);
        if (!it.svg) {
          ws.getCell(row++, 1).value = it.empty ?? 'No data';
          return;
        }
        const { png, width, height } = svgToPng(it.svg, 1200);
        const id = wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: 'png' });
        const w = 720;
        const h = Math.round((height / width) * w);
        ws.addImage(id, { tl: { col: 0, row: row - 1 }, ext: { width: w, height: h } });
        row += Math.ceil(h / 20) + 1;
        return;
      }
      case 'kpi': {
        title(it.title);
        it.cards.forEach((c, i) => {
          const l = ws.getCell(row, i + 1);
          l.value = c.label;
          l.font = { color: { argb: 'FF6B7280' } };
          const v = ws.getCell(row + 1, i + 1);
          v.value = c.value;
          v.font = { bold: true, size: 14, color: c.color ? { argb: argb(c.color) } : undefined };
          track(i + 1, c.value);
          track(i + 1, c.label);
        });
        row += 3;
        return;
      }
      case 'image': {
        const { mime, data } = decodeDataUri(it.src);
        const png = mime.includes('svg') ? svgToPng(data.toString('utf8'), it.width * 2).png : data;
        const id = wb.addImage({ buffer: png as unknown as ExcelJS.Buffer, extension: mime.includes('jp') ? 'jpeg' : 'png' });
        ws.addImage(id, { tl: { col: 0, row: row - 1 }, ext: { width: it.width, height: it.width / 2 } });
        row += Math.ceil(it.width / 2 / 20) + 1;
        return;
      }
      case 'pageBreak':
        finishSheet();
        newSheet();
        return;
      case 'divider':
        row++;
        return;
      case 'error':
        ws.getCell(row, 1).value = `#Error ${it.title ?? ''}: ${it.message}`;
        ws.getCell(row, 1).font = { color: { argb: 'FFB91C1C' } };
        row += 2;
        return;
    }
  };
  for (const it of m.items) await items(it);
  finishSheet();
  return Buffer.from(await wb.xlsx.writeBuffer());
}
