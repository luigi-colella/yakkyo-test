import type { CrawlResult } from '@crawler/shared/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/services/api.js';
import { describeError } from '../../src/utils/error-messages.js';
import { PollTimeoutError, type SettledStatus } from '../../src/services/polling.js';
import { type CrawlDeps, useCrawl } from '../../src/composables/use-crawl.js';

const UID = '01JD4V1H3Q7X9Z8Y6W5V4T3S2R';
const RESULT: CrawlResult = {
  url: 'https://example.com/',
  description: 'Clean layout',
  image: 'data:image/jpeg;base64,/9j/',
  tookMs: 1234,
};

/** A promise with its settle functions, to control when a fake answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakes(overrides: Partial<CrawlDeps> = {}) {
  return {
    createCrawl: vi.fn<CrawlDeps['createCrawl']>().mockResolvedValue(UID),
    getCrawlStatus: vi.fn<CrawlDeps['getCrawlStatus']>().mockResolvedValue({ status: 'pending' }),
    pollUntilSettled: vi
      .fn<CrawlDeps['pollUntilSettled']>()
      .mockResolvedValue({ status: 'done', result: RESULT }),
    now: () => 42,
    ...overrides,
  };
}

describe('useCrawl', () => {
  it('starts idle and not busy', () => {
    const { view, busy } = useCrawl(fakes());

    expect(view.value).toEqual({ name: 'idle' });
    expect(busy.value).toBe(false);
  });

  it('goes through submitting and polling to success', async () => {
    const created = deferred<string>();
    const polled = deferred<SettledStatus>();
    const { view, busy, submit } = useCrawl(
      fakes({
        createCrawl: vi.fn(() => created.promise),
        pollUntilSettled: vi.fn(() => polled.promise),
      }),
    );

    const run = submit('https://example.com');
    expect(view.value).toEqual({ name: 'submitting' });
    expect(busy.value).toBe(true);

    created.resolve(UID);
    await vi.waitFor(() => expect(view.value).toEqual({ name: 'polling' }));
    expect(busy.value).toBe(true);

    polled.resolve({ status: 'done', result: RESULT });
    await run;
    expect(view.value).toEqual({ name: 'success', result: RESULT });
    expect(busy.value).toBe(false);
  });

  it('polls the status of the returned uid from the submission time', async () => {
    const deps = fakes();
    const { submit } = useCrawl(deps);

    await submit('https://example.com');

    expect(deps.createCrawl).toHaveBeenCalledWith('https://example.com', expect.any(AbortSignal));
    const [check, signal, startedAt] = vi.mocked(deps.pollUntilSettled).mock.calls[0]!;
    expect(startedAt).toBe(42);
    expect(signal).toBe(vi.mocked(deps.createCrawl).mock.calls[0]![1]);

    const checkSignal = new AbortController().signal;
    await check(checkSignal);
    expect(deps.getCrawlStatus).toHaveBeenCalledWith(UID, checkSignal);
  });

  it('shows the readable message of a failed crawl', async () => {
    const { view, submit } = useCrawl(
      fakes({
        pollUntilSettled: vi
          .fn()
          .mockResolvedValue({ status: 'error', message: 'robots_disallowed' }),
      }),
    );

    await submit('https://example.com');

    expect(view.value).toEqual({ name: 'error', message: describeError('robots_disallowed') });
  });

  it.each<[string, Partial<CrawlDeps>, string]>([
    [
      'a rejected request',
      { createCrawl: vi.fn().mockRejectedValue(new ApiError('rate_limited', 429)) },
      'rate_limited',
    ],
    [
      'a polling timeout',
      { pollUntilSettled: vi.fn().mockRejectedValue(new PollTimeoutError()) },
      'poll_timeout',
    ],
    [
      'an unknown job',
      { pollUntilSettled: vi.fn().mockRejectedValue(new ApiError('not_found', 404)) },
      'not_found',
    ],
    [
      'an unexpected error',
      { createCrawl: vi.fn().mockRejectedValue(new Error('bug')) },
      'request_failed',
    ],
  ])('shows an error for %s', async (_name, overrides, code) => {
    const { view, busy, submit } = useCrawl(fakes(overrides));

    await submit('https://example.com');

    expect(view.value).toEqual({ name: 'error', message: describeError(code) });
    expect(busy.value).toBe(false);
  });

  it('retries the last URL', async () => {
    const deps = fakes({
      pollUntilSettled: vi
        .fn<CrawlDeps['pollUntilSettled']>()
        .mockRejectedValueOnce(new PollTimeoutError())
        .mockResolvedValueOnce({ status: 'done', result: RESULT }),
    });
    const { view, submit, retry } = useCrawl(deps);
    await submit('https://example.com/a');
    expect(view.value.name).toBe('error');

    await retry();

    expect(deps.createCrawl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.createCrawl).mock.calls[1]![0]).toBe('https://example.com/a');
    expect(view.value).toEqual({ name: 'success', result: RESULT });
  });

  it('cancels the previous run when a new URL is submitted', async () => {
    const first = deferred<SettledStatus>();
    const deps = fakes({
      pollUntilSettled: vi
        .fn<CrawlDeps['pollUntilSettled']>()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ status: 'error', message: 'http_404' }),
    });
    const { view, submit } = useCrawl(deps);

    const firstRun = submit('https://example.com/a');
    await vi.waitFor(() => expect(deps.pollUntilSettled).toHaveBeenCalledTimes(1));
    await submit('https://example.com/b');
    // The first run's late result must not overwrite the second one.
    first.resolve({ status: 'done', result: RESULT });
    await firstRun;

    expect(vi.mocked(deps.createCrawl).mock.calls[0]![1].aborted).toBe(true);
    expect(view.value).toEqual({ name: 'error', message: describeError('http_404') });
  });

  it('aborts on dispose and ignores the late outcome', async () => {
    const polled = deferred<SettledStatus>();
    const deps = fakes({ pollUntilSettled: vi.fn(() => polled.promise) });
    const { view, submit, dispose } = useCrawl(deps);

    const run = submit('https://example.com');
    await vi.waitFor(() => expect(view.value).toEqual({ name: 'polling' }));
    dispose();
    polled.reject(new DOMException('aborted', 'AbortError'));
    await run;

    expect(vi.mocked(deps.createCrawl).mock.calls[0]![1].aborted).toBe(true);
    expect(view.value).toEqual({ name: 'polling' });
  });
});
