import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

const listSelect = {
  id: true,
  title: true,
  description: true,
  tags: true,
  folderId: true,
  isPrivate: true,
  isTemplate: true,
  refreshInterval: true,
  version: true,
  ownerId: true,
  updatedAt: true,
  createdAt: true,
  shareToken: true,
  embedEnabled: true,
  owner: { select: { id: true, name: true } },
  folder: { select: { id: true, name: true } },
} satisfies Prisma.DashboardSelect;

export const dashboardRepository = {
  listVisible(workspaceId: string, userId: string, teamIds: string[], seeAll: boolean, search?: string) {
    const where: Prisma.DashboardWhereInput = {
      workspaceId,
      title: search ? { contains: search, mode: 'insensitive' } : undefined,
      ...(seeAll
        ? {}
        : {
            OR: [
              { isPrivate: false },
              { ownerId: userId },
              { permissions: { some: { OR: [{ userId }, { teamId: { in: teamIds } }] } } },
            ],
          }),
    };
    return prisma.dashboard.findMany({ where, select: listSelect, orderBy: [{ title: 'asc' }] });
  },

  findById(id: string) {
    return prisma.dashboard.findUnique({ where: { id }, include: { permissions: true } });
  },

  findByShareToken(token: string) {
    return prisma.dashboard.findUnique({ where: { shareToken: token } });
  },

  async create(data: Prisma.DashboardUncheckedCreateInput) {
    return prisma.$transaction(async (tx) => {
      const d = await tx.dashboard.create({ data });
      await tx.dashboardVersion.create({
        data: { dashboardId: d.id, version: 1, definition: data.definition as Prisma.InputJsonValue, createdById: data.ownerId, message: 'Created' },
      });
      return d;
    });
  },

  /** Atomic optimistic-concurrency update: only succeeds when the stored version matches. */
  async updateVersioned(id: string, expectedVersion: number, data: Prisma.DashboardUncheckedUpdateInput, userId: string, message?: string) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.dashboard.updateMany({
        where: { id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } } as Prisma.DashboardUncheckedUpdateManyInput,
      });
      if (count === 0) return null;
      const d = await tx.dashboard.findUniqueOrThrow({ where: { id } });
      await tx.dashboardVersion.create({
        data: { dashboardId: id, version: d.version, definition: d.definition as Prisma.InputJsonValue, createdById: userId, message },
      });
      return d;
    });
  },

  update(id: string, data: Prisma.DashboardUncheckedUpdateInput) {
    return prisma.dashboard.update({ where: { id }, data });
  },

  delete(id: string) {
    return prisma.dashboard.delete({ where: { id } });
  },

  listVersions(dashboardId: string) {
    return prisma.dashboardVersion.findMany({
      where: { dashboardId },
      orderBy: { version: 'desc' },
      take: 100,
      select: { id: true, version: true, message: true, createdAt: true, createdById: true },
    });
  },

  getVersion(dashboardId: string, version: number) {
    return prisma.dashboardVersion.findUnique({ where: { dashboardId_version: { dashboardId, version } } });
  },

  replacePermissions(dashboardId: string, grants: { userId?: string | null; teamId?: string | null; level: 'VIEW' | 'EDIT' | 'ADMIN' }[]) {
    return prisma.$transaction([
      prisma.dashboardPermission.deleteMany({ where: { dashboardId } }),
      prisma.dashboardPermission.createMany({ data: grants.map((g) => ({ dashboardId, userId: g.userId ?? null, teamId: g.teamId ?? null, level: g.level })) }),
    ]);
  },

  listScheduled() {
    return prisma.dashboard.findMany({
      where: { OR: [{ scheduleCron: { not: null } }, { refreshInterval: { not: null } }] },
      select: { id: true, workspaceId: true, scheduleCron: true, refreshInterval: true },
    });
  },
};
