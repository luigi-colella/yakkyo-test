import { describe, expect, it } from 'vitest';

import { assertQueueTopology, EXCHANGES, QUEUES, RETRY_DELAY_MS } from '../src/queue.js';
import type { TopologyChannel } from '../src/queue.js';

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
