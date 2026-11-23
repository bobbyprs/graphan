import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshAccessToken, tokenStore, workspaceStore } from '@/api/client';
import { connectSocket, disconnectSocket, joinWorkspace } from '@/api/socket';
import type { Me, Role } from '@/api/types';

interface AuthCtx {
  user: Me | null;
  loading: boolean;
  workspaceId: string | null;
  role: Role | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  reload: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

const RANK: Record<Role, number> = { VIEWER: 0, ANALYST: 1, DEVELOPER: 2, ADMIN: 3 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const applyUser = useCallback((me: Me) => {
    setUser(me);
    const remembered = workspaceStore.remembered();
    const ws = me.memberships.find((m) => m.workspace.id === remembered)?.workspace.id ?? me.memberships[0]?.workspace.id ?? null;
    workspaceStore.set(ws);
    setWorkspaceId(ws);
    connectSocket();
  }, []);

  const reload = useCallback(async () => {
    const me = (await api.get<Me>('/auth/me')).data;
    applyUser(me);
  }, [applyUser]);

  // Restore session from the refresh cookie on first load
  useEffect(() => {
    (async () => {
      try {
        if (await refreshAccessToken()) await reload();
      } finally {
        setLoading(false);
      }
    })();
  }, [reload]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<{ accessToken: string; user: Me }>('/auth/login', { email, password });
      tokenStore.set(r.data.accessToken);
      applyUser(r.data.user);
    },
    [applyUser],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    tokenStore.set(null);
    disconnectSocket();
    setUser(null);
    qc.clear();
  }, [qc]);

  const switchWorkspace = useCallback(
    (id: string) => {
      workspaceStore.set(id);
      setWorkspaceId(id);
      joinWorkspace(id);
      qc.invalidateQueries();
    },
    [qc],
  );

  const role = useMemo<Role | null>(() => {
    if (!user || !workspaceId) return null;
    if (user.isSuperAdmin) return 'ADMIN';
    return user.memberships.find((m) => m.workspace.id === workspaceId)?.role ?? null;
  }, [user, workspaceId]);

  const value = useMemo(
    () => ({ user, loading, workspaceId, role, login, logout, switchWorkspace, reload }),
    [user, loading, workspaceId, role, login, logout, switchWorkspace, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside AuthProvider');
  return c;
}

/** Client-side mirror of the server permission matrix (UX only; the API enforces). */
export function useCan() {
  const { role } = useAuth();
  return useMemo(() => {
    const at = (min: Role) => !!role && RANK[role] >= RANK[min];
    return {
      manageDataSources: at('DEVELOPER'),
      explore: at('ANALYST'),
      createDashboards: at('ANALYST'),
      manageAlerts: at('DEVELOPER'),
      ackAlerts: at('ANALYST'),
      admin: at('ADMIN'),
    };
  }, [role]);
}
