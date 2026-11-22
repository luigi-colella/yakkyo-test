import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { getPageModel, retryWithBackoff } from '@crawler/shared';
import mongoose from 'mongoose';

import { createApp } from './app.js';
import { loadConfig } from './config/config.js';
import { CrawlService } from './crawl/crawl-service.js';
import { createHealthCheck } from './health/health.js';
import { createLogger } from './config/logger.js';
import { MongoPageStore } from './crawl/page-store.js';
import { connectRabbit } from './crawl/rabbit.js';
import type { RabbitConnection } from './crawl/rabbit.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

let server: Server | undefined;
let rabbit: RabbitConnection | undefined;
let rabbitOpen = false;
let shuttingDown = false;

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await start();
} catch (error: unknown) {
  logger.fatal({ err: error }, 'API failed to start');
  await shutdown('startup failure', 1);
}

async function start(): Promise<void> {
  const connection = await withRetry('MongoDB', async () => {
    await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 5_000 });
    return mongoose.connection;
  });
  // The partial unique index (one pending job per URL) must exist before the first request.
  await getPageModel(connection).init();

  rabbit = await withRetry('RabbitMQ', () =>
    connectRabbit(config.RABBIT_URL, (error) => {
      rabbitOpen = false;
      // Without a channel no job can be published: let the container restart.
      logger.error({ err: error }, 'RabbitMQ connection lost');
      void shutdown('RabbitMQ connection lost', 1);
    }),
  );
  rabbitOpen = true;

  const app = createApp({
    crawlService: new CrawlService({
      pages: new MongoPageStore(connection),
      publisher: rabbit.publisher,
    }),
    checkHealth: createHealthCheck({
      pingMongo: async () => {
        if (!connection.db) throw new Error('MongoDB is not connected');
        await connection.db.admin().ping();
      },
      isRabbitOpen: () => rabbitOpen,
    }),
    logger,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    rateLimit: { limit: config.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
  });

  server = app.listen(config.PORT, (error) => {
    if (error) {
      logger.fatal({ err: error }, 'API failed to listen');
      void shutdown('listen failure', 1);
      return;
    }
    logger.info({ port: config.PORT }, 'API listening');
  });
}

function withRetry<T>(name: string, connect: () => Promise<T>): Promise<T> {
  return retryWithBackoff(connect, {
    onRetry: (error, attempt, delayMs) =>
      logger.warn({ err: error, attempt, delayMs }, `${name} connection failed, retrying`),
  });
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');
  setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (rabbitOpen) await rabbit?.close();
    await mongoose.disconnect();
  } catch (error: unknown) {
    logger.error({ err: error }, 'error during shutdown');
  }
  process.exit(exitCode);
}
