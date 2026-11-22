import { EXCHANGES, QUEUES } from '@crawler/shared';
import type { CrawlMessage } from '@crawler/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrawlConsumer, FAILURE_HEADER } from '../../src/messaging/consumer.js';
import type {
  ConsumerChannel,
  CrawlConsumerOptions,
  Delivery,
} from '../../src/messaging/consumer.js';
import { Deadline } from '../../src/pipeline/deadline.js';
import { permanentFailure, transientFailure } from '../../src/pipeline/errors.js';
import type { CrawlProcessor } from '../../src/pipeline/processor.js';

const NOW = new Date('2026-11-22T12:00:10.000Z');
const JOB: CrawlMessage = {
  uid: '01JCXZ7Y7K3M5V8Q9R2T4W6Y8A',
  url: 'https://example.com/',
  requestedAt: '2026-11-22T12:00:00.000Z',
};

function delivery(body: unknown = JOB, retries = 0, messageId: unknown = JOB.uid): Delivery {
  const xDeath = [
    { count: retries, reason: 'rejected', queue: QUEUES.requests, exchange: EXCHANGES.crawl },
  ];
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    properties: { headers: retries > 0 ? { 'x-death': xDeath } : {}, messageId },
  };
}

function setup(overrides: Partial<CrawlConsumerOptions> = {}) {
  const channel = {
    ack: vi.fn<ConsumerChannel['ack']>(),
    nack: vi.fn<ConsumerChannel['nack']>(),
    publish: vi.fn<ConsumerChannel['publish']>((_exchange, _key, _content, _options, callback) => {
      callback(null);
      return true;
    }),
  };
  const processor = {
    process: vi.fn<CrawlProcessor['process']>().mockResolvedValue('done'),
  };
  const store = {
    isPending: vi.fn<(uid: string) => Promise<boolean>>().mockResolvedValue(true),
    fail: vi.fn<(uid: string, code: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  // 20 s of budget left unless a test says otherwise.
  const deadline = new Deadline(NOW.getTime() + 20_000);
  const consumer = new CrawlConsumer({
    channel,
    processor,
    store,
    logger,
    createDeadline: () => deadline,
    ...overrides,
  });
  return { consumer, channel, processor, store, logger, deadline };
}

type Setup = ReturnType<typeof setup>;

function expectAckedOnly({ channel }: Setup) {
  expect(channel.ack).toHaveBeenCalledOnce();
  expect(channel.nack).not.toHaveBeenCalled();
}

function expectRetried({ channel }: Setup, message: Delivery) {
  expect(channel.nack).toHaveBeenCalledExactlyOnceWith(message, false, false);
  expect(channel.ack).not.toHaveBeenCalled();
  expect(channel.publish).not.toHaveBeenCalled();
}

function expectDeadLettered({ channel }: Setup, message: Delivery, code: string) {
  expect(channel.publish).toHaveBeenCalledExactlyOnceWith(
    EXCHANGES.deadLetter,
    QUEUES.dead,
    message.content,
    {
      persistent: true,
      contentType: 'application/json',
      headers: { [FAILURE_HEADER]: code },
      messageId: JOB.uid,
    },
    expect.any(Function),
  );
}

describe('CrawlConsumer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('invalid messages', () => {
    it.each([
      ['malformed JSON', '{"uid":'],
      ['a missing field', { uid: JOB.uid, url: JOB.url }],
      ['an unexpected field', { ...JOB, extra: true }],
      ['an unsupported URL', { ...JOB, url: 'file:///etc/passwd' }],
    ])('dead-letters %s and acks it', async (_case, body) => {
      const context = setup();
      const message = delivery(body);

      await context.consumer.handle(message);

      expectDeadLettered(context, message, 'invalid_message');
      expectAckedOnly(context);
      expect(context.store.isPending).not.toHaveBeenCalled();
      expect(context.processor.process).not.toHaveBeenCalled();
    });

    it('omits a non-string message id', async () => {
      const context = setup();
      await context.consumer.handle(delivery('nope', 0, 42));

      const options = context.channel.publish.mock.calls[0]?.[3];
      expect(options).not.toHaveProperty('messageId');
    });

    it('still acks when the dead-letter publish fails', async () => {
      const context = setup();
      context.channel.publish.mockImplementation((...args) => {
        args[4](new Error('nacked'));
        return true;
      });

      await context.consumer.handle(delivery('nope'));

      expectAckedOnly(context);
      expect(context.logger.error).toHaveBeenCalled();
    });
  });

  describe('jobs', () => {
    it('acks a job that is no longer pending without crawling it', async () => {
      const context = setup();
      context.store.isPending.mockResolvedValue(false);

      await context.consumer.handle(delivery());

      expectAckedOnly(context);
      expect(context.processor.process).not.toHaveBeenCalled();
    });

    it.each(['done', 'skipped'] as const)('acks a %s crawl', async (outcome) => {
      const context = setup();
      context.processor.process.mockResolvedValue(outcome);

      await context.consumer.handle(delivery());

      expect(context.processor.process).toHaveBeenCalledExactlyOnceWith(JOB, context.deadline);
      expectAckedOnly(context);
      expect(context.channel.publish).not.toHaveBeenCalled();
      expect(context.store.fail).not.toHaveBeenCalled();
    });

    it.each([0, 1])('retries a transient failure after %i retries', async (retries) => {
      const context = setup();
      context.processor.process.mockRejectedValue(transientFailure('http_503'));
      const message = delivery(JOB, retries);

      await context.consumer.handle(message);

      expectRetried(context, message);
      expect(context.store.fail).not.toHaveBeenCalled();
    });

    it('treats unexpected errors as transient', async () => {
      const context = setup();
      context.processor.process.mockRejectedValue(new Error('browser crashed'));
      const message = delivery();

      await context.consumer.handle(message);

      expectRetried(context, message);
    });

    it('fails the job for good once two retries are spent', async () => {
      const context = setup();
      context.processor.process.mockRejectedValue(transientFailure('http_503'));
      const message = delivery(JOB, 2);

      await context.consumer.handle(message);

      expect(context.store.fail).toHaveBeenCalledExactlyOnceWith(JOB.uid, 'http_503');
      expectDeadLettered(context, message, 'http_503');
      expectAckedOnly(context);
    });

    it('fails a permanent failure without retrying', async () => {
      const context = setup();
      context.processor.process.mockRejectedValue(permanentFailure('robots_disallowed'));
      const message = delivery();

      await context.consumer.handle(message);

      expect(context.store.fail).toHaveBeenCalledExactlyOnceWith(JOB.uid, 'robots_disallowed');
      expectDeadLettered(context, message, 'robots_disallowed');
      expectAckedOnly(context);
    });

    it('fails a transient failure when the retry would not fit in the budget', async () => {
      const deadline = new Deadline(NOW.getTime() + 1_999);
      const context = setup({ createDeadline: () => deadline });
      context.processor.process.mockRejectedValue(transientFailure('page_timeout'));

      await context.consumer.handle(delivery());

      expect(context.store.fail).toHaveBeenCalledExactlyOnceWith(JOB.uid, 'page_timeout');
      expectAckedOnly(context);
    });

    it('measures the budget from requestedAt by default', async () => {
      const context = setup({ createDeadline: undefined });
      context.processor.process.mockRejectedValue(transientFailure('http_503'));
      // Requested 29 s ago: a retry in 2 s would land after the 30 s budget.
      const message = delivery({ ...JOB, requestedAt: '2026-11-22T11:59:41.000Z' });

      await context.consumer.handle(message);

      expect(context.store.fail).toHaveBeenCalledExactlyOnceWith(JOB.uid, 'http_503');
      expectAckedOnly(context);
    });

    it('still acks when the dead-letter publish fails', async () => {
      const context = setup();
      context.processor.process.mockRejectedValue(permanentFailure('auth_required'));
      context.channel.publish.mockImplementation(() => {
        throw new Error('channel closed');
      });

      await context.consumer.handle(delivery());

      expect(context.store.fail).toHaveBeenCalledOnce();
      expectAckedOnly(context);
      expect(context.logger.error).toHaveBeenCalled();
    });

    it('disposes the deadline of every job', async () => {
      const context = setup();
      const dispose = vi.spyOn(context.deadline, 'dispose');
      context.processor.process.mockRejectedValue(new Error('boom'));

      await context.consumer.handle(delivery());

      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  describe('storage errors', () => {
    it('delays the message through the retry queue when the lookup fails', async () => {
      const context = setup();
      context.store.isPending.mockRejectedValue(new Error('MongoDB down'));
      const message = delivery();

      await context.consumer.handle(message);

      expectRetried(context, message);
      expect(context.processor.process).not.toHaveBeenCalled();
    });

    it('drops the message once the budget is spent', async () => {
      const deadline = new Deadline(NOW.getTime() + 1_000);
      const context = setup({ createDeadline: () => deadline });
      context.store.isPending.mockRejectedValue(new Error('MongoDB down'));

      await context.consumer.handle(delivery());

      expectAckedOnly(context);
      expect(context.logger.error).toHaveBeenCalled();
    });

    it('retries when the final page update fails, without dead-lettering', async () => {
      const context = setup();
      context.processor.process.mockRejectedValue(permanentFailure('tls_error'));
      context.store.fail.mockRejectedValue(new Error('MongoDB down'));
      const message = delivery();

      await context.consumer.handle(message);

      expectRetried(context, message);
    });

    it('drops the message when the final page update fails without budget', async () => {
      const deadline = new Deadline(NOW.getTime() + 1_000);
      const context = setup({ createDeadline: () => deadline });
      context.processor.process.mockRejectedValue(permanentFailure('tls_error'));
      context.store.fail.mockRejectedValue(new Error('MongoDB down'));

      await context.consumer.handle(delivery());

      expectAckedOnly(context);
      expect(context.channel.publish).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('never rejects, even when the channel fails', async () => {
      const context = setup();
      context.channel.ack.mockImplementation(() => {
        throw new Error('channel closed');
      });

      await expect(context.consumer.handle(delivery())).resolves.toBeUndefined();
      expect(context.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) as unknown }),
        'message handling failed',
      );
    });

    it('waits for the messages being handled', async () => {
      const context = setup();
      let finish: (outcome: 'done') => void = () => undefined;
      context.processor.process.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      void context.consumer.handle(delivery());

      let idle = false;
      const waiting = context.consumer.whenIdle().then(() => {
        idle = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(idle).toBe(false);

      finish('done');
      await waiting;
      expect(context.channel.ack).toHaveBeenCalledOnce();
    });

    it('is idle when nothing is being handled', async () => {
      await expect(setup().consumer.whenIdle()).resolves.toBeUndefined();
    });
  });
});
