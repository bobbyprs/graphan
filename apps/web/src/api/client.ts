import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

/**
 * Access tokens live in memory only (never localStorage) to limit XSS blast radius.
 * The refresh token is an httpOnly cookie scoped to /api/auth.
 */
let accessToken: string | null = null;
let workspaceId: string | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export const tokenStore = {
  get: () => accessToken,
  set(t: string | null) {
    accessToken = t;
    tokenListeners.forEach((l) => l(t));
  },
  subscribe(l: (t: string | null) => void) {
    tokenListeners.add(l);
    return () => tokenListeners.delete(l);
  },
};

export const workspaceStore = {
  get: () => workspaceId,
  set(id: string | null) {
    workspaceId = id;
    try {
      if (id) localStorage.setItem('graphan.workspace', id);
    } catch {
      /* ignore */
    }
  },
  remembered(): string | null {
    try {
      return localStorage.getItem('graphan.workspace');
    } catch {
      return null;
    }
  },
};

/** Embedded dashboards (iframe in another app) authenticate with an embed session, not a user login. */
let embedSession: string | null = null;
export const embedStore = { get: () => embedSession, set: (t: string | null) => void (embedSession = t) };
/** Sentinel passed as `publicToken` to render a dashboard through the /embed API */
export const EMBED_TOKEN = '__embed__';

export const api = axios.create({ baseURL: '/api', withCredentials: true, timeout: 120_000 });

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  if (workspaceId) config.headers['X-Workspace-Id'] = workspaceId;
  if (embedSession) config.headers['X-Embed-Session'] = embedSession;
  return config;
});

let refreshing: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= axios
    .post<{ accessToken: string }>('/api/auth/refresh', {}, { withCredentials: true })
    .then((r) => {
      tokenStore.set(r.data.accessToken);
      return r.data.accessToken;
    })
    .catch(() => {
      tokenStore.set(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
    if (error.response?.status === 401 && original && !original._retry && !original.url?.startsWith('/auth/')) {
      original._retry = true;
      const t = await refreshAccessToken();
      if (t) {
        original.headers.Authorization = `Bearer ${t}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  },
);

export function errorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { error?: { message?: string; details?: { fieldErrors?: Record<string, string[]> } } } | undefined;
    const fe = data?.error?.details?.fieldErrors;
    if (fe && Object.keys(fe).length) return `${data?.error?.message}: ${Object.entries(fe).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ')}`;
    return data?.error?.message ?? e.message;
  }
  return (e as Error)?.message ?? 'Unknown error';
}

/** Triggers a browser download for a POST that returns a file. */
export async function downloadPost(url: string, body: unknown, fallbackName: string) {
  const res = await api.post(url, body, { responseType: 'blob' });
  const cd = res.headers['content-disposition'] as string | undefined;
  const name = /filename="([^"]+)"/.exec(cd ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
