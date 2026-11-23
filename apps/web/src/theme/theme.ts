import { alpha, createTheme, type PaletteMode, type ThemeOptions } from '@mui/material/styles';

/** Grafana-inspired palettes */
const tokens = {
  dark: {
    bg: '#111217',
    paper: '#181b1f',
    panel: '#181b1f',
    border: 'rgba(204, 204, 220, 0.12)',
    text: '#ccccdc',
    textSecondary: 'rgba(204, 204, 220, 0.65)',
    nav: '#181b1f',
  },
  light: {
    bg: '#f4f5f5',
    paper: '#ffffff',
    panel: '#ffffff',
    border: 'rgba(36, 41, 46, 0.12)',
    text: '#24292e',
    textSecondary: 'rgba(36, 41, 46, 0.75)',
    nav: '#ffffff',
  },
};

export const SERIES_COLORS = ['#73BF69', '#F2CC0C', '#5794F2', '#FF780A', '#F2495C', '#B877D9', '#8AB8FF', '#FADE2A', '#56A64B', '#E0B400', '#3274D9', '#FA6400'];

declare module '@mui/material/styles' {
  interface Palette {
    surface: { panel: string; nav: string; border: string };
  }
  interface PaletteOptions {
    surface?: { panel: string; nav: string; border: string };
  }
}

export function buildTheme(mode: PaletteMode) {
  const t = tokens[mode];
  const options: ThemeOptions = {
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#6E9FFF' : '#3D71D9' },
      secondary: { main: '#F46800' },
      success: { main: '#1A7F4B' },
      error: { main: '#D10E5C' },
      warning: { main: '#FF9830' },
      background: { default: t.bg, paper: t.paper },
      text: { primary: t.text, secondary: t.textSecondary },
      divider: t.border,
      surface: { panel: t.panel, nav: t.nav, border: t.border },
    },
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: '"Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      fontSize: 13,
      h4: { fontWeight: 600, fontSize: '1.6rem' },
      h5: { fontWeight: 600, fontSize: '1.3rem' },
      h6: { fontWeight: 600, fontSize: '1.05rem' },
      subtitle2: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 500 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: t.bg, scrollbarWidth: 'thin' },
          '*::-webkit-scrollbar': { width: 8, height: 8 },
          '*::-webkit-scrollbar-thumb': { background: alpha(t.text, 0.2), borderRadius: 4 },
          code: { fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: '0.85em' },
        },
      },
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${t.border}` } } },
      MuiAppBar: { styleOverrides: { root: { border: 'none', borderBottom: `1px solid ${t.border}` } } },
      MuiButton: { defaultProps: { disableElevation: true, size: 'small' } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },
      MuiIconButton: { defaultProps: { size: 'small' } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiDialog: { styleOverrides: { paper: { border: `1px solid ${t.border}` } } },
      MuiTableCell: { styleOverrides: { root: { borderColor: t.border } } },
      MuiTab: { styleOverrides: { root: { minHeight: 40, textTransform: 'none' } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 40 } } },
    },
  };
  return createTheme(options);
}
