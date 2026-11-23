import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parsePagination } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requireSuperAdmin } from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import { audit } from '../audit/audit.service';

/** Global (instance-level) user administration — super admins only. */
export const usersRouter = Router();
usersRouter.use(requireSuperAdmin);

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const where = search
      ? { OR: [{ email: { contains: search, mode: 'insensitive' as const } }, { name: { contains: search, mode: 'insensitive' as const } }] }
      : {};
    const [items, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, name: true, isActive: true, isSuperAdmin: true, lastLoginAt: true, createdAt: true },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ items, total });
  }),
);

usersRouter.patch(
  '/:id',
  validate(z.object({ isActive: z.boolean().optional(), isSuperAdmin: z.boolean().optional(), name: z.string().min(1).max(100).optional() })),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.id && (req.body.isActive === false || req.body.isSuperAdmin === false)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'You cannot demote or disable yourself' } });
    }
    const u = await prisma.user.update({
      where: { id: req.params.id },
      data: req.body,
      select: { id: true, email: true, name: true, isActive: true, isSuperAdmin: true },
    });
    if (req.body.isActive === false) {
      await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    audit(req, { action: 'user.update', entityType: 'user', entityId: u.id, metadata: req.body, workspaceId: null });
    res.json(u);
  }),
);
