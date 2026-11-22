import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { UrlValidationError } from '@crawler/shared';
import type { CrawlStatusResponse } from '@crawler/shared';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import { CrawlService } from '../src/crawl/crawl-service.js';
import type { CrawlService as CrawlServiceType } from '../src/crawl/crawl-service.js';
import { ServiceUnavailableError } from '../src/crawl/errors.js';
import type { HealthStatus } from '../src/health/health.js';
import type { PageStore } from '../src/crawl/page-store.js';
import type { CrawlPublisher } from '../src/crawl/rabbit.js';

const UID = '01JD3W5Q0V6N8XK2M4P7R9T1YZ';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let publicDir: string;

beforeAll(() => {
  publicDir = mkdtempSync(path.join(tmpdir(), 'crawler-public-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Mini Crawler</title>');
  mkdirSync(path.join(publicDir, 'assets'));
  writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'console.log("app");');
});

afterAll(() => rmSync(publicDir, { recursive: true, force: true }));

afterEach(() => vi.useRealTimers());

function fakeCrawlService() {
  return {
    requestCrawl: vi.fn<CrawlServiceType['requestCrawl']>().mockResolvedValue(UID),
    getStatus: vi.fn<CrawlServiceType['getStatus']>().mockResolvedValue(null),
  };
}

interface LogEntry {
  level: number;
  req?: { id?: string };
  err?: { type?: string; message?: string };
}

function setup(overrides: Partial<AppDeps> = {}) {
  const crawlService = fakeCrawlService();
  const logLines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => logLines.push(line) });
  const checkHealth = vi
    .fn<() => Promise<HealthStatus>>()
    .mockResolvedValue({ mongo: true, rabbit: true });
  const app = createApp({ crawlService, checkHealth, logger, publicDir, ...overrides });
  const logs = () => logLines.map((line) => JSON.parse(line) as LogEntry);
  return { app, crawlService, checkHealth, logs };
}

describe('POST /crawl', () => {
  it('returns 202 with the uid and passes the raw URL to the service', async () => {
    const { app, crawlService } = setup();

    const res = await request(app).post('/crawl').send({ url: 'https://example.com/#top' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ uid: UID });
    expect(crawlService.requestCrawl).toHaveBeenCalledWith('https://example.com/#top');
  });

  it.each([
    ['an empty object', {}],
    ['a non-string url', { url: 5 }],
    ['a null url', { url: null }],
    ['an array', [{ url: 'https://example.com' }]],
  ])('rejects %s with invalid_url', async (_name, body) => {
    const { app, crawlService } = setup();

    const res = await request(app).post('/crawl').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_url' });
    expect(crawlService.requestCrawl).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON with invalid_url', async () => {
    const { app, crawlService } = setup();

    const res = await request(app)
      .post('/crawl')
      .set('Content-Type', 'text/plain')
      .send('https://example.com');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_url' });
    expect(crawlService.requestCrawl).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with invalid_url and logs the cause', async () => {
    const { app, logs } = setup();

    const res = await request(app)
      .post('/crawl')
      .set('Content-Type', 'application/json')
      .send('{"url":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_url' });
    expect(logs().find((entry) => entry.err)).toMatchObject({
      level: 40,
      err: { type: 'SyntaxError' },
    });
  });

  it('rejects a body over 16 kB with invalid_url', async () => {
    const { app, crawlService } = setup();

    const res = await request(app)
      .post('/crawl')
      .send({ url: `https://example.com/?q=${'a'.repeat(17 * 1024)}` });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_url' });
    expect(crawlService.requestCrawl).not.toHaveBeenCalled();
  });

  it.each(['invalid_url', 'unsupported_scheme'] as const)(
    'maps a UrlValidationError(%s) to 400',
    async (code) => {
      const { app, crawlService } = setup();
      crawlService.requestCrawl.mockRejectedValue(new UrlValidationError(code));

      const res = await request(app).post('/crawl').send({ url: 'whatever' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: code });
    },
  );

  it.each([
    ['ftp://example.com', 'unsupported_scheme'],
    ['data:text/html,hi', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['/relative/path', 'invalid_url'],
  ])('rejects %s with %s through the real CrawlService', async (url, code) => {
    // Validation happens before any storage or queue access.
    const crawlService = new CrawlService({
      pages: {} as PageStore,
      publisher: {} as CrawlPublisher,
    });
    const { app } = setup({ crawlService });

    const res = await request(app).post('/crawl').send({ url });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: code });
  });

  it.each(['queue_unavailable', 'storage_unavailable'] as const)(
    'maps ServiceUnavailableError(%s) to 503',
    async (code) => {
      const { app, crawlService } = setup();
      crawlService.requestCrawl.mockRejectedValue(new ServiceUnavailableError(code));

      const res = await request(app).post('/crawl').send({ url: 'https://example.com' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: code });
    },
  );

  it('hides unexpected errors behind a 500 and logs them', async () => {
    const { app, crawlService, logs } = setup();
    crawlService.requestCrawl.mockRejectedValue(new Error('secret connection string'));

    const res = await request(app).post('/crawl').send({ url: 'https://example.com' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expect(res.text).not.toContain('secret');
    expect(logs().find((entry) => entry.err)).toMatchObject({
      level: 50,
      err: { message: 'secret connection string' },
    });
  });
});

describe('GET /crawl/:uid', () => {
  it.each<[string, CrawlStatusResponse]>([
    ['pending', { status: 'pending' }],
    ['error', { status: 'error', message: 'auth_required' }],
    [
      'done',
      {
        status: 'done',
        result: {
          url: 'https://example.com/final',
          description: 'A clean layout',
          image: 'data:image/jpeg;base64,AAAA',
          tookMs: 1234,
        },
      },
    ],
  ])('returns a %s status as-is and never cached', async (_name, status) => {
    const { app, crawlService } = setup();
    crawlService.getStatus.mockResolvedValue(status);

    const res = await request(app).get(`/crawl/${UID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(status);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(crawlService.getStatus).toHaveBeenCalledWith(UID);
  });

  it('returns 404 for an unknown uid', async () => {
    const { app } = setup();

    const res = await request(app).get(`/crawl/${UID}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it.each(['not-a-ulid', '123', `${UID}0`, 'IIIIIIIIIIIIIIIIIIIIIIIIII'])(
    'returns 404 for the malformed uid %s without querying storage',
    async (uid) => {
      const { app, crawlService } = setup();

      const res = await request(app).get(`/crawl/${uid}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
      expect(crawlService.getStatus).not.toHaveBeenCalled();
    },
  );

  it('maps storage failures to 503', async () => {
    const { app, crawlService } = setup();
    crawlService.getStatus.mockRejectedValue(new ServiceUnavailableError('storage_unavailable'));

    const res = await request(app).get(`/crawl/${UID}`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'storage_unavailable' });
  });
});

describe('request id', () => {
  it('reuses a well-formed X-Request-Id and logs it with the request', async () => {
    const { app, logs } = setup();

    const res = await request(app).get('/healthz').set('X-Request-Id', 'client-req.42:a_b');

    expect(res.headers['x-request-id']).toBe('client-req.42:a_b');
    expect(logs().map((entry) => entry.req?.id)).toContain('client-req.42:a_b');
  });

  it('generates a UUID when the header is missing', async () => {
    const { app } = setup();

    const res = await request(app).get('/healthz');

    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['with spaces', 'id with spaces'],
    ['with a log-injection attempt', 'id"}\\n{"level":60'],
  ])('replaces a request id %s', async (_name, id) => {
    const { app } = setup();

    const res = await request(app).get('/healthz').set('X-Request-Id', id);

    expect(res.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('gives every request its own id', async () => {
    const { app } = setup();

    const [first, second] = await Promise.all([
      request(app).get('/healthz'),
      request(app).get('/healthz'),
    ]);

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('rate limit', () => {
  const limit = { limit: 3, windowMs: 60_000 };

  async function exhaust(app: ReturnType<typeof createApp>) {
    for (let i = 0; i < limit.limit; i++) {
      const res = await request(app).post('/crawl').send({ url: 'https://example.com' });
      expect(res.status).toBe(202);
    }
  }

  it('answers 429 rate_limited once POST /crawl exceeds the limit', async () => {
    const { app, crawlService } = setup({ rateLimit: limit });
    await exhaust(app);

    const res = await request(app).post('/crawl').send({ url: 'https://example.com' });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited' });
    expect(res.headers['ratelimit-policy']).toBeDefined();
    expect(crawlService.requestCrawl).toHaveBeenCalledTimes(limit.limit);
  });

  it('counts invalid requests too', async () => {
    const { app } = setup({ rateLimit: limit });
    for (let i = 0; i < limit.limit; i++) await request(app).post('/crawl').send({});

    const res = await request(app).post('/crawl').send({ url: 'https://example.com' });

    expect(res.status).toBe(429);
  });

  it('never limits status polling or health checks', async () => {
    const { app } = setup({ rateLimit: limit });
    await exhaust(app);

    for (let i = 0; i < limit.limit + 2; i++) {
      expect((await request(app).get(`/crawl/${UID}`)).status).toBe(404);
      expect((await request(app).get('/healthz')).status).toBe(200);
    }
  });

  it('defaults to 10 requests per minute', async () => {
    const { app } = setup();
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/crawl').send({ url: 'https://a.example' })).status).toBe(
        202,
      );
    }

    const res = await request(app).post('/crawl').send({ url: 'https://a.example' });

    expect(res.status).toBe(429);
  });

  it('accepts requests again once the window has passed', async () => {
    // Only the store's reset interval and the clock are faked: supertest needs real I/O timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { app } = setup({ rateLimit: limit });
    await exhaust(app);
    expect((await request(app).post('/crawl').send({ url: 'https://a.example' })).status).toBe(429);

    vi.advanceTimersByTime(limit.windowMs);

    expect((await request(app).post('/crawl').send({ url: 'https://a.example' })).status).toBe(202);
  });
});

describe('GET /healthz', () => {
  it('answers 200 when MongoDB and RabbitMQ are reachable', async () => {
    const { app } = setup();

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', mongo: true, rabbit: true });
  });

  it.each<HealthStatus>([
    { mongo: false, rabbit: true },
    { mongo: true, rabbit: false },
    { mongo: false, rabbit: false },
  ])('answers 503 when a dependency is down (%o)', async (health) => {
    const { app, checkHealth } = setup();
    checkHealth.mockResolvedValue(health);

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', ...health });
  });
});

describe('security headers', () => {
  it('allows data: images in the CSP, for the screenshot', async () => {
    const { app } = setup();

    const res = await request(app).get('/healthz');

    expect(res.headers['content-security-policy']).toContain("img-src 'self' data:");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('static frontend', () => {
  it('serves index.html at the root', async () => {
    const { app } = setup();

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mini Crawler</title>');
  });

  it('serves built assets', async () => {
    const { app } = setup();

    const res = await request(app).get('/assets/app.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log');
  });

  it('falls back to index.html for client-side routes', async () => {
    const { app } = setup();

    const res = await request(app).get('/some/client/route').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mini Crawler</title>');
  });

  it('answers 404 JSON for a missing asset instead of index.html', async () => {
    const { app } = setup();

    const res = await request(app)
      .get('/assets/missing.js')
      .set('Accept', 'application/javascript');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it.each(['/crawl', '/crawl/unknown/path', '/healthz/extra'])(
    'never falls back for the API path %s',
    async (url) => {
      const { app } = setup();

      const res = await request(app).get(url).set('Accept', 'text/html');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    },
  );

  it('does not fall back for non-GET requests', async () => {
    const { app } = setup();

    const res = await request(app).put('/some/route').set('Accept', 'text/html');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('answers 404 JSON when the frontend has not been built', async () => {
    const { app } = setup({ publicDir: path.join(publicDir, 'does-not-exist') });

    const res = await request(app).get('/').set('Accept', 'text/html');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
