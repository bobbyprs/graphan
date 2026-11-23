import type { Response } from 'express';
import ExcelJS from 'exceljs';
import type { QueryResult } from '../../connectors/types';

export type ExportFormat = 'csv' | 'json' | 'xlsx';

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeFilename(name: string) {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'export';
}

export async function sendExport(res: Response, result: QueryResult, format: ExportFormat, baseName = 'query-results') {
  const file = `${safeFilename(baseName)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  const cols = result.columns.map((c) => c.name);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.json"`);
    res.send(JSON.stringify(result.rows, null, 2));
    return;
  }

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    res.write('﻿' + cols.map(csvCell).join(',') + '\n');
    for (const row of result.rows) res.write(cols.map((c) => csvCell(row[c])).join(',') + '\n');
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet('Results');
  ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(Math.max(c.length + 2, 12), 50) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for (const row of result.rows) {
    ws.addRow(cols.map((c) => {
      const v = row[c];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    })).commit();
  }
  ws.commit();
  await wb.commit();
}
