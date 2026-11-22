import { assertQueueTopology, QUEUES, retryWithBackoff } from '@crawler/shared';
import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

import { createOpenAiAnalyzer, MockDesignAnalyzer } from './analysis/analyzer.js';
import { loadConfig } from './config.js';
import { CrawlConsumer } from './messaging/consumer.js';
import { MongoWorkerPageStore } from './storage/page-store.js';
import { CrawlProcessor } from './pipeline/processor.js';
import { SafeUrlGuard } from './security/security.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

let browser: Browser | undefined;
let rabbit: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let consumer: CrawlConsumer | undefined;
let consumerTag: string | undefined;
let shuttingDown = false;

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await start();
} catch (error: unknown) {
  logger.fatal({ err: error }, 'worker failed to start');
  await shutdown('startup failure', 1);
}

async function start(): Promise<void> {
  const connection = await withRetry('MongoDB', async () => {
    await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 5_000 });
    return mongoose.connection;
  });

  // Chromium on Windows needs a browser-wide proxy for per-context proxies to apply; every
  // context sets its own pinned proxy, so this placeholder is never used.
  browser = await chromium.launch({ headless: true, proxy: { server: 'http://per-context' } });
  browser.on('disconnected', () => {
    // `browser.close()` during shutdown disconnects it too.
    if (shuttingDown) return;
    logger.error('Chromium disconnected');
    void shutdown('Chromium disconnected', 1);
  });

  const store = new MongoWorkerPageStore(connection);
  const analyzer = config.openAi
    ? createOpenAiAnalyzer(config.openAi.apiKey, config.openAi.model)
    : new MockDesignAnalyzer();
  if (config.allowedHosts.size > 0) {
    logger.warn({ hosts: [...config.allowedHosts] }, 'E2E mode: SSRF allowlist active');
  }
  const processor = new CrawlProcessor({
    browser,
    guard: new SafeUrlGuard({ allowedHosts: config.allowedHosts }),
    analyzer,
    store,
  });

  rabbit = await withRetry('RabbitMQ', () => amqp.connect(config.RABBIT_URL));
  // 'error' is always followed by 'close'; without a listener it would crash the process.
  rabbit.on('error', () => undefined);
  rabbit.on('close', () => onRabbitLost('RabbitMQ connection closed'));
  channel = await rabbit.createConfirmChannel();
  channel.on('error', () => undefined);
  channel.on('close', () => onRabbitLost('RabbitMQ channel closed'));
  await assertQueueTopology(channel);
  await channel.prefetch(1);

  consumer = new CrawlConsumer({ channel, processor, store, logger });
  const activeConsumer = consumer;
  ({ consumerTag } = await channel.consume(QUEUES.requests, (message) => {
    if (message) void activeConsumer.handle(message);
  }));
  logger.info({ analyzer: config.openAi ? config.openAi.model : 'mock' }, 'worker ready');
}

/** Without a channel no message can be settled: let the container restart. */
function onRabbitLost(reason: string): void {
  channel = undefined;
  if (shuttingDown) return;
  logger.error(reason);
  void shutdown(reason, 1);
}

function withRetry<T>(name: string, connect: () => Promise<T>): Promise<T> {
  return retryWithBackoff(connect, {
    onRetry: (error, attempt, delayMs) =>
      logger.warn({ err: error, attempt, delayMs }, `${name} connection failed, retrying`),
  });
}

/**
 * Stops consuming, lets the current job finish (its message is redelivered if the forced
 * exit comes first: the job is still pending, so it is simply crawled again), then closes.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');
  setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS).unref();

  try {
    if (channel && consumerTag) await channel.cancel(consumerTag);
    await consumer?.whenIdle();
    if (channel) await rabbit?.close();
    await browser?.close();
    await mongoose.disconnect();
  } catch (error: unknown) {
    logger.error({ err: error }, 'error during shutdown');
  }
  process.exit(exitCode);
}
