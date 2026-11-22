import type { CrawlStatusResponse } from '@crawler/shared/contracts';

/**
 * A failed API call. `code` is the API's stable error code, or one of the frontend's own:
 * `network_error` (the server could not be reached), `invalid_response` (unexpected body)
 * and `request_failed` (an error status without a code). `status` is absent for network errors.
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }

  /** The same request may succeed later: the server was unreachable or failed on its side. */
  get transient(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}

export async function createCrawl(url: string, signal: AbortSignal): Promise<string> {
  const { status, body } = await request('/crawl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (status !== 202) throw errorFrom(status, body);
  if (!isRecord(body) || typeof body.uid !== 'string') {
    throw new ApiError('invalid_response', status);
  }
  return body.uid;
}

export async function getCrawlStatus(
  uid: string,
  signal: AbortSignal,
): Promise<CrawlStatusResponse> {
  const { status, body } = await request(`/crawl/${encodeURIComponent(uid)}`, { signal });
  if (status !== 200) throw errorFrom(status, body);
  if (!isCrawlStatus(body)) throw new ApiError('invalid_response', status);
  return body;
}

/** Sends the request and reads the JSON body (`undefined` when there is none). */
async function request(
  path: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch {
    init.signal.throwIfAborted();
    throw new ApiError('network_error');
  }

  try {
    return { status: response.status, body: await response.json() };
  } catch {
    init.signal.throwIfAborted();
    return { status: response.status, body: undefined };
  }
}

function errorFrom(status: number, body: unknown): ApiError {
  if (isRecord(body) && typeof body.error === 'string') return new ApiError(body.error, status);
  return new ApiError(status < 400 ? 'invalid_response' : 'request_failed', status);
}

function isCrawlStatus(body: unknown): body is CrawlStatusResponse {
  if (!isRecord(body)) return false;
  switch (body.status) {
    case 'pending':
      return true;
    case 'error':
      return typeof body.message === 'string';
    case 'done': {
      const result = body.result;
      return (
        isRecord(result) &&
        typeof result.url === 'string' &&
        typeof result.description === 'string' &&
        typeof result.tookMs === 'number' &&
        // Only an inline JPEG may become the <img> source: never a remote URL.
        typeof result.image === 'string' &&
        result.image.startsWith('data:image/jpeg;base64,')
      );
    }
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
