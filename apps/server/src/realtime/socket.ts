import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { corsOrigins } from '../config/env';

let io: Server | undefined;

export const Rooms = {
  workspace: (id: string) => `ws:${id}`,
  dashboard: (id: string) => `dash:${id}`,
  user: (id: string) => `user:${id}`,
};

export const Events = {
  DATASOURCE_STATUS: 'datasource:status',
  DASHBOARD_REFRESH: 'dashboard:refresh',
  DASHBOARD_UPDATED: 'dashboard:updated',
  ALERT_STATE: 'alert:state',
} as const;

interface SocketData {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * Socket.IO server for live updates. For multi-replica deployments, plug in the
 * @socket.io/redis-adapter so emits fan out across pods.
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/ws',
    cors: { origin: corsOrigins, credentials: true },
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? '';
      const p = verifyAccessToken(token);
      (socket.data as SocketData) = { userId: p.sub, isSuperAdmin: p.sa };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    void socket.join(Rooms.user(data.userId));

    socket.on('workspace:join', async (workspaceId: string, ack?: (ok: boolean) => void) => {
      const ok = data.isSuperAdmin || !!(await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: data.userId } },
        select: { id: true },
      }));
      if (ok) {
        // Leave previous workspace rooms
        for (const r of socket.rooms) if (r.startsWith('ws:')) void socket.leave(r);
        void socket.join(Rooms.workspace(workspaceId));
      }
      ack?.(ok);
    });

    socket.on('dashboard:subscribe', async (dashboardId: string, ack?: (ok: boolean) => void) => {
      const d = await prisma.dashboard.findUnique({ where: { id: dashboardId }, select: { workspaceId: true } });
      const ok =
        !!d &&
        (data.isSuperAdmin ||
          !!(await prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId: d.workspaceId, userId: data.userId } },
            select: { id: true },
          })));
      if (ok) void socket.join(Rooms.dashboard(dashboardId));
      ack?.(ok);
    });

    socket.on('dashboard:unsubscribe', (dashboardId: string) => void socket.leave(Rooms.dashboard(dashboardId)));
  });

  logger.info('Realtime gateway initialised on /ws');
  return io;
}

export function emit(room: string, event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

export function roomSize(room: string): number {
  return io?.sockets.adapter.rooms.get(room)?.size ?? 0;
}

export async function closeRealtime() {
  await new Promise<void>((resolve) => (io ? io.close(() => resolve()) : resolve()));
}
