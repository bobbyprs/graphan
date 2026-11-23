import { useMemo, useState, type MouseEvent } from 'react';
import {
  Box,
  Collapse,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ChevronRight from '@mui/icons-material/ChevronRight';
import TableChartOutlined from '@mui/icons-material/TableChartOutlined';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import ViewInArOutlined from '@mui/icons-material/ViewInArOutlined';
import FunctionsIcon from '@mui/icons-material/Functions';
import SettingsSuggestOutlined from '@mui/icons-material/SettingsSuggestOutlined';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FolderOutlined from '@mui/icons-material/FolderOutlined';
import ViewColumnOutlined from '@mui/icons-material/ViewColumnOutlined';
import KeyIcon from '@mui/icons-material/Key';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useQueryClient } from '@tanstack/react-query';
import { useExplorerSearch, useObjects, useSchemas, useTableDetails } from '@/api/hooks';
import type { DbObject } from '@/api/types';
import { formatNumber } from '@/utils/format';

export type TreeAction =
  | 'properties'
  | 'view-100'
  | 'view-all'
  | 'count'
  | 'script-create'
  | 'script-select'
  | 'script-insert'
  | 'script-update'
  | 'script-delete'
  | 'copy-name';

const KIND_ICON: Record<DbObject['kind'], JSX.Element> = {
  table: <TableChartOutlined fontSize="small" />,
  collection: <TableChartOutlined fontSize="small" />,
  view: <VisibilityOutlined fontSize="small" />,
  materialized_view: <ViewInArOutlined fontSize="small" />,
  sequence: <FormatListNumberedIcon fontSize="small" />,
  procedure: <SettingsSuggestOutlined fontSize="small" />,
  function: <FunctionsIcon fontSize="small" />,
};

const GROUPS: { kind: DbObject['kind'][]; label: string }[] = [
  { kind: ['table', 'collection'], label: 'Tables' },
  { kind: ['view'], label: 'Views' },
  { kind: ['materialized_view'], label: 'Materialized Views' },
  { kind: ['sequence'], label: 'Sequences' },
  { kind: ['procedure'], label: 'Procedures' },
  { kind: ['function'], label: 'Functions' },
];

const isRelation = (k: DbObject['kind']) => k === 'table' || k === 'view' || k === 'materialized_view' || k === 'collection';

function ColumnsNode({ dsId, o }: { dsId: string; o: DbObject }) {
  const { data, isLoading } = useTableDetails(dsId, o.schema, o.name);
  if (isLoading) return <Box sx={{ pl: 9, pr: 1 }}><Skeleton height={20} /></Box>;
  return (
    <>
      {data?.columns.map((c) => (
        <ListItemButton key={c.name} sx={{ pl: 9, py: 0 }} disableRipple>
          <ListItemIcon sx={{ minWidth: 24 }}>
            {c.isPrimaryKey ? <KeyIcon sx={{ fontSize: 15, color: 'warning.main' }} /> : <ViewColumnOutlined sx={{ fontSize: 16 }} />}
          </ListItemIcon>
          <ListItemText primary={c.name} primaryTypographyProps={{ fontSize: 12.5, noWrap: true }} />
          <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: 1, maxWidth: 110 }}>
            {c.dataType}
            {c.nullable ? '' : ' ·NN'}
          </Typography>
        </ListItemButton>
      ))}
    </>
  );
}

function ObjectNode({ dsId, o, onAction, onMenu }: { dsId: string; o: DbObject; onAction: (a: TreeAction, o: DbObject) => void; onMenu: (e: MouseEvent<HTMLElement>, o: DbObject) => void }) {
  const [open, setOpen] = useState(false);
  const rel = isRelation(o.kind);
  return (
    <>
      <ListItemButton
        sx={{ pl: rel ? 4.5 : 6, py: 0, '&:hover .obj-menu': { opacity: 1 } }}
        onClick={() => onAction(rel ? 'properties' : 'script-create', o)}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e, o);
        }}
      >
        {rel && (
          <Box
            component="span"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            sx={{ display: 'flex', mr: 0.25 }}
          >
            {open ? <ExpandMore sx={{ fontSize: 16 }} /> : <ChevronRight sx={{ fontSize: 16 }} />}
          </Box>
        )}
        <ListItemIcon sx={{ minWidth: 26 }}>{KIND_ICON[o.kind]}</ListItemIcon>
        <ListItemText primary={o.name} primaryTypographyProps={{ fontSize: 13, noWrap: true }} />
        {o.rowEstimate != null && o.rowEstimate > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            ~{formatNumber(o.rowEstimate)}
          </Typography>
        )}
        <IconButton
          className="obj-menu"
          size="small"
          sx={{ opacity: { xs: 1, md: 0 }, p: 0.25, ml: 0.25 }}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e, o);
          }}
          aria-label="Object actions"
        >
          <MoreVertIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </ListItemButton>
      {rel && (
        <Collapse in={open} unmountOnExit>
          <ColumnsNode dsId={dsId} o={o} />
        </Collapse>
      )}
    </>
  );
}

function SchemaNode({ dsId, schema, defaultOpen, filter, onAction, onMenu }: { dsId: string; schema: string; defaultOpen: boolean; filter: string; onAction: (a: TreeAction, o: DbObject) => void; onMenu: (e: MouseEvent<HTMLElement>, o: DbObject) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({ Tables: true });
  const { data, isLoading } = useObjects(open ? dsId : undefined, schema);
  const filtered = useMemo(() => (data ?? []).filter((o) => !filter || o.name.toLowerCase().includes(filter.toLowerCase())), [data, filter]);

  return (
    <>
      <ListItemButton onClick={() => setOpen((o) => !o)} sx={{ py: 0.25 }}>
        {open ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
        <ListItemIcon sx={{ minWidth: 28 }}><FolderOutlined fontSize="small" /></ListItemIcon>
        <ListItemText primary={schema} primaryTypographyProps={{ fontSize: 13, fontWeight: 500 }} />
      </ListItemButton>
      <Collapse in={open} unmountOnExit>
        {isLoading && <Box sx={{ pl: 5, pr: 1 }}>{[1, 2, 3].map((i) => <Skeleton key={i} height={22} />)}</Box>}
        {GROUPS.map((g) => {
          const items = filtered.filter((o) => g.kind.includes(o.kind));
          if (!items.length) return null;
          const isOpen = groupOpen[g.label] ?? !!filter;
          return (
            <Box key={g.label}>
              <ListItemButton sx={{ pl: 3, py: 0 }} onClick={() => setGroupOpen((s) => ({ ...s, [g.label]: !isOpen }))}>
                {isOpen ? <ExpandMore sx={{ fontSize: 16 }} /> : <ChevronRight sx={{ fontSize: 16 }} />}
                <ListItemText primary={`${g.label} (${items.length})`} primaryTypographyProps={{ fontSize: 12, color: 'text.secondary' }} />
              </ListItemButton>
              <Collapse in={isOpen} unmountOnExit>
                {items.map((o) => (
                  <ObjectNode key={`${o.kind}:${o.name}`} dsId={dsId} o={o} onAction={onAction} onMenu={onMenu} />
                ))}
              </Collapse>
            </Box>
          );
        })}
      </Collapse>
    </>
  );
}

/** pgAdmin-like object browser: schemas → object groups → objects → columns, with a context menu. */
export function SchemaTree({ dsId, onAction, onOpenColumn }: { dsId: string; onAction: (a: TreeAction, o: DbObject) => void; onOpenColumn: (o: DbObject, column: string) => void }) {
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; o: DbObject } | null>(null);
  const qc = useQueryClient();
  const { data: schemas, isLoading } = useSchemas(dsId);
  const { data: results } = useExplorerSearch(dsId, filter.length >= 2 ? filter : undefined);
  const columnHits = (results ?? []).filter((r) => r.kind === 'column').slice(0, 50);

  const openMenu = (e: MouseEvent<HTMLElement>, o: DbObject) => setMenu({ x: e.clientX, y: e.clientY, o });
  const act = (a: TreeAction) => {
    if (menu) onAction(a, menu.o);
    setMenu(null);
  };
  const o = menu?.o;
  const rel = o ? isRelation(o.kind) : false;
  const writable = o?.kind === 'table';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ p: 1, display: 'flex', gap: 0.5 }}>
        <TextField
          fullWidth
          placeholder="Search tables & columns"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <Tooltip title="Refresh">
          <IconButton
            onClick={() => qc.invalidateQueries({ predicate: (q) => ['schemas', 'objects', 'table', 'completion', 'ddl', 'search'].includes(String(q.queryKey[1])) })}
            aria-label="Refresh"
          >
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <List dense sx={{ flex: 1, overflow: 'auto', py: 0 }}>
        {isLoading && <Box sx={{ px: 2 }}>{[1, 2, 3, 4].map((i) => <Skeleton key={i} height={24} />)}</Box>}
        {schemas?.map((s, i) => (
          <SchemaNode key={s} dsId={dsId} schema={s} defaultOpen={i === 0 || ['public', 'dbo', 'main'].includes(s)} filter={filter} onAction={onAction} onMenu={openMenu} />
        ))}
        {columnHits.length > 0 && (
          <>
            <Typography variant="overline" sx={{ px: 2, display: 'block', mt: 1 }}>Matching columns</Typography>
            {columnHits.map((r) => (
              <ListItemButton key={`${r.schema}.${r.table}.${r.column}`} sx={{ pl: 2, py: 0 }} onClick={() => onOpenColumn({ schema: r.schema, name: r.table, kind: 'table' }, r.column!)}>
                <ListItemIcon sx={{ minWidth: 26 }}><ViewColumnOutlined fontSize="small" /></ListItemIcon>
                <ListItemText primary={r.column} secondary={`${r.schema}.${r.table}`} primaryTypographyProps={{ fontSize: 13 }} secondaryTypographyProps={{ fontSize: 11 }} />
              </ListItemButton>
            ))}
          </>
        )}
      </List>

      <Menu open={!!menu} onClose={() => setMenu(null)} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined} slotProps={{ paper: { sx: { minWidth: 220 } } }} MenuListProps={{ dense: true }}>
        {o && <ListSubheader sx={{ lineHeight: '28px', bgcolor: 'transparent' }}>{o.schema}.{o.name}</ListSubheader>}
        {rel && <MenuItem onClick={() => act('view-100')}>View data · first 100 rows</MenuItem>}
        {rel && <MenuItem onClick={() => act('view-all')}>View data · all rows</MenuItem>}
        {rel && <MenuItem onClick={() => act('count')}>Count rows</MenuItem>}
        {rel && <Divider />}
        <ListSubheader sx={{ lineHeight: '24px', bgcolor: 'transparent', fontSize: 11 }}>Scripts</ListSubheader>
        <MenuItem onClick={() => act('script-create')}>CREATE script</MenuItem>
        {rel && <MenuItem onClick={() => act('script-select')}>SELECT script</MenuItem>}
        {writable && <MenuItem onClick={() => act('script-insert')}>INSERT script</MenuItem>}
        {writable && <MenuItem onClick={() => act('script-update')}>UPDATE script</MenuItem>}
        {writable && <MenuItem onClick={() => act('script-delete')}>DELETE script</MenuItem>}
        <Divider />
        {rel && <MenuItem onClick={() => act('properties')}>Properties…</MenuItem>}
        <MenuItem onClick={() => act('copy-name')}>Copy qualified name</MenuItem>
      </Menu>
    </Box>
  );
}
