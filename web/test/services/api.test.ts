import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createCrawl, getCrawlStatus } from '../../src/services/api.js';

const UID = '01JD4V1H3Q7X9Z8Y6W5V4T3S2R';
const DONE = {
  status: 'done',
  result: {
    url: 'https://example.com/',
    description: 'Clean layout',
    image: 'data:image/jpeg;base64,/9j/',
    tookMs: 1234,
  },
};

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => fetchMock.mockReset());

function reply(status: number, body?: unknown): void {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  fetchMock.mockResolvedValueOnce(new Response(text, { status }));
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('createCrawl', () => {
  it('posts the URL as JSON and returns the uid', async () => {
    reply(202, { uid: UID });
    const abort = signal();

    await expect(createCrawl('https://example.com', abort)).resolves.toBe(UID);

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/crawl');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"url":"https://example.com"}');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(init?.signal).toBe(abort);
  });

  it.each([
    [400, 'invalid_url'],
    [400, 'unsupported_scheme'],
    [429, 'rate_limited'],
    [503, 'queue_unavailable'],
  ])('turns %i { error: %s } into an ApiError with that code', async (status, code) => {
    reply(status, { error: code });

    const error = await apiError(createCrawl('x', signal()));
    expect(error).toMatchObject({ code, status });
  });

  it('uses request_failed for an error status without a code', async () => {
    reply(502, '<html>Bad gateway</html>');

    expect(await apiError(createCrawl('x', signal()))).toMatchObject({
      code: 'request_failed',
      status: 502,
    });
  });

  it.each([
    ['a missing uid', {}],
    ['a non-string uid', { uid: 42 }],
    ['a non-JSON body', 'ok'],
  ])('rejects a 202 with %s as invalid_response', async (_name, body) => {
    reply(202, body);

    expect((await apiError(createCrawl('x', signal()))).code).toBe('invalid_response');
  });

  it('rejects an unexpected success status as invalid_response', async () => {
    reply(200, { uid: UID });

    expect((await apiError(createCrawl('x', signal()))).code).toBe('invalid_response');
  });

  it('reports an unreachable server as a transient network_error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await apiError(createCrawl('x', signal()));
    expect(error.code).toBe('network_error');
    expect(error.status).toBeUndefined();
    expect(error.transient).toBe(true);
  });

  it('propagates the abort reason instead of a network error', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    await expect(createCrawl('x', controller.signal)).rejects.toMatchObject({ message: 'stop' });
  });
});

describe('getCrawlStatus', () => {
  it('requests the status of the uid', async () => {
    reply(200, { status: 'pending' });

    await expect(getCrawlStatus(UID, signal())).resolves.toEqual({ status: 'pending' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`/crawl/${UID}`);
  });

  it('encodes the uid in the path', async () => {
    reply(404, { error: 'not_found' });

    await apiError(getCrawlStatus('a/b?c', signal()));
    expect(fetchMock.mock.calls[0]![0]).toBe('/crawl/a%2Fb%3Fc');
  });

  it('returns done and error statuses', async () => {
    reply(200, DONE);
    await expect(getCrawlStatus(UID, signal())).resolves.toEqual(DONE);

    reply(200, { status: 'error', message: 'robots_disallowed' });
    await expect(getCrawlStatus(UID, signal())).resolves.toEqual({
      status: 'error',
      message: 'robots_disallowed',
    });
  });

  it.each([
    ['an unknown status', { status: 'running' }],
    ['an error without message', { status: 'error' }],
    ['done without result', { status: 'done' }],
    ['a result without tookMs', { status: 'done', result: { ...DONE.result, tookMs: '1' } }],
    [
      'a remote image URL',
      { status: 'done', result: { ...DONE.result, image: 'https://x/y.jpg' } },
    ],
    [
      'a non-JPEG data URI',
      { status: 'done', result: { ...DONE.result, image: 'data:text/html,x' } },
    ],
    ['null', null],
    ['an array', []],
  ])('rejects %s as invalid_response', async (_name, body) => {
    reply(200, body);

    expect((await apiError(getCrawlStatus(UID, signal()))).code).toBe('invalid_response');
  });

  it('reports 404 as a non-transient not_found', async () => {
    reply(404, { error: 'not_found' });

    const error = await apiError(getCrawlStatus(UID, signal()));
    expect(error).toMatchObject({ code: 'not_found', status: 404 });
    expect(error.transient).toBe(false);
  });

  it('marks server errors as transient', async () => {
    reply(503, { error: 'storage_unavailable' });

    const error = await apiError(getCrawlStatus(UID, signal()));
    expect(error).toMatchObject({ code: 'storage_unavailable', status: 503 });
    expect(error.transient).toBe(true);
  });
});
