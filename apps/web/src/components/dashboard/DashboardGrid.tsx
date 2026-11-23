import { useMemo, useRef, type ReactNode } from 'react';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import { Box } from '@mui/material';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import type { Panel } from '@/api/types';

const ResponsiveGrid = WidthProvider(Responsive);

interface Props {
  panels: Panel[];
  editing: boolean;
  onLayoutChange: (positions: Record<string, Panel['gridPos']>) => void;
  renderPanel: (p: Panel) => ReactNode;
}

/**
 * 24-column drag-and-drop grid (Grafana convention). On narrow screens panels stack
 * full-width; layout edits are only persisted from the large breakpoint.
 */
export function DashboardGrid({ panels, editing, onLayoutChange, renderPanel }: Props) {
  const breakpoint = useRef('lg');
  const layouts = useMemo(() => {
    const lg: Layout[] = panels.map((p) => ({ i: p.id, ...p.gridPos, minW: 2, minH: 2 }));
    const sm: Layout[] = [...panels]
      .sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x)
      .reduce<{ acc: Layout[]; y: number }>(
        (s, p) => {
          s.acc.push({ i: p.id, x: 0, y: s.y, w: 1, h: p.gridPos.h });
          s.y += p.gridPos.h;
          return s;
        },
        { acc: [], y: 0 },
      ).acc;
    return { lg, sm };
  }, [panels]);

  return (
    <Box
      sx={{
        mx: -0.5,
        '& .react-grid-item.react-grid-placeholder': { bgcolor: 'primary.main', opacity: 0.15, borderRadius: 1 },
        '& .react-resizable-handle': { opacity: editing ? 0.7 : 0 },
        '& .react-resizable-handle::after': { borderColor: 'text.secondary' },
      }}
    >
      <ResponsiveGrid
        layouts={layouts}
        breakpoints={{ lg: 900, sm: 0 }}
        cols={{ lg: 24, sm: 1 }}
        rowHeight={30}
        margin={[8, 8]}
        containerPadding={[4, 4]}
        isDraggable={editing}
        isResizable={editing}
        draggableHandle=".panel-drag-handle"
        compactType="vertical"
        onBreakpointChange={(bp) => (breakpoint.current = bp)}
        onLayoutChange={(current) => {
          if (!editing || breakpoint.current !== 'lg') return;
          const pos: Record<string, Panel['gridPos']> = {};
          for (const l of current) pos[l.i] = { x: l.x, y: l.y, w: l.w, h: l.h };
          onLayoutChange(pos);
        }}
      >
        {panels.map((p) => (
          <div key={p.id}>{renderPanel(p)}</div>
        ))}
      </ResponsiveGrid>
    </Box>
  );
}
