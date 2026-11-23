import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { tokenStore, workspaceStore } from './client';

let socket: Socket | null = null;

/** Single shared Socket.IO connection; reconnects with a fresh token when it rotates. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/ws',
      transports: ['websocket'],
      autoConnect: false,
      auth: (cb) => cb({ token: tokenStore.get() }),
      reconnectionDelayMax: 10_000,
    });
    socket.on('connect', () => {
      const ws = workspaceStore.get();
      if (ws) socket!.emit('workspace:join', ws);
    });
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();
  if (!s.connected) s.connect();
}

export function disconnectSocket() {
  socket?.disconnect();
}

export function joinWorkspace(id: string) {
  const s = getSocket();
  if (s.connected) s.emit('workspace:join', id);
}

export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  useEffect(() => {
    const s = getSocket();
    s.on(event, handler);
    return () => {
      s.off(event, handler);
    };
  }, [event, handler]);
}

export function useSocketConnected() {
  const [connected, setConnected] = useState(() => getSocket().connected);
  useEffect(() => {
    const s = getSocket();
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
    };
  }, []);
  return connected;
}

/** Subscribes to a dashboard room while mounted (re-subscribes after reconnects). */
export function useDashboardRoom(dashboardId: string | undefined) {
  useEffect(() => {
    if (!dashboardId) return;
    const s = getSocket();
    const sub = () => s.emit('dashboard:subscribe', dashboardId);
    if (s.connected) sub();
    s.on('connect', sub);
    return () => {
      s.off('connect', sub);
      s.emit('dashboard:unsubscribe', dashboardId);
    };
  }, [dashboardId]);
}
