/**
 * RabbitMQ topology shared by the API (publisher) and the worker (consumer).
 *
 *   crawl (direct) --crawl.requests--> [crawl.requests] --nack--> crawl.dlx
 *   crawl.dlx (direct) --crawl.retry--> [crawl.retry] --TTL--> crawl (crawl.requests)
 *   crawl.dlx (direct) --crawl.dead---> [crawl.dead]
 *
 * A transient failure is retried by rejecting the message without requeue:
 * it is dead-lettered into `crawl.retry`, waits there for `RETRY_DELAY_MS`
 * and expires back into `crawl.requests`. The retry count is read from the
 * `x-death` header. Permanent or exhausted failures are published explicitly
 * to `crawl.dlx` with routing key `crawl.dead`.
 */

export const EXCHANGES = {
  crawl: 'crawl',
  deadLetter: 'crawl.dlx',
} as const;

/** Queue names double as the routing keys that bind them. */
export const QUEUES = {
  requests: 'crawl.requests',
  retry: 'crawl.retry',
  dead: 'crawl.dead',
} as const;

export const RETRY_DELAY_MS = 2_000;
export const MAX_RETRIES = 2;

export const PUBLISH_CONFIRM_TIMEOUT_MS = 5_000;

/** The subset of amqplib publish options used by the services. */
export interface PublishOptions {
  persistent?: boolean;
  contentType?: string;
  messageId?: string;
  headers?: Record<string, unknown>;
}

/** The subset of an amqplib confirm channel used to publish. */
export interface ConfirmPublishChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: PublishOptions,
    callback: (error: unknown) => void,
  ): boolean;
}

export interface OutgoingMessage {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: PublishOptions;
}

/**
 * Publishes on a confirm channel and resolves once the broker has stored the message.
 * Rejects on a nack, on a synchronous failure (e.g. a closed channel) and when no confirm
 * arrives within `timeoutMs`: an unconfirmed message must never hang its caller.
 */
export function publishConfirmed(
  channel: ConfirmPublishChannel,
  { exchange, routingKey, content, options }: OutgoingMessage,
  timeoutMs = PUBLISH_CONFIRM_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('RabbitMQ publish confirm timed out')),
      timeoutMs,
    );
    const fail = (error: unknown, fallbackMessage: string) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(fallbackMessage));
    };

    try {
      // amqplib calls back with `null` on ack and with an error on nack.
      channel.publish(exchange, routingKey, content, options, (error) => {
        if (error) return fail(error, 'RabbitMQ rejected the message');
        clearTimeout(timer);
        resolve();
      });
    } catch (error: unknown) {
      fail(error, 'RabbitMQ publish failed');
    }
  });
}

/**
 * How many times a message has already been retried: RabbitMQ counts in the `x-death` header
 * how often it was rejected from `crawl.requests` (each rejection goes through the retry queue).
 */
export function readRetryCount(headers: Record<string, unknown> | undefined): number {
  const deaths = headers?.['x-death'];
  if (!Array.isArray(deaths)) return 0;
  for (const death of deaths as unknown[]) {
    if (typeof death !== 'object' || death === null) continue;
    const { queue, reason, count } = death as Record<string, unknown>;
    if (queue === QUEUES.requests && reason === 'rejected') {
      return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
    }
  }
  return 0;
}

/** The subset of an amqplib channel needed to declare the topology. */
export interface TopologyChannel {
  assertExchange(exchange: string, type: 'direct', options: { durable: boolean }): Promise<unknown>;
  assertQueue(
    queue: string,
    options: { durable: boolean; arguments?: Record<string, unknown> },
  ): Promise<unknown>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
}

/** Idempotently declares exchanges, queues and bindings. */
export async function assertQueueTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(EXCHANGES.crawl, 'direct', { durable: true });
  await channel.assertExchange(EXCHANGES.deadLetter, 'direct', { durable: true });

  await channel.assertQueue(QUEUES.requests, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGES.deadLetter,
      'x-dead-letter-routing-key': QUEUES.retry,
    },
  });
  await channel.bindQueue(QUEUES.requests, EXCHANGES.crawl, QUEUES.requests);

  await channel.assertQueue(QUEUES.retry, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': EXCHANGES.crawl,
      'x-dead-letter-routing-key': QUEUES.requests,
    },
  });
  await channel.bindQueue(QUEUES.retry, EXCHANGES.deadLetter, QUEUES.retry);

  await channel.assertQueue(QUEUES.dead, { durable: true });
  await channel.bindQueue(QUEUES.dead, EXCHANGES.deadLetter, QUEUES.dead);
}
