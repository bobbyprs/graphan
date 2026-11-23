import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requirePermission, requireSuperAdmin } from '../../middleware/auth';
import { Permissions } from '../../lib/rbac';
import { audit } from '../audit/audit.service';
import { workspacesService as svc } from './workspaces.service';

const createSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().regex(/^[a-z0-9-]{2,50}$/),
  description: z.string().max(500).optional(),
});
const updateSchema = createSchema.omit({ slug: true }).partial();
const memberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: z.nativeEnum(Role),
  password: z.string().min(10).max(128).optional(),
});
const roleSchema = z.object({ role: z.nativeEnum(Role) });
const teamSchema = z.object({ name: z.string().min(1).max(100), description: z.string().max(500).optional() });
const teamMembersSchema = z.object({ userIds: z.array(z.string().uuid()).max(1000) });

/** Routes that do not require an active workspace */
export const workspacesRouter = Router();

workspacesRouter.get(
  '/',
  asyncHandler(async (req, res) => res.json(await svc.listForUser(req.user!.id, req.user!.isSuperAdmin))),
);

workspacesRouter.post(
  '/',
  requireSuperAdmin,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const ws = await svc.create(req.body, req.user!.id);
    audit(req, { action: 'workspace.create', entityType: 'workspace', entityId: ws.id, workspaceId: ws.id });
    res.status(201).json(ws);
  }),
);

/** Routes scoped to the active workspace (mounted behind authenticate + resolveWorkspace) */
export const workspaceScopedRouter = Router();

workspaceScopedRouter.patch(
  '/workspace',
  requirePermission(Permissions.WORKSPACE_MANAGE),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const ws = await svc.update(req.workspace!.id, req.body);
    audit(req, { action: 'workspace.update', entityType: 'workspace', entityId: ws.id });
    res.json(ws);
  }),
);

workspaceScopedRouter.get(
  '/members',
  asyncHandler(async (req, res) => res.json(await svc.listMembers(req.workspace!.id))),
);

workspaceScopedRouter.post(
  '/members',
  requirePermission(Permissions.USERS_MANAGE),
  validate(memberSchema),
  asyncHandler(async (req, res) => {
    const r = await svc.addMember(req.workspace!.id, req.body);
    audit(req, { action: 'member.add', entityType: 'user', entityId: r.member.user.id, metadata: { role: r.member.role } });
    res.status(201).json(r);
  }),
);

workspaceScopedRouter.patch(
  '/members/:userId',
  requirePermission(Permissions.USERS_MANAGE),
  validate(roleSchema),
  asyncHandler(async (req, res) => {
    const m = await svc.updateRole(req.workspace!.id, req.params.userId, req.body.role);
    audit(req, { action: 'member.role_change', entityType: 'user', entityId: req.params.userId, metadata: { role: req.body.role } });
    res.json(m);
  }),
);

workspaceScopedRouter.delete(
  '/members/:userId',
  requirePermission(Permissions.USERS_MANAGE),
  asyncHandler(async (req, res) => {
    await svc.removeMember(req.workspace!.id, req.params.userId);
    audit(req, { action: 'member.remove', entityType: 'user', entityId: req.params.userId });
    res.status(204).end();
  }),
);

workspaceScopedRouter.get('/teams', asyncHandler(async (req, res) => res.json(await svc.listTeams(req.workspace!.id))));

workspaceScopedRouter.post(
  '/teams',
  requirePermission(Permissions.TEAMS_MANAGE),
  validate(teamSchema),
  asyncHandler(async (req, res) => {
    const t = await svc.createTeam(req.workspace!.id, req.body);
    audit(req, { action: 'team.create', entityType: 'team', entityId: t.id });
    res.status(201).json(t);
  }),
);

workspaceScopedRouter.patch(
  '/teams/:id',
  requirePermission(Permissions.TEAMS_MANAGE),
  validate(teamSchema.partial()),
  asyncHandler(async (req, res) => res.json(await svc.updateTeam(req.workspace!.id, req.params.id, req.body))),
);

workspaceScopedRouter.put(
  '/teams/:id/members',
  requirePermission(Permissions.TEAMS_MANAGE),
  validate(teamMembersSchema),
  asyncHandler(async (req, res) => {
    await svc.setTeamMembers(req.workspace!.id, req.params.id, req.body.userIds);
    audit(req, { action: 'team.members_set', entityType: 'team', entityId: req.params.id, metadata: { count: req.body.userIds.length } });
    res.status(204).end();
  }),
);

workspaceScopedRouter.delete(
  '/teams/:id',
  requirePermission(Permissions.TEAMS_MANAGE),
  asyncHandler(async (req, res) => {
    await svc.deleteTeam(req.workspace!.id, req.params.id);
    audit(req, { action: 'team.delete', entityType: 'team', entityId: req.params.id });
    res.status(204).end();
  }),
);
