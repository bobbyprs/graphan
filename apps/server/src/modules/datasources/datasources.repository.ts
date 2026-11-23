import type { ConnectionStatus, DataSource, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/** Data-access layer for data sources. Services never touch Prisma directly for this aggregate. */
export const dataSourceRepository = {
  list(workspaceId: string): Promise<DataSource[]> {
    return prisma.dataSource.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
  },

  findById(workspaceId: string, id: string): Promise<DataSource | null> {
    return prisma.dataSource.findFirst({ where: { id, workspaceId } });
  },

  findByIdUnscoped(id: string): Promise<DataSource | null> {
    return prisma.dataSource.findUnique({ where: { id } });
  },

  listAll(): Promise<DataSource[]> {
    return prisma.dataSource.findMany();
  },

  create(data: Prisma.DataSourceUncheckedCreateInput): Promise<DataSource> {
    return prisma.dataSource.create({ data });
  },

  update(id: string, data: Prisma.DataSourceUncheckedUpdateInput): Promise<DataSource> {
    return prisma.dataSource.update({ where: { id }, data });
  },

  delete(id: string): Promise<DataSource> {
    return prisma.dataSource.delete({ where: { id } });
  },

  setHealth(id: string, status: ConnectionStatus, latencyMs: number | null, error: string | null) {
    return prisma.dataSource.update({
      where: { id },
      data: { status, lastLatencyMs: latencyMs, lastError: error, lastCheckedAt: new Date() },
    });
  },
};
