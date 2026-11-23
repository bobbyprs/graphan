import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { Box, useTheme } from '@mui/material';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import type { QueryResult } from '@/api/types';

const NUMERIC = /int|numeric|decimal|double|real|float|number|money|bigint|smallint/i;

interface Props {
  result?: QueryResult;
  height?: number | string;
  pagination?: boolean;
  pageSize?: number;
  onRowClick?: (row: Record<string, unknown>) => void;
  /** Show a pinned row-number column and the data type under each header (Query Tool style) */
  rowNumbers?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Default AG Grid header layout with an extra line for the column's data type. */
function headerTemplate(type: string) {
  return `<div class="ag-cell-label-container" role="presentation">
    <span data-ref="eMenu" class="ag-header-icon ag-header-cell-menu-button"></span>
    <span data-ref="eFilterButton" class="ag-header-icon ag-header-cell-filter-button"></span>
    <div data-ref="eLabel" class="ag-header-cell-label" role="presentation" style="flex-direction:column;align-items:flex-start;justify-content:center;line-height:1.15">
      <span style="display:flex;align-items:center;gap:2px;max-width:100%">
        <span data-ref="eText" class="ag-header-cell-text"></span>
        <span data-ref="eFilter" class="ag-header-icon ag-header-label-icon ag-filter-icon"></span>
        <span data-ref="eSortOrder" class="ag-header-icon ag-sort-order ag-hidden"></span>
        <span data-ref="eSortAsc" class="ag-header-icon ag-sort-ascending-icon ag-hidden"></span>
        <span data-ref="eSortDesc" class="ag-header-icon ag-sort-descending-icon ag-hidden"></span>
        <span data-ref="eSortNone" class="ag-header-icon ag-sort-none-icon ag-hidden"></span>
      </span>
      <span style="font-size:10px;font-weight:400;opacity:.6">${esc(type)}</span>
    </div>
  </div>`;
}

/** AG Grid wrapper: sortable, filterable, resizable columns; virtualised rows. */
export function ResultsGrid({ result, height = '100%', pagination = true, pageSize = 100, onRowClick, rowNumbers }: Props) {
  const theme = useTheme();
  const columnDefs = useMemo<ColDef[]>(
    () => [
      ...(rowNumbers && result?.columns.length
        ? [
            {
              colId: '__rownum',
              headerName: '',
              valueGetter: (p: { node: { rowIndex: number | null } | null }) => (p.node?.rowIndex ?? 0) + 1,
              pinned: 'left' as const,
              width: 64,
              minWidth: 50,
              maxWidth: 90,
              flex: 0,
              sortable: false,
              filter: false,
              resizable: false,
              cellStyle: { opacity: 0.55, textAlign: 'right' },
            },
          ]
        : []),
      ...(result?.columns ?? []).map((c) => ({
        field: c.name,
        headerName: c.name,
        headerTooltip: `${c.name} (${c.type})`,
        headerComponentParams: { template: headerTemplate(c.type) },
        filter: NUMERIC.test(c.type) ? 'agNumberColumnFilter' : 'agTextColumnFilter',
        type: NUMERIC.test(c.type) ? 'numericColumn' : undefined,
        valueFormatter: (p: { value: unknown }): string => (p.value !== null && typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value ?? 'NULL')),
        cellStyle: (p: { value: unknown }) => (p.value === null || p.value === undefined ? { opacity: 0.45, fontStyle: 'italic' } : null),
      })),
    ],
    [result?.columns, rowNumbers],
  ) as ColDef[];

  return (
    <Box
      className={theme.palette.mode === 'dark' ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}
      sx={{
        height,
        width: '100%',
        '--ag-font-family': theme.typography.fontFamily,
        '--ag-font-size': '12px',
        '--ag-background-color': theme.palette.background.paper,
        '--ag-header-background-color': theme.palette.mode === 'dark' ? '#22252b' : '#f4f5f5',
        '--ag-border-color': theme.palette.divider,
        '--ag-row-height': '30px',
        '--ag-header-height': rowNumbers ? '42px' : '34px',
      }}
    >
      <AgGridReact
        rowData={result?.rows ?? []}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true, minWidth: 90, flex: 1, floatingFilter: false }}
        pagination={pagination}
        paginationPageSize={pageSize}
        paginationPageSizeSelector={[20, 50, 100, 500, 1000]}
        enableCellTextSelection
        ensureDomOrder
        suppressFieldDotNotation
        animateRows={false}
        onRowClicked={(e) => e.data && onRowClick?.(e.data)}
        overlayNoRowsTemplate="<span style='opacity:.6'>No rows</span>"
      />
    </Box>
  );
}
