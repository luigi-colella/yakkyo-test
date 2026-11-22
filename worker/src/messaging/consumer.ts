import {
  crawlMessageSchema,
  EXCHANGES,
  MAX_RETRIES,
  publishConfirmed,
  QUEUES,
  readRetryCount,
  RETRY_DELAY_MS,
} from '@crawler/shared';
import type { ConfirmPublishChannel, CrawlMessage } from '@crawler/shared';
import type { Logger } from 'pino';

import { Deadline } from '../pipeline/deadline.js';
import { toCrawlFailure } from '../pipeline/errors.js';
import type { WorkerPageStore } from '../storage/page-store.js';
import type { CrawlProcessor } from '../pipeline/processor.js';

/** The parts of an amqplib message the consumer reads. */
export interface Delivery {
  content: Buffer;
  properties: { headers?: Record<string, unknown>; messageId?: unknown };
}

/** The subset of an amqplib confirm channel the consumer uses. */
export interface ConsumerChannel extends ConfirmPublishChannel {
  ack(message: Delivery): void;
  nack(message: Delivery, allUpTo?: boolean, requeue?: boolean): void;
}

export interface CrawlConsumerOptions {
  channel: ConsumerChannel;
  processor: Pick<CrawlProcessor, 'process'>;
  store: Pick<WorkerPageStore, 'isPending' | 'fail'>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  createDeadline?: (requestedAt: string) => Deadline;
}

/** Header of a dead-lettered message carrying the failure code. */
export const FAILURE_HEADER = 'x-crawl-failure';

/**
 * Handles the messages of `crawl.requests`, one at a time (prefetch 1). Every message is
 * settled exactly once: acked when the job is over (done, failed for good, or nothing left
 * to do), rejected without requeue to retry it through `crawl.retry` after a delay.
 */
export class CrawlConsumer {
  private readonly channel: ConsumerChannel;
  private readonly processor: Pick<CrawlProcessor, 'process'>;
  private readonly store: Pick<WorkerPageStore, 'isPending' | 'fail'>;
  private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  private readonly createDeadline: (requestedAt: string) => Deadline;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: CrawlConsumerOptions) {
    this.channel = options.channel;
    this.processor = options.processor;
    this.store = options.store;
    this.logger = options.logger;
    this.createDeadline =
      options.createDeadline ?? ((requestedAt) => Deadline.forRequest(requestedAt));
  }

  /** Never rejects: every outcome is settled on the channel and logged. */
  handle(delivery: Delivery): Promise<void> {
    const handling = this.settle(delivery).catch((error: unknown) => {
      // Only reachable if the channel itself fails; the broker redelivers unacked messages.
      this.logger.error({ err: error }, 'message handling failed');
    });
    this.inFlight.add(handling);
    void handling.finally(() => this.inFlight.delete(handling));
    return handling;
  }

  /** Resolves once the messages being handled are settled (graceful shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.all(this.inFlight);
  }

  private async settle(delivery: Delivery): Promise<void> {
    const job = parseMessage(delivery.content);
    if (!job) {
      this.logger.warn('invalid crawl message dead-lettered');
      await this.deadLetter(delivery, 'invalid_message');
      this.channel.ack(delivery);
      return;
    }

    const deadline = this.createDeadline(job.requestedAt);
    try {
      await this.settleJob(delivery, job, deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async settleJob(delivery: Delivery, job: CrawlMessage, deadline: Deadline) {
    const { uid } = job;
    const retries = readRetryCount(delivery.properties.headers);

    let pending: boolean;
    try {
      pending = await this.store.isPending(uid);
    } catch (error: unknown) {
      this.logger.error({ uid, err: error }, 'page lookup failed');
      this.retryOrDrop(delivery, uid, deadline);
      return;
    }
    if (!pending) {
      // Already finalized (e.g. marked stale by the API) or a duplicate delivery.
      this.logger.info({ uid }, 'job is no longer pending, message dropped');
      this.channel.ack(delivery);
      return;
    }

    const failure = await this.processor.process(job, deadline).then(
      (outcome) => {
        this.logger.info({ uid, outcome, retries }, 'crawl finished');
        return undefined;
      },
      (error: unknown) => toCrawlFailure(error),
    );
    if (!failure) {
      this.channel.ack(delivery);
      return;
    }

    if (failure.retryable && retries < MAX_RETRIES && deadline.fits(RETRY_DELAY_MS)) {
      this.logger.warn(
        { uid, code: failure.code, retries, err: failure },
        'crawl failed, retrying',
      );
      this.channel.nack(delivery, false, false);
      return;
    }

    try {
      await this.store.fail(uid, failure.code);
    } catch (error: unknown) {
      this.logger.error({ uid, err: error }, 'page update failed');
      this.retryOrDrop(delivery, uid, deadline);
      return;
    }
    await this.deadLetter(delivery, failure.code);
    this.channel.ack(delivery);
    this.logger.warn({ uid, code: failure.code, retries, err: failure }, 'crawl failed');
  }

  /**
   * After a storage error the message goes through the retry queue, which delays it instead
   * of spinning while MongoDB is down. Once the budget is spent it is dropped: the job stays
   * `pending` and the API reports it as `stale_job` later.
   */
  private retryOrDrop(delivery: Delivery, uid: string, deadline: Deadline): void {
    if (deadline.fits(RETRY_DELAY_MS)) {
      this.channel.nack(delivery, false, false);
      return;
    }
    this.logger.error({ uid }, 'job budget spent during a storage outage, message dropped');
    this.channel.ack(delivery);
  }

  /**
   * Keeps a copy of a failed message in `crawl.dead` for inspection. Best effort: the outcome
   * already lives in MongoDB, so a lost copy is only logged.
   */
  private async deadLetter(delivery: Delivery, code: string): Promise<void> {
    const { messageId } = delivery.properties;
    try {
      await publishConfirmed(this.channel, {
        exchange: EXCHANGES.deadLetter,
        routingKey: QUEUES.dead,
        content: delivery.content,
        options: {
          persistent: true,
          contentType: 'application/json',
          headers: { [FAILURE_HEADER]: code },
          ...(typeof messageId === 'string' ? { messageId } : {}),
        },
      });
    } catch (error: unknown) {
      this.logger.error({ err: error, code }, 'dead-letter publish failed');
    }
  }
}

function parseMessage(content: Buffer): CrawlMessage | undefined {
  try {
    const parsed = crawlMessageSchema.safeParse(JSON.parse(content.toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
