import { EXCHANGES, QUEUES } from '@crawler/shared';
import type { ConfirmPublishChannel, CrawlMessage } from '@crawler/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RabbitPublisher } from '../../src/crawl/rabbit.js';

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

// Confirm handling itself (nacks, timeouts, synchronous failures) is tested with
// `publishConfirmed` in the shared package.
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

  it('rejects when the broker nacks the message', async () => {
    const { channel, confirm } = fakeChannel();
    const published = new RabbitPublisher(channel).publish(MESSAGE);
    confirm(new Error('message nacked'));

    await expect(published).rejects.toThrow('message nacked');
  });

  it('applies its confirm timeout', async () => {
    const { channel } = fakeChannel();
    const published = new RabbitPublisher(channel, 1_000).publish(MESSAGE);
    const assertion = expect(published).rejects.toThrow('RabbitMQ publish confirm timed out');

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});
