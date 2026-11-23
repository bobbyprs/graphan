import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { randomToken } from '../../lib/crypto';
import { BadRequest, NotFound } from '../../lib/errors';
import { hashPassword } from '../auth/auth.service';

const memberSelect = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true, isActive: true, lastLoginAt: true } },
} as const;

export const workspacesService = {
  listForUser(userId: string, isSuperAdmin: boolean) {
    return prisma.workspace.findMany({
      where: isSuperAdmin ? {} : { members: { some: { userId } } },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true, dashboards: true, dataSources: true } } },
    });
  },

  async create(data: { name: string; slug: string; description?: string }, creatorId: string) {
    return prisma.workspace.create({
      data: { ...data, members: { create: { userId: creatorId, role: 'ADMIN' } } },
    });
  },

  update(id: string, data: { name?: string; description?: string }) {
    return prisma.workspace.update({ where: { id }, data });
  },

  listMembers(workspaceId: string) {
    return prisma.workspaceMember.findMany({ where: { workspaceId }, select: memberSelect, orderBy: { createdAt: 'asc' } });
  },

  /**
   * Adds a user to the workspace, creating the account if needed.
   * Returns a one-time temporary password for newly created users.
   */
  async addMember(workspaceId: string, input: { email: string; name: string; role: Role; password?: string }) {
    const email = input.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    let tempPassword: string | undefined;
    if (!user) {
      tempPassword = input.password ?? `${randomToken(9)}aA1!`;
      user = await prisma.user.create({ data: { email, name: input.name, passwordHash: await hashPassword(tempPassword) } });
    }
    const member = await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      create: { workspaceId, userId: user.id, role: input.role },
      update: { role: input.role },
      select: memberSelect,
    });
    return { member, tempPassword: input.password ? undefined : tempPassword };
  },

  async updateRole(workspaceId: string, userId: string, role: Role) {
    if (role !== 'ADMIN') await this.ensureNotLastAdmin(workspaceId, userId);
    return prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role },
      select: memberSelect,
    });
  },

  async removeMember(workspaceId: string, userId: string) {
    await this.ensureNotLastAdmin(workspaceId, userId);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
  },

  async ensureNotLastAdmin(workspaceId: string, userId: string) {
    const m = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!m) throw NotFound('Member');
    if (m.role !== 'ADMIN') return;
    const admins = await prisma.workspaceMember.count({ where: { workspaceId, role: 'ADMIN' } });
    if (admins <= 1) throw BadRequest('A workspace must keep at least one admin');
  },

  // ── Teams ──
  listTeams(workspaceId: string) {
    return prisma.team.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  },

  createTeam(workspaceId: string, data: { name: string; description?: string }) {
    return prisma.team.create({ data: { workspaceId, ...data } });
  },

  async updateTeam(workspaceId: string, id: string, data: { name?: string; description?: string }) {
    await this.teamInWorkspace(workspaceId, id);
    return prisma.team.update({ where: { id }, data });
  },

  async deleteTeam(workspaceId: string, id: string) {
    await this.teamInWorkspace(workspaceId, id);
    await prisma.team.delete({ where: { id } });
  },

  async setTeamMembers(workspaceId: string, teamId: string, userIds: string[]) {
    await this.teamInWorkspace(workspaceId, teamId);
    const valid = await prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: userIds } }, select: { userId: true } });
    await prisma.$transaction([
      prisma.teamMember.deleteMany({ where: { teamId } }),
      prisma.teamMember.createMany({ data: valid.map((v) => ({ teamId, userId: v.userId })) }),
    ]);
  },

  async teamInWorkspace(workspaceId: string, id: string) {
    const t = await prisma.team.findFirst({ where: { id, workspaceId } });
    if (!t) throw NotFound('Team');
    return t;
  },
};
