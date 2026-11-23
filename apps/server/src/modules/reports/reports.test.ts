import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { evaluateText, formatValue, resolveDateKeyword, aggregate, type ExpressionScope } from './format';
import { reportDefinitionSchema } from './report.schema';
import type { RenderedReport } from './rendered';
import { renderPdf } from './renderers/pdf';
import { renderExcel } from './renderers/excel';
import { renderWord } from './renderers/word';
import { renderCsv, renderHtml } from './renderers/html';

const fmt = { locale: 'en-US', currency: '$', timezone: 'UTC' };

test('formatValue: SSRS-style codes', () => {
  assert.equal(formatValue(1234.5, 'N0', fmt), '1,235');
  assert.equal(formatValue(1234.5, 'N2', fmt), '1,234.50');
  assert.equal(formatValue(-1234.5, 'C2', fmt), '-$1,234.50');
  assert.equal(formatValue(0.1234, 'P1', fmt), '12.3%');
  assert.equal(formatValue(1234.5, 'F1', fmt), '1234.5');
  assert.equal(formatValue(new Date('2026-03-05T14:07:00Z'), 'dd-MMM-yyyy HH:mm', fmt), '05-Mar-2026 14:07');
  assert.equal(formatValue('2026-03-05', 'D', fmt), '2026-03-05');
  assert.equal(formatValue(28749, undefined, fmt), '28749', 'unformatted numbers have no grouping (ids)');
  assert.equal(formatValue(null, 'N2', fmt), '');
});

test('aggregate functions', () => {
  const rows = [{ a: 1 }, { a: '2.5' }, { a: null }, { a: 4 }];
  assert.equal(aggregate(rows, 'a', 'sum'), 7.5);
  assert.equal(aggregate(rows, 'a', 'avg'), 2.5);
  assert.equal(aggregate(rows, 'a', 'count'), 3);
  assert.equal(aggregate(rows, 'a', 'max'), 4);
  assert.equal(aggregate([{ a: 'x' }, { a: 'x' }, { a: 'y' }], 'a', 'countDistinct'), 2);
});

test('expressions: globals, parameters, dataset aggregates, unknown → #Error', () => {
  const scope: ExpressionScope = {
    fmt,
    reportName: 'Sales',
    executionTime: new Date('2026-01-02T03:04:00Z'),
    user: 'Jane',
    parameters: { region: ['North', 'South'] },
    parameterLabels: { region: 'North, South' },
    datasets: { s: { columns: [], rows: [{ v: 10 }, { v: 32.5 }], rowCount: 2, truncated: false, durationMs: 1 } },
  };
  assert.equal(evaluateText('{{Globals.ReportName}} by {{User.Name}}', scope), 'Sales by Jane');
  assert.equal(evaluateText('Regions: {{Parameters.region}}', scope), 'Regions: North, South');
  assert.equal(evaluateText('{{Sum(s.v, C2)}} / {{Count(s)}}', scope), '$42.50 / 2');
  assert.equal(evaluateText('{{Nope(s.v)}}', scope), '#Error');
  assert.equal(evaluateText('Page {{Globals.PageNumber}}', { ...scope, keepPageTokens: true }), 'Page {{Globals.PageNumber}}');
});

test('date keywords resolve to calendar dates', () => {
  assert.match(resolveDateKeyword('today', 'UTC'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(resolveDateKeyword('startOfYear', 'UTC').slice(5), '01-01');
  assert.equal(resolveDateKeyword('2026-05-01', 'UTC'), '2026-05-01');
});

test('definition schema applies defaults and rejects bad names', () => {
  const d = reportDefinitionSchema.parse({});
  assert.equal(d.page.size, 'A4');
  assert.match(d.footer.right, /PageNumber/);
  assert.throws(() => reportDefinitionSchema.parse({ parameters: [{ name: '1bad' }] }));
  assert.throws(() => reportDefinitionSchema.parse({ body: [{ id: 'i', type: 'image', src: 'https://evil.example/x.png' }] }), 'remote images are rejected (no SSRF)');
});

// A small rendered report exercising every item type
const model: RenderedReport = {
  reportId: 'r1',
  title: 'Test report',
  description: 'desc',
  page: { size: 'A4', orientation: 'portrait', margins: [15, 12, 15, 12], fontSize: 9 },
  header: { left: 'H', center: '', right: '' },
  footer: { left: '', center: '', right: 'Page {{Globals.PageNumber}} of {{Globals.TotalPages}}' },
  showTitle: true,
  showParameters: true,
  executedAt: new Date().toISOString(),
  user: 'tester',
  parameters: [{ name: 'p', label: 'P', display: 'x', hidden: false }],
  items: [
    { type: 'text', id: 't', text: 'Hello', style: { bold: true } },
    { type: 'kpi', id: 'k', cards: [{ label: 'Revenue', value: '$1' }] },
    {
      type: 'table',
      id: 'tb',
      columns: [
        { field: 'name', header: 'Name', align: 'left', width: 2 },
        { field: 'amt', header: 'Amount', align: 'right', width: 1, format: 'C2' },
      ],
      rows: [
        { kind: 'group', level: 0, anc: [], key: 'g1', label: 'Group A', cells: [], count: 2 },
        { kind: 'data', level: 1, anc: ['g1'], cells: [{ v: '=cmd()', t: '=cmd()' }, { v: 10, t: '$10.00' }] },
        { kind: 'data', level: 1, anc: ['g1'], cells: [{ v: 'b', t: 'b', link: { reportId: 'r2', params: { x: 1 } } }, { v: 5, t: '$5.00', color: '#B91C1C' }] },
        { kind: 'subtotal', level: 0, anc: [], cells: [{ v: 'Total A', t: 'Total A', bold: true }, { v: 15, t: '$15.00', bold: true }] },
        { kind: 'total', level: 0, anc: [], cells: [{ v: 'Grand total', t: 'Grand total', bold: true }, { v: 15, t: '$15.00', bold: true }] },
      ],
      repeatHeader: true,
      zebra: true,
      dataRows: 2,
      groupLevels: 1,
    },
    { type: 'matrix', id: 'm', rowHeaders: ['region'], columns: ['a', 'b'], rows: [{ labels: ['N'], cells: [{ v: 1, t: '1' }, { v: 2, t: '2' }], total: { v: 3, t: '3' } }], columnTotals: [{ v: 1, t: '1' }, { v: 2, t: '2' }], grandTotal: { v: 3, t: '3' }, rowTotals: true, format: 'N0' },
    {
      type: 'chart',
      id: 'c',
      height: 200,
      option: {},
      svg: '<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="10" y="10" width="100" height="150" fill="#3871DC"/><text x="10" y="190">A</text></svg>',
    },
    { type: 'pageBreak', id: 'pb' },
    { type: 'error', id: 'e', message: 'boom' },
  ],
  datasets: [],
  rowCount: 2,
  durationMs: 1,
  fmt,
};

test('PDF renderer produces a PDF', async () => {
  const buf = await renderPdf(model);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 2000);
});

test('Excel renderer keeps numbers, formats, outline levels and hyperlinks', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await renderExcel(model)) as unknown as ExcelJS.Buffer);
  assert.equal(wb.worksheets.length, 2, 'page break starts a new sheet');
  const ws = wb.worksheets[0];
  let amount: ExcelJS.Cell | undefined;
  let link: ExcelJS.Cell | undefined;
  ws.eachRow((row) => {
    row.eachCell((c) => {
      if (c.value === 10) amount = c;
      if (typeof c.value === 'object' && c.value && 'hyperlink' in c.value) link = c;
    });
  });
  assert.ok(amount, 'raw number kept');
  assert.match(amount!.numFmt, /#,##0\.00/);
  assert.equal(amount!.row ? ws.getRow(Number(amount!.row)).outlineLevel : 0, 1);
  assert.match(String((link!.value as { hyperlink: string }).hyperlink), /\/reports\/r2\?p\.x=1/);
});

test('Word renderer produces a docx with header/footer', async () => {
  const buf = await renderWord(model);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(buf.includes(Buffer.from('word/footer')), 'footer part present');
});

test('CSV neutralises spreadsheet formulas', () => {
  const csv = renderCsv(model).toString('utf8');
  assert.match(csv, /'=cmd\(\)/);
  assert.match(csv, /Name,Amount/);
});

test('HTML renderer escapes and inlines charts', () => {
  const evil = { ...model, title: '<script>alert(1)</script>' };
  const { html } = renderHtml(evil, { charts: 'svg' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('<svg'));
  const mail = renderHtml(model, { charts: 'cid', bodyOnly: true });
  assert.equal(mail.attachments.length, 1);
  assert.ok(mail.html.includes('cid:chart-1@graphan'));
});
