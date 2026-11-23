import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { randomToken, sha256 } from '../../lib/crypto';
import { signAccessToken } from '../../lib/jwt';
import { BadRequest, Unauthorized } from '../../lib/errors';
import { logger } from '../../lib/logger';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
// Pre-computed hash used to equalise timing when the user does not exist
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,128}$/;

export function hashPassword(pw: string) {
  if (!PASSWORD_POLICY.test(pw)) {
    throw BadRequest('Password must be 10+ characters and include upper, lower, number and symbol');
  }
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

function accessFor(user: Pick<User, 'id' | 'email' | 'name' | 'isSuperAdmin'>) {
  return signAccessToken({ sub: user.id, email: user.email, name: user.name, sa: user.isSuperAdmin });
}

async function issueRefresh(userId: string, family: string, meta: SessionMeta) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 864e5);
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(token), family, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 255) },
  });
  return { token, expiresAt };
}

export async function login(email: string, password: string, meta: SessionMeta): Promise<IssuedTokens & { user: User }> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw Unauthorized('Invalid email or password');
  }
  if (!user.isActive) throw Unauthorized('Account disabled');
  if (user.lockedUntil && user.lockedUntil > new Date()) throw Unauthorized('Account temporarily locked. Try again later.');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed >= MAX_FAILED ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    throw Unauthorized('Invalid email or password');
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const { token, expiresAt } = await issueRefresh(user.id, randomToken(16), meta);
  return { user, accessToken: accessFor(user), refreshToken: token, refreshExpiresAt: expiresAt };
}

/**
 * Refresh-token rotation. Each refresh token is single-use; presenting an already
 * rotated token indicates theft, so the entire token family is revoked.
 */
export async function refresh(rawToken: string, meta: SessionMeta): Promise<IssuedTokens> {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) }, include: { user: true } });
  if (!record) throw Unauthorized('Invalid refresh token');
  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { family: record.family, revokedAt: null }, data: { revokedAt: new Date() } });
    logger.warn({ userId: record.userId, family: record.family }, 'Refresh token reuse detected; family revoked');
    throw Unauthorized('Session revoked');
  }
  if (record.expiresAt < new Date() || !record.user.isActive) throw Unauthorized('Session expired');

  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  const { token, expiresAt } = await issueRefresh(record.userId, record.family, meta);
  return { accessToken: accessFor(record.user), refreshToken: token, refreshExpiresAt: expiresAt };
}

export async function logout(rawToken: string | undefined) {
  if (!rawToken) return;
  const rec = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (rec) await prisma.refreshToken.updateMany({ where: { family: rec.family, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function changePassword(userId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(current, user.passwordHash))) throw BadRequest('Current password is incorrect');
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

export async function me(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      isSuperAdmin: true,
      lastLoginAt: true,
      memberships: { select: { role: true, workspace: { select: { id: true, name: true, slug: true } } } },
    },
  });
}

export async function purgeExpiredTokens() {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: new Date(Date.now() - 864e5) } }] },
  });
  return count;
}
