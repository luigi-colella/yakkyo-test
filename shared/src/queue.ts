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
