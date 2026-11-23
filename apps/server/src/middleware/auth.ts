import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/jwt';
import { Forbidden, Unauthorized } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { can, type Permission } from '../lib/rbac';
import { asyncHandler } from '../lib/http';

/** Verifies the Bearer access token and attaches `req.user`. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(Unauthorized('Missing bearer token'));
  try {
    const p = verifyAccessToken(header.slice(7));
    req.user = { id: p.sub, email: p.email, name: p.name, isSuperAdmin: p.sa };
    next();
  } catch {
    next(Unauthorized('Invalid or expired token'));
  }
}

/**
 * Resolves the active workspace from the `X-Workspace-Id` header and the caller's role in it.
 * Super admins are treated as ADMIN in every workspace.
 */
export const resolveWorkspace = asyncHandler(async (req, _res, next) => {
  const workspaceId = (req.headers['x-workspace-id'] as string | undefined) ?? (req.query.workspaceId as string);
  if (!workspaceId) throw Forbidden('X-Workspace-Id header is required');
  if (req.user!.isSuperAdmin) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!ws) throw Forbidden('Unknown workspace');
    req.workspace = { id: ws.id, role: 'ADMIN' };
    return next();
  }
  const m = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: req.user!.id } },
    select: { role: true },
  });
  if (!m) throw Forbidden('Not a member of this workspace');
  req.workspace = { id: workspaceId, role: m.role };
  next();
});

/** Route guard: requires the permission in the active workspace. */
export const requirePermission =
  (...perms: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const role = req.workspace?.role;
    if (!role) return next(Forbidden('No workspace context'));
    const missing = perms.filter((p) => !can(role, p));
    if (missing.length) return next(Forbidden(`Missing permission: ${missing.join(', ')}`));
    next();
  };

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.isSuperAdmin) return next(Forbidden('Super admin only'));
  next();
}
