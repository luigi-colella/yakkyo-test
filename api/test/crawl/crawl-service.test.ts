import { UrlValidationError } from '@crawler/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  CrawlService,
  DONE_CACHE_TTL_MS,
  PENDING_REUSE_WINDOW_MS,
} from '../../src/crawl/crawl-service.js';
import { ServiceUnavailableError } from '../../src/crawl/errors.js';
import type { PageStore } from '../../src/crawl/page-store.js';
import type { CrawlPublisher } from '../../src/crawl/rabbit.js';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const URL_INPUT = 'https://EXAMPLE.com/page#section';
const URL_KEY = 'https://example.com/page';

function fakeStore(overrides: Partial<PageStore> = {}) {
  return {
    findCachedDone: vi.fn<PageStore['findCachedDone']>().mockResolvedValue(null),
    expireStalePending: vi.fn<PageStore['expireStalePending']>().mockResolvedValue(undefined),
    findPending: vi.fn<PageStore['findPending']>().mockResolvedValue(null),
    insertPending: vi.fn<PageStore['insertPending']>().mockResolvedValue(true),
    markError: vi.fn<PageStore['markError']>().mockResolvedValue(undefined),
    getStatus: vi.fn<PageStore['getStatus']>().mockResolvedValue(null),
    ...overrides,
  };
}

function fakePublisher() {
  return { publish: vi.fn<CrawlPublisher['publish']>().mockResolvedValue(undefined) };
}

function setup(storeOverrides: Partial<PageStore> = {}) {
  const pages = fakeStore(storeOverrides);
  const publisher = fakePublisher();
  const uids = ['uid-1', 'uid-2', 'uid-3'];
  const service = new CrawlService({
    pages,
    publisher,
    now: () => NOW,
    createUid: () => uids.shift() ?? 'uid-x',
  });
  return { pages, publisher, service };
}

async function expectUnavailable(promise: Promise<unknown>, code: string, cause?: unknown) {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ServiceUnavailableError);
  expect(error).toMatchObject({ code });
  if (cause !== undefined) expect((error as Error).cause).toBe(cause);
}

describe('CrawlService.requestCrawl', () => {
  it.each([
    ['not a url', 'invalid_url'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['data:text/html,hi', 'unsupported_scheme'],
  ])('rejects %s with %s before touching storage', async (input, code) => {
    const { pages, publisher, service } = setup();

    const error = await service.requestCrawl(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UrlValidationError);
    expect(error).toMatchObject({ code });
    expect(pages.findCachedDone).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('creates and publishes a new job keyed by the normalized URL', async () => {
    const { pages, publisher, service } = setup();

    await expect(service.requestCrawl(URL_INPUT)).resolves.toBe('uid-1');
    expect(pages.findCachedDone).toHaveBeenCalledWith(URL_KEY, expect.any(Date));
    expect(pages.expireStalePending).toHaveBeenCalledWith(URL_KEY, expect.any(Date));
    expect(pages.findPending).toHaveBeenCalledWith(URL_KEY);
    expect(pages.insertPending).toHaveBeenCalledWith('uid-1', URL_KEY, NOW);
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith({
      uid: 'uid-1',
      url: URL_KEY,
      requestedAt: NOW.toISOString(),
    });
  });

  it('returns a cached done job without creating or publishing anything', async () => {
    const { pages, publisher, service } = setup({
      findCachedDone: vi.fn().mockResolvedValue('done-uid'),
    });

    await expect(service.requestCrawl(URL_INPUT)).resolves.toBe('done-uid');
    expect(pages.findCachedDone).toHaveBeenCalledWith(
      URL_KEY,
      new Date(NOW.getTime() - DONE_CACHE_TTL_MS),
    );
    expect(pages.expireStalePending).not.toHaveBeenCalled();
    expect(pages.insertPending).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('retires stale pending jobs before looking for a running one', async () => {
    const { pages, service } = setup();

    await service.requestCrawl(URL_INPUT);

    expect(pages.expireStalePending).toHaveBeenCalledWith(
      URL_KEY,
      new Date(NOW.getTime() - PENDING_REUSE_WINDOW_MS),
    );
    const [expiredAt] = vi.mocked(pages.expireStalePending).mock.invocationCallOrder;
    const [lookedUpAt] = vi.mocked(pages.findPending).mock.invocationCallOrder;
    expect(expiredAt).toBeLessThan(lookedUpAt!);
  });

  it('reuses a running pending job without publishing', async () => {
    const { pages, publisher, service } = setup({
      findPending: vi.fn().mockResolvedValue('pending-uid'),
    });

    await expect(service.requestCrawl(URL_INPUT)).resolves.toBe('pending-uid');
    expect(pages.insertPending).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('returns the winner uid when a concurrent request inserted first', async () => {
    const { pages, publisher, service } = setup({
      findPending: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('winner-uid'),
      insertPending: vi.fn().mockResolvedValue(false),
    });

    await expect(service.requestCrawl(URL_INPUT)).resolves.toBe('winner-uid');
    expect(pages.insertPending).toHaveBeenCalledTimes(1);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('inserts again when the winner was finalized before it could be read', async () => {
    const { pages, publisher, service } = setup({
      insertPending: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });

    await expect(service.requestCrawl(URL_INPUT)).resolves.toBe('uid-2');
    expect(pages.insertPending).toHaveBeenNthCalledWith(2, 'uid-2', URL_KEY, NOW);
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uid: 'uid-2' }),
    );
  });

  it('gives up with storage_unavailable after losing every insert', async () => {
    const { pages, publisher, service } = setup({
      insertPending: vi.fn().mockResolvedValue(false),
    });

    await expectUnavailable(service.requestCrawl(URL_INPUT), 'storage_unavailable');
    expect(pages.insertPending).toHaveBeenCalledTimes(2);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it.each(['findCachedDone', 'expireStalePending', 'findPending', 'insertPending'] as const)(
    'maps a %s failure to storage_unavailable',
    async (method) => {
      const cause = new Error('MongoDB down');
      const { publisher, service } = setup({ [method]: vi.fn().mockRejectedValue(cause) });

      await expectUnavailable(service.requestCrawl(URL_INPUT), 'storage_unavailable', cause);
      expect(publisher.publish).not.toHaveBeenCalled();
    },
  );

  it('fails the job and reports queue_unavailable when publishing fails', async () => {
    const cause = new Error('RabbitMQ down');
    const { pages, publisher, service } = setup();
    publisher.publish.mockRejectedValue(cause);

    await expectUnavailable(service.requestCrawl(URL_INPUT), 'queue_unavailable', cause);
    expect(pages.markError).toHaveBeenCalledWith('uid-1', 'queue_unavailable');
  });

  it('still reports queue_unavailable when failing the job also fails', async () => {
    const { publisher, service } = setup({
      markError: vi.fn().mockRejectedValue(new Error('MongoDB down')),
    });
    publisher.publish.mockRejectedValue(new Error('RabbitMQ down'));

    await expectUnavailable(service.requestCrawl(URL_INPUT), 'queue_unavailable');
  });
});

describe('CrawlService.getStatus', () => {
  it('returns the stored status', async () => {
    const { service } = setup({
      getStatus: vi.fn().mockResolvedValue({ status: 'pending' }),
    });

    await expect(service.getStatus('uid-1')).resolves.toEqual({ status: 'pending' });
  });

  it('returns null for an unknown uid', async () => {
    const { service } = setup();

    await expect(service.getStatus('missing')).resolves.toBeNull();
  });

  it('maps a storage failure to storage_unavailable', async () => {
    const cause = new Error('MongoDB down');
    const { service } = setup({ getStatus: vi.fn().mockRejectedValue(cause) });

    await expectUnavailable(service.getStatus('uid-1'), 'storage_unavailable', cause);
  });
});
