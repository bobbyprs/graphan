import { useState } from 'react';
import { Box, Button, ButtonGroup, Divider, List, ListItemButton, ListItemText, Menu, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import RefreshIcon from '@mui/icons-material/Refresh';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { describeRange, REFRESH_OPTIONS, TIME_PRESETS } from '@/utils/time';

type Range = { from: string; to: string };

export function TimeRangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  return (
    <>
      <Button
        variant="outlined"
        color="inherit"
        startIcon={<AccessTimeIcon fontSize="small" />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(e) => {
          setFrom(value.from);
          setTo(value.to);
          setAnchor(e.currentTarget);
        }}
        sx={{ borderColor: 'divider', whiteSpace: 'nowrap' }}
      >
        {describeRange(value)}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { width: 520, maxWidth: '95vw' } } }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} divider={<Divider flexItem orientation="vertical" />}>
          <Stack spacing={1.5} sx={{ p: 2, flex: 1 }}>
            <Typography variant="subtitle2">Absolute / relative range</Typography>
            <TextField label="From" value={from} onChange={(e) => setFrom(e.target.value)} helperText="e.g. now-6h, now/d, 2024-01-01T00:00" />
            <TextField label="To" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button
              variant="contained"
              onClick={() => {
                onChange({ from, to });
                setAnchor(null);
              }}
            >
              Apply time range
            </Button>
          </Stack>
          <Box sx={{ width: { sm: 200 }, maxHeight: 360, overflow: 'auto' }}>
            <List dense>
              {TIME_PRESETS.map((p) => (
                <ListItemButton
                  key={p.label}
                  selected={p.from === value.from && p.to === value.to}
                  onClick={() => {
                    onChange({ from: p.from, to: p.to });
                    setAnchor(null);
                  }}
                >
                  <ListItemText primary={p.label} />
                </ListItemButton>
              ))}
            </List>
          </Box>
        </Stack>
      </Menu>
    </>
  );
}

export function RefreshPicker({ value, onChange, onRefresh, loading }: { value: string; onChange: (v: string) => void; onRefresh: () => void; loading?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <ButtonGroup variant="outlined" color="inherit" sx={{ '& .MuiButton-root': { borderColor: 'divider' } }}>
        <Tooltip title="Refresh dashboard">
          <Button onClick={onRefresh} aria-label="Refresh">
            <RefreshIcon fontSize="small" sx={{ animation: loading ? 'spin 1s linear infinite' : undefined, '@keyframes spin': { to: { transform: 'rotate(360deg)' } } }} />
          </Button>
        </Tooltip>
        <Button onClick={(e) => setAnchor(e.currentTarget)} endIcon={<ArrowDropDownIcon />}>
          {value === 'off' ? 'Off' : value}
        </Button>
      </ButtonGroup>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {REFRESH_OPTIONS.map((o) => (
          <MenuItem
            key={o}
            selected={o === value}
            onClick={() => {
              onChange(o);
              setAnchor(null);
            }}
          >
            {o === 'off' ? 'Off' : `Every ${o}`}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
