import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { corsOrigins } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { authenticate, resolveWorkspace } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { poolManager } from './connectors/pool-manager';
import { authRouter } from './modules/auth/auth.routes';
import { usersRouter } from './modules/users/users.routes';
import { workspacesRouter, workspaceScopedRouter } from './modules/workspaces/workspaces.routes';
import { dataSourcesRouter } from './modules/datasources/datasources.routes';
import { explorerRouter } from './modules/explorer/explorer.routes';
import { queriesRouter } from './modules/queries/queries.routes';
import { dashboardsRouter } from './modules/dashboards/dashboards.routes';
import { annotationsRouter } from './modules/dashboards/annotations.routes';
import { publicRouter } from './modules/dashboards/public.routes';
import { embedRouter } from './modules/dashboards/embed.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { mlRouter } from './modules/ml/ml.routes';
import { advisorRouter } from './modules/advisor/advisor.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      // Compact access logs: no headers (avoids noise and accidental credential leakage)
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // ── Probes ──
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready', ...poolManager.stats() });
    } catch {
      res.status(503).json({ status: 'not-ready' });
    }
  });

  const api = Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  api.use('/auth', authRouter);
  api.use('/public', publicRouter);
  api.use('/embed', embedRouter);

  // Authenticated, workspace-independent
  api.use('/workspaces', authenticate, workspacesRouter);
  api.use('/users', authenticate, usersRouter);

  // Authenticated + workspace-scoped (X-Workspace-Id)
  const scoped = Router();
  scoped.use(authenticate, resolveWorkspace);
  scoped.use('/datasources', dataSourcesRouter);
  scoped.use('/explorer', explorerRouter);
  scoped.use('/queries', queriesRouter);
  scoped.use('/reports', reportsRouter);
  scoped.use('/dashboards', dashboardsRouter);
  scoped.use('/annotations', annotationsRouter);
  scoped.use('/alerts', alertsRouter);
  scoped.use('/audit', auditRouter);
  scoped.use('/ml', mlRouter);
  scoped.use('/advisor', advisorRouter);
  scoped.use('/', workspaceScopedRouter); // /workspace, /members, /teams
  api.use('/', scoped);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
