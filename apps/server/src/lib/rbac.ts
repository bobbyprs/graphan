import type { Role } from '@prisma/client';

/**
 * Central permission catalogue. Roles are a fixed hierarchy at the workspace level;
 * dashboards can additionally be shared with explicit VIEW/EDIT/ADMIN grants.
 */
export const Permissions = {
  WORKSPACE_MANAGE: 'workspace:manage',
  USERS_MANAGE: 'users:manage',
  TEAMS_MANAGE: 'teams:manage',
  AUDIT_READ: 'audit:read',

  DATASOURCE_READ: 'datasource:read',
  DATASOURCE_MANAGE: 'datasource:manage',

  EXPLORER_READ: 'explorer:read',
  QUERY_EXECUTE: 'query:execute',
  QUERY_WRITE_EXECUTE: 'query:write-execute', // DML/DDL on non read-only sources

  DASHBOARD_READ: 'dashboard:read',
  DASHBOARD_CREATE: 'dashboard:create',
  DASHBOARD_MANAGE_ALL: 'dashboard:manage-all',

  ALERT_READ: 'alert:read',
  ALERT_MANAGE: 'alert:manage',
  ALERT_ACK: 'alert:ack',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

const P = Permissions;

const VIEWER: Permission[] = [P.DASHBOARD_READ, P.ALERT_READ, P.DATASOURCE_READ];
const ANALYST: Permission[] = [...VIEWER, P.EXPLORER_READ, P.QUERY_EXECUTE, P.DASHBOARD_CREATE, P.ALERT_ACK];
const DEVELOPER: Permission[] = [
  ...ANALYST,
  P.DATASOURCE_MANAGE,
  P.QUERY_WRITE_EXECUTE,
  P.ALERT_MANAGE,
  P.DASHBOARD_MANAGE_ALL,
];
const ADMIN: Permission[] = Object.values(P);

export const RolePermissions: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  ANALYST: new Set(ANALYST),
  DEVELOPER: new Set(DEVELOPER),
  ADMIN: new Set(ADMIN),
};

export const RoleRank: Record<Role, number> = { VIEWER: 0, ANALYST: 1, DEVELOPER: 2, ADMIN: 3 };

export function can(role: Role, permission: Permission): boolean {
  return RolePermissions[role].has(permission);
}
