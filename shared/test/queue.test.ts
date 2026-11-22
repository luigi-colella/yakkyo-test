import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertQueueTopology,
  EXCHANGES,
  PUBLISH_CONFIRM_TIMEOUT_MS,
  publishConfirmed,
  QUEUES,
  readRetryCount,
  RETRY_DELAY_MS,
} from '../src/queue.js';
import type { ConfirmPublishChannel, OutgoingMessage, TopologyChannel } from '../src/queue.js';

type Call = [method: keyof TopologyChannel, ...args: unknown[]];

function createFakeChannel(): { channel: TopologyChannel; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: keyof TopologyChannel) =>
    (...args: unknown[]): Promise<void> => {
      calls.push([method, ...args]);
      return Promise.resolve();
    };
  return {
    calls,
    channel: {
      assertExchange: record('assertExchange'),
      assertQueue: record('assertQueue'),
      bindQueue: record('bindQueue'),
    },
  };
}

async function declaredTopology(): Promise<Call[]> {
  const { channel, calls } = createFakeChannel();
  await assertQueueTopology(channel);
  return calls;
}

function queueOptions(calls: Call[], queue: string): unknown {
  const call = calls.find(([method, name]) => method === 'assertQueue' && name === queue);
  return call?.[2];
}

describe('assertQueueTopology', () => {
  it('uses the names required by the spec', () => {
    expect(EXCHANGES).toEqual({ crawl: 'crawl', deadLetter: 'crawl.dlx' });
    expect(QUEUES.requests).toBe('crawl.requests');
    expect(QUEUES.dead).toBe('crawl.dead');
  });

  it('declares both exchanges as durable direct exchanges', async () => {
    const calls = await declaredTopology();
    expect(calls.filter(([method]) => method === 'assertExchange')).toEqual([
      ['assertExchange', 'crawl', 'direct', { durable: true }],
      ['assertExchange', 'crawl.dlx', 'direct', { durable: true }],
    ]);
  });

  it('dead-letters rejected requests into the retry queue', async () => {
    expect(queueOptions(await declaredTopology(), 'crawl.requests')).toEqual({
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'crawl.dlx',
        'x-dead-letter-routing-key': 'crawl.retry',
      },
    });
  });

  it('sends expired retries back to the requests queue after the delay', async () => {
    expect(queueOptions(await declaredTopology(), 'crawl.retry')).toEqual({
      durable: true,
      arguments: {
        'x-message-ttl': RETRY_DELAY_MS,
        'x-dead-letter-exchange': 'crawl',
        'x-dead-letter-routing-key': 'crawl.requests',
      },
    });
  });

  it('declares a plain durable dead queue', async () => {
    expect(queueOptions(await declaredTopology(), 'crawl.dead')).toEqual({ durable: true });
  });

  it('binds every queue to the expected exchange and routing key', async () => {
    const calls = await declaredTopology();
    expect(calls.filter(([method]) => method === 'bindQueue')).toEqual([
      ['bindQueue', 'crawl.requests', 'crawl', 'crawl.requests'],
      ['bindQueue', 'crawl.retry', 'crawl.dlx', 'crawl.retry'],
      ['bindQueue', 'crawl.dead', 'crawl.dlx', 'crawl.dead'],
    ]);
  });

  it('declares exchanges before the queues bound to them', async () => {
    const methods = (await declaredTopology()).map(([method]) => method);
    expect(methods.slice(0, 2)).toEqual(['assertExchange', 'assertExchange']);
    expect(methods.slice(2)).not.toContain('assertExchange');
  });

  it('propagates channel failures', async () => {
    const { channel } = createFakeChannel();
    channel.assertQueue = () => Promise.reject(new Error('channel closed'));
    await expect(assertQueueTopology(channel)).rejects.toThrow('channel closed');
  });
});

const OUTGOING: OutgoingMessage = {
  exchange: EXCHANGES.deadLetter,
  routingKey: QUEUES.dead,
  content: Buffer.from('{}'),
  options: { persistent: true, headers: { 'x-crawl-failure': 'robots_disallowed' } },
};

/** A channel whose confirms are delivered manually through `confirm()`. */
function fakeConfirmChannel() {
  let callback: ((error: unknown) => void) | undefined;
  const publish = vi.fn<ConfirmPublishChannel['publish']>((...args) => {
    callback = args[4];
    return true;
  });
  return { channel: { publish }, publish, confirm: (error: unknown = null) => callback?.(error) };
}

describe('publishConfirmed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes the message as given', async () => {
    const { channel, publish, confirm } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING);
    confirm();
    await published;

    expect(publish).toHaveBeenCalledExactlyOnceWith(
      OUTGOING.exchange,
      OUTGOING.routingKey,
      OUTGOING.content,
      OUTGOING.options,
      expect.any(Function),
    );
  });

  it('resolves only once the broker confirms', async () => {
    const { channel, confirm } = fakeConfirmChannel();
    let settled = false;
    const published = publishConfirmed(channel, OUTGOING).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    confirm();
    await published;
    expect(settled).toBe(true);
  });

  it('rejects when the broker nacks the message', async () => {
    const { channel, confirm } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING);
    confirm(new Error('message nacked'));

    await expect(published).rejects.toThrow('message nacked');
  });

  it('rejects with an Error even when the nack reason is not one', async () => {
    const { channel, confirm } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING);
    confirm('nack');

    await expect(published).rejects.toThrow('RabbitMQ rejected the message');
  });

  it('rejects when publishing throws synchronously', async () => {
    const channel: ConfirmPublishChannel = {
      publish: () => {
        throw new Error('Channel closed');
      },
    };

    await expect(publishConfirmed(channel, OUTGOING)).rejects.toThrow('Channel closed');
  });

  it('rejects when no confirm arrives within the default timeout', async () => {
    const { channel } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING);
    let rejected = false;
    published.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(PUBLISH_CONFIRM_TIMEOUT_MS - 1);
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(published).rejects.toThrow('RabbitMQ publish confirm timed out');
  });

  it('ignores a late confirm after a custom timeout', async () => {
    const { channel, confirm } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING, 1_000);
    const assertion = expect(published).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(1_000);
    confirm();
    await assertion;
  });

  it('clears the confirm timer once settled', async () => {
    const { channel, confirm } = fakeConfirmChannel();
    const published = publishConfirmed(channel, OUTGOING);
    confirm();
    await published;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('readRetryCount', () => {
  const rejected = (count: unknown) => ({
    count,
    reason: 'rejected',
    queue: QUEUES.requests,
    exchange: EXCHANGES.crawl,
  });
  const expired = { count: 7, reason: 'expired', queue: QUEUES.retry, exchange: 'crawl.dlx' };

  it('is 0 for a first delivery', () => {
    expect(readRetryCount(undefined)).toBe(0);
    expect(readRetryCount({})).toBe(0);
  });

  it('counts the rejections from the requests queue', () => {
    expect(readRetryCount({ 'x-death': [rejected(1), expired] })).toBe(1);
    expect(readRetryCount({ 'x-death': [expired, rejected(2)] })).toBe(2);
  });

  it('ignores expirations and other queues', () => {
    const elsewhere = { ...rejected(5), queue: 'another.queue' };
    expect(readRetryCount({ 'x-death': [expired, elsewhere] })).toBe(0);
  });

  it('treats a malformed header as a first delivery', () => {
    expect(readRetryCount({ 'x-death': 'twice' })).toBe(0);
    expect(readRetryCount({ 'x-death': [null, 3, rejected('2')] })).toBe(0);
    expect(readRetryCount({ 'x-death': [rejected(-1)] })).toBe(0);
    expect(readRetryCount({ 'x-death': [rejected(1.5)] })).toBe(0);
  });
});
