import http from 'node:http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { createApp } from './app';
import { initRealtime, closeRealtime } from './realtime/socket';
import { poolManager } from './connectors/pool-manager';
import { scheduler } from './jobs/scheduler';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000; // > typical LB idle timeout
  server.headersTimeout = 66_000;

  initRealtime(server);
  poolManager.start();
  if (env.ENABLE_SCHEDULER) await scheduler.start();

  server.listen(env.PORT, () => logger.info(`🚀 Graphan API listening on :${env.PORT}`));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    server.close();
    await scheduler.stop();
    await closeRealtime();
    await poolManager.closeAll();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
