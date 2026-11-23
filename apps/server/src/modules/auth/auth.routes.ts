import { Router, type CookieOptions, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { authenticate } from '../../middleware/auth';
import { Unauthorized } from '../../lib/errors';
import { isProd } from '../../config/env';
import { audit } from '../audit/audit.service';
import * as auth from './auth.service';

const REFRESH_COOKIE = 'gr_rt';
const cookieOpts = (expires: Date): CookieOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  path: '/api/auth',
  expires,
});

function setRefreshCookie(res: Response, token: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, token, cookieOpts(expires));
}

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) });
const changePwSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(128) });

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    try {
      const r = await auth.login(email, password, { ip: req.ip, userAgent: req.headers['user-agent'] });
      setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt);
      audit(req, { action: 'auth.login', entityType: 'user', entityId: r.user.id, userId: r.user.id });
      res.json({ accessToken: r.accessToken, user: await auth.me(r.user.id) });
    } catch (e) {
      audit(req, { action: 'auth.login_failed', entityType: 'user', metadata: { email } });
      throw e;
    }
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw Unauthorized('No session');
    try {
      const r = await auth.refresh(token, { ip: req.ip, userAgent: req.headers['user-agent'] });
      setRefreshCookie(res, r.refreshToken, r.refreshExpiresAt);
      res.json({ accessToken: r.accessToken });
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw e;
    }
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => res.json(await auth.me(req.user!.id))),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate(changePwSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof changePwSchema>;
    await auth.changePassword(req.user!.id, b.currentPassword, b.newPassword);
    audit(req, { action: 'auth.password_changed', entityType: 'user', entityId: req.user!.id });
    res.status(204).end();
  }),
);
