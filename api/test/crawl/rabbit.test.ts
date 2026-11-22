import { EXCHANGES, QUEUES } from '@crawler/shared';
import type { CrawlMessage } from '@crawler/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RabbitPublisher } from '../../src/crawl/rabbit.js';
import type { ConfirmPublishChannel } from '../../src/crawl/rabbit.js';

const MESSAGE: CrawlMessage = {
  uid: '01JCXZ7Y7K3M5V8Q9R2T4W6Y8A',
  url: 'https://example.com/',
  requestedAt: '2026-11-22T12:00:00.000Z',
};

type ConfirmCallback = (error: unknown) => void;

/** A channel whose confirms are delivered manually through `confirm()`. */
function fakeChannel() {
  let callback: ConfirmCallback | undefined;
  const publish = vi.fn<ConfirmPublishChannel['publish']>((...args) => {
    callback = args[4];
    return true;
  });
  return {
    channel: { publish },
    publish,
    confirm: (error: unknown = null) => callback?.(error),
  };
}

describe('RabbitPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes a persistent JSON message on the requests routing key', async () => {
    const { channel, publish, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel).publish(MESSAGE);
    confirm();
    await published;

    expect(publish).toHaveBeenCalledExactlyOnceWith(
      EXCHANGES.crawl,
      QUEUES.requests,
      expect.any(Buffer),
      { persistent: true, contentType: 'application/json', messageId: MESSAGE.uid },
      expect.any(Function),
    );
    const body = publish.mock.calls[0]![2];
    expect(JSON.parse(body.toString('utf8'))).toEqual(MESSAGE);
  });

  it('resolves only once the broker confirms', async () => {
    const { channel, confirm } = fakeChannel();
    let settled = false;
    const published = new RabbitPublisher(channel).publish(MESSAGE).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    confirm();
    await published;
    expect(settled).toBe(true);
  });

  it('rejects when the broker nacks the message', async () => {
    const { channel, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel).publish(MESSAGE);
    confirm(new Error('message nacked'));

    await expect(published).rejects.toThrow('message nacked');
  });

  it('rejects with an Error even when the nack reason is not one', async () => {
    const { channel, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel).publish(MESSAGE);
    confirm('nack');

    await expect(published).rejects.toThrow('RabbitMQ rejected the message');
  });

  it('rejects when publishing throws synchronously', async () => {
    const channel: ConfirmPublishChannel = {
      publish: () => {
        throw new Error('Channel closed');
      },
    };

    await expect(new RabbitPublisher(channel).publish(MESSAGE)).rejects.toThrow('Channel closed');
  });

  it('rejects when no confirm arrives within the timeout', async () => {
    const { channel } = fakeChannel();
    const published = new RabbitPublisher(channel, 1_000).publish(MESSAGE);
    let rejected = false;
    published.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(rejected).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(published).rejects.toThrow('RabbitMQ publish confirm timed out');
  });

  it('ignores a late confirm after the timeout', async () => {
    const { channel, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel, 1_000).publish(MESSAGE);
    const assertion = expect(published).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(1_000);
    confirm();
    await assertion;
  });

  it('clears the confirm timer once settled', async () => {
    const { channel, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel).publish(MESSAGE);
    confirm();
    await published;

    expect(vi.getTimerCount()).toBe(0);
  });
});
