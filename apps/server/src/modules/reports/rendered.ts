/** Output of the report engine: fully evaluated, format-independent. Rendered to HTML/PDF/Excel/Word/CSV. */

export interface DrillLink {
  reportId: string;
  params: Record<string, unknown>;
}

export interface RCell {
  /** raw value (numbers/dates kept for Excel) */
  v: unknown;
  /** display text */
  t: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  link?: DrillLink;
}

export interface RColumn {
  field: string;
  header: string;
  align: 'left' | 'center' | 'right';
  width: number;
  format?: string;
}

export interface RTableRow {
  kind: 'group' | 'data' | 'subtotal' | 'total';
  level: number;
  cells: RCell[];
  /** group rows: label spanning the row */
  label?: string;
  /** group rows: id used by the viewer toggle */
  key?: string;
  /** ancestor group keys (hidden when any of them is collapsed) */
  anc: string[];
  pageBreakBefore?: boolean;
  collapsed?: boolean;
  count?: number;
}

export type RItem =
  | { type: 'text'; id: string; text: string; style: { fontSize?: number; bold?: boolean; italic?: boolean; color?: string; background?: string; align?: 'left' | 'center' | 'right' } }
  | { type: 'table'; id: string; title?: string; columns: RColumn[]; rows: RTableRow[]; repeatHeader: boolean; zebra: boolean; empty?: string; dataRows: number; groupLevels: number }
  | {
      type: 'matrix';
      id: string;
      title?: string;
      rowHeaders: string[];
      columns: string[];
      rows: { labels: string[]; cells: RCell[]; total?: RCell }[];
      columnTotals?: RCell[];
      grandTotal?: RCell;
      rowTotals: boolean;
      format?: string;
      truncatedColumns?: number;
      empty?: string;
    }
  | { type: 'chart'; id: string; title?: string; height: number; option: Record<string, unknown>; svg: string; empty?: string }
  | { type: 'kpi'; id: string; title?: string; cards: { label: string; value: string; color?: string; note?: string }[] }
  | { type: 'image'; id: string; title?: string; src: string; width: number; align: 'left' | 'center' | 'right' }
  | { type: 'pageBreak'; id: string }
  | { type: 'divider'; id: string }
  | { type: 'error'; id: string; title?: string; message: string };

export interface RenderedReport {
  reportId: string;
  title: string;
  description?: string | null;
  page: { size: 'A4' | 'A3' | 'A5' | 'LETTER' | 'LEGAL'; orientation: 'portrait' | 'landscape'; margins: [number, number, number, number]; fontSize: number };
  /** Header/footer text; may contain {{Globals.PageNumber}} / {{Globals.TotalPages}} tokens */
  header: { left: string; center: string; right: string };
  footer: { left: string; center: string; right: string };
  showTitle: boolean;
  showParameters: boolean;
  executedAt: string;
  user: string;
  parameters: { name: string; label: string; display: string; hidden: boolean }[];
  items: RItem[];
  datasets: { name: string; rowCount: number; truncated: boolean; durationMs: number }[];
  /** Total data rows across data regions (used for "only send if data") */
  rowCount: number;
  durationMs: number;
  fmt: { locale: string; currency: string; timezone: string };
}

export const PAGE_TOKEN = /\{\{\s*Globals\.(PageNumber|TotalPages)\s*\}\}/gi;
export const substitutePage = (s: string, page: number | string, total: number | string) =>
  s.replace(PAGE_TOKEN, (_m, k: string) => String(k.toLowerCase() === 'pagenumber' ? page : total));
