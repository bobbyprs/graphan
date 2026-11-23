import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  workspaceId?: string | null;
  userId?: string | null;
}

/** Fire-and-forget audit writer: auditing must never break the request it records. */
export function audit(req: Request | null, entry: AuditEntry): void {
  prisma.auditLog
    .create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata,
        workspaceId: entry.workspaceId ?? req?.workspace?.id ?? null,
        userId: entry.userId ?? req?.user?.id ?? null,
        ip: req?.ip ?? null,
        userAgent: req?.headers['user-agent']?.slice(0, 255) ?? null,
      },
    })
    .catch((err) => logger.error({ err, entry }, 'Failed to write audit log'));
}

export async function listAudit(
  workspaceId: string,
  filter: { action?: string; userId?: string; entityType?: string; from?: Date; to?: Date },
  page: { limit: number; offset: number },
) {
  const where: Prisma.AuditLogWhereInput = {
    workspaceId,
    action: filter.action ? { contains: filter.action } : undefined,
    userId: filter.userId,
    entityType: filter.entityType,
    createdAt: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
  };
  const [items, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: page.limit,
      skip: page.offset,
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total };
}
