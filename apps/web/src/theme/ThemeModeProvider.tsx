import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CssBaseline, ThemeProvider, useMediaQuery, type PaletteMode } from '@mui/material';
import { buildTheme } from './theme';

interface Ctx {
  mode: PaletteMode;
  toggle: () => void;
  setMode: (m: PaletteMode) => void;
}

const ThemeModeContext = createContext<Ctx>({ mode: 'dark', toggle: () => undefined, setMode: () => undefined });
const KEY = 'graphan.theme';

function readStored(): PaletteMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [mode, setMode] = useState<PaletteMode>(() => readStored() ?? (prefersDark ? 'dark' : 'light'));

  useEffect(() => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable */
    }
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const theme = useMemo(() => buildTheme(mode), [mode]);
  const value = useMemo(() => ({ mode, setMode, toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')) }), [mode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

export const useThemeMode = () => useContext(ThemeModeContext);
