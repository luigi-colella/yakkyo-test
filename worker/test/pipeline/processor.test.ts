import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CrawlMessage } from '@crawler/shared';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MOCK_DESCRIPTION, MockDesignAnalyzer } from '../../src/analysis/analyzer.js';
import { Deadline } from '../../src/pipeline/deadline.js';
import { CrawlFailure, permanentFailure, transientFailure } from '../../src/pipeline/errors.js';
import type { CrawlResultRecord } from '../../src/storage/page-store.js';
import {
  CrawlProcessor,
  DEFAULT_VIEWPORT,
  explainNavigationError,
  httpStatusFailure,
} from '../../src/pipeline/processor.js';
import type { CrawlProcessorOptions } from '../../src/pipeline/processor.js';
import { SafeUrlGuard } from '../../src/security/security.js';
import type { AddressResolver } from '../../src/security/security.js';

describe('httpStatusFailure', () => {
  it.each([200, 204, 304, 399])('accepts %i', (status) => {
    expect(httpStatusFailure(status)).toBeUndefined();
  });

  it.each([401, 407])('maps %i to a permanent auth_required', (status) => {
    expect(httpStatusFailure(status)).toMatchObject({ code: 'auth_required', retryable: false });
  });

  it.each([400, 403, 404, 410, 451])('maps %i to a permanent http_<status>', (status) => {
    expect(httpStatusFailure(status)).toMatchObject({ code: `http_${status}`, retryable: false });
  });

  it.each([500, 502, 503, 504])('maps %i to a transient http_<status>', (status) => {
    expect(httpStatusFailure(status)).toMatchObject({ code: `http_${status}`, retryable: true });
  });

  it('treats a navigation without a document as a transient failure', () => {
    expect(httpStatusFailure(undefined)).toMatchObject({
      code: 'navigation_failed',
      retryable: true,
    });
  });
});

describe('explainNavigationError', () => {
  const tunnelError = new Error('net::ERR_TUNNEL_CONNECTION_FAILED at http://site.test/');
  const refused = permanentFailure('unsafe_target');
  const unreachable = transientFailure('navigation_failed');

  it('prefers the reason a navigation was refused', () => {
    expect(explainNavigationError(tunnelError, refused, unreachable)).toBe(refused);
    const timeout = Object.assign(new Error('Timeout 100ms exceeded'), { name: 'TimeoutError' });
    expect(explainNavigationError(timeout, refused, undefined)).toBe(refused);
  });

  it('keeps a specific browser error over what the proxy met', () => {
    const tls = new Error('net::ERR_CERT_DATE_INVALID at https://site.test/');
    expect(explainNavigationError(tls, undefined, unreachable)).toMatchObject({
      code: 'tls_error',
    });
    const timeout = Object.assign(new Error('Timeout 100ms exceeded'), { name: 'TimeoutError' });
    expect(explainNavigationError(timeout, undefined, unreachable)).toMatchObject({
      code: 'page_timeout',
    });
  });

  it('explains a generic proxy error with the failure the proxy recorded', () => {
    expect(explainNavigationError(tunnelError, undefined, refused)).toBe(refused);
  });

  it('falls back to a transient navigation_failed', () => {
    expect(explainNavigationError(tunnelError, undefined, undefined)).toMatchObject({
      code: 'navigation_failed',
      retryable: true,
    });
  });
});

/*
 * Real Chromium against a local fixture server. The fixture hosts use the reserved `.test`
 * TLD, which Chromium cannot resolve: pages load only because every connection goes through
 * the pinned proxy, which connects to the address returned by the injected resolver.
 */
describe('CrawlProcessor with Chromium', () => {
  const ALLOWED = ['site.test', 'other.test', 'denied.test'];
  const requests: { host: string; path: string }[] = [];
  let browser: Browser;
  let fixture: http.Server;
  let port: number;

  const at = (host: string, path = '/') => `http://${host}:${port}${path}`;

  const resolve: AddressResolver = (hostname) => {
    if (hostname.endsWith('.test') && hostname !== 'missing.test') {
      return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    }
    return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
  };

  beforeAll(async () => {
    const executable = chromium.executablePath();
    if (!existsSync(executable)) {
      throw new Error(`Chromium for Playwright is not installed: run \`yarn setup:browser\``);
    }
    browser = await chromium.launch({ proxy: { server: 'http://per-context' } });

    fixture = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      const path = req.url ?? '/';
      requests.push({ host, path });
      serveFixture(host, path, res);
    });
    fixture.listen(0, '127.0.0.1');
    await new Promise((done) => fixture.once('listening', done));
    port = (fixture.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    fixture?.close();
  });

  afterEach(() => {
    requests.length = 0;
    // Each job closes its own context.
    expect(browser.contexts()).toHaveLength(0);
  });

  function serveFixture(host: string, path: string, res: http.ServerResponse): void {
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    const redirect = (status: number, location: string) => {
      res.writeHead(status, { location });
      res.end();
    };

    if (path === '/robots.txt') {
      if (host === 'denied.test') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /\n');
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    switch (path) {
      case '/':
        return html('<h1 style="color:#0a5">Fixture</h1><p>Hello</p>');
      case '/redirect':
        return redirect(302, '/landing');
      case '/landing':
        return html('<h1>Landing</h1>');
      case '/to-denied':
        return redirect(301, at('denied.test', '/'));
      case '/to-blocked':
        return redirect(302, at('blocked.test', '/'));
      case '/to-other':
        return redirect(302, at('other.test', '/landing'));
      case '/js-to-blocked':
        return html(`<script>location.href = ${JSON.stringify(at('blocked.test', '/'))}</script>`);
      case '/blocked-subresource':
        return html(`<h1>Page</h1><img src="${at('blocked.test', '/pixel.png')}">`);
      case '/busy':
        return html('<h1>Busy</h1><script>setInterval(() => fetch("/ping"), 100)</script>');
      case '/ping':
        res.writeHead(204).end();
        return;
      case '/auth':
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' });
        res.end('Unauthorized');
        return;
      case '/missing':
        res.writeHead(404).end('Not found');
        return;
      case '/broken':
        res.writeHead(500).end('Server error');
        return;
      default:
        res.writeHead(404).end();
    }
  }

  function setup(options: Partial<CrawlProcessorOptions> = {}) {
    const stored: CrawlResultRecord[] = [];
    const complete = vi.fn((_uid: string, record: CrawlResultRecord) => {
      stored.push(record);
      return Promise.resolve(true);
    });
    const processor = new CrawlProcessor({
      browser,
      guard: new SafeUrlGuard({ allowedHosts: new Set(ALLOWED), resolve }),
      analyzer: new MockDesignAnalyzer(),
      store: { complete },
      networkIdleTimeoutMs: 2_000,
      ...options,
    });
    return { processor, complete, stored };
  }

  async function crawl(
    url: string,
    options: Partial<CrawlProcessorOptions> = {},
    { deadline = new Deadline(Date.now() + 20_000), requestedAt = new Date() } = {},
  ) {
    const context = setup(options);
    const message: CrawlMessage = {
      uid: '01JCXZ7Y7K3M5V8Q9R2T4W6Y8A',
      url,
      requestedAt: requestedAt.toISOString(),
    };
    try {
      const outcome = await context.processor.process(message, deadline);
      return { ...context, outcome };
    } finally {
      deadline.dispose();
    }
  }

  async function crawlFailure(url: string, options: Partial<CrawlProcessorOptions> = {}) {
    const error = await crawl(url, options).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(CrawlFailure);
    return error as CrawlFailure;
  }

  it('captures, analyzes and stores a page', async () => {
    const { outcome, complete, stored } = await crawl(at('site.test'));

    expect(outcome).toBe('done');
    expect(complete).toHaveBeenCalledOnce();
    const [record] = stored;
    expect(record?.image.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    expect(record).toMatchObject({
      description: MOCK_DESCRIPTION,
      finalUrl: at('site.test'),
      meta: {
        viewport: { w: DEFAULT_VIEWPORT.width, h: DEFAULT_VIEWPORT.height },
        userAgent: expect.stringContaining('Chrome') as unknown,
        timestamp: expect.any(Date) as unknown,
      },
    });
    expect(record?.tookMs).toBeGreaterThanOrEqual(0);
    expect(requests).toContainEqual({ host: 'site.test', path: '/robots.txt' });
  }, 30_000);

  it('measures tookMs from the request time', async () => {
    const requestedAt = new Date(Date.now() - 5_000);
    const now = () => requestedAt.getTime() + 7_000;
    const { stored } = await crawl(at('site.test'), { now }, { requestedAt });
    expect(stored[0]?.tookMs).toBe(7_000);
    expect(stored[0]?.meta.timestamp).toEqual(new Date(now()));
  }, 30_000);

  it('keeps the URL after redirects', async () => {
    const { stored } = await crawl(at('site.test', '/redirect'));
    expect(stored[0]?.finalUrl).toBe(at('site.test', '/landing'));
  }, 30_000);

  it('checks robots.txt of the origin a redirect leads to', async () => {
    const { stored } = await crawl(at('site.test', '/to-other'));

    expect(stored[0]?.finalUrl).toBe(at('other.test', '/landing'));
    expect(requests).toContainEqual({ host: 'other.test', path: '/robots.txt' });
    // Fetched once per origin, even though the guard sees each navigation.
    const siteRobots = requests.filter((r) => r.host === 'site.test' && r.path === '/robots.txt');
    expect(siteRobots).toHaveLength(1);
  }, 30_000);

  it('refuses a page disallowed by robots.txt before opening a browser context', async () => {
    const newContext = vi.spyOn(browser, 'newContext');
    try {
      const failure = await crawlFailure(at('denied.test'));
      expect(failure).toMatchObject({ code: 'robots_disallowed', retryable: false });
      expect(newContext).not.toHaveBeenCalled();
    } finally {
      newContext.mockRestore();
    }
  }, 30_000);

  it('refuses a redirect to an origin disallowed by robots.txt', async () => {
    const failure = await crawlFailure(at('site.test', '/to-denied'));
    expect(failure).toMatchObject({ code: 'robots_disallowed', retryable: false });
    // Known limit: Playwright does not route redirect hops, so the target is requested once
    // before its robots.txt is read; the page is refused all the same.
    expect(requests).toContainEqual({ host: 'denied.test', path: '/robots.txt' });
  }, 30_000);

  it('refuses a page on a non-public address', async () => {
    const failure = await crawlFailure(at('blocked.test'));
    expect(failure).toMatchObject({ code: 'unsafe_target', retryable: false });
    expect(requests).toHaveLength(0);
  }, 30_000);

  it('refuses a redirect to a non-public address', async () => {
    // The proxy refuses the hop and answers 403 to Chromium: not to be reported as http_403.
    const failure = await crawlFailure(at('site.test', '/to-blocked'));
    expect(failure).toMatchObject({ code: 'unsafe_target', retryable: false });
    expect(requests.some((r) => r.host === 'blocked.test')).toBe(false);
  }, 30_000);

  it('refuses a script navigation to a non-public address', async () => {
    const failure = await crawlFailure(at('site.test', '/js-to-blocked'));
    expect(failure).toMatchObject({ code: 'unsafe_target', retryable: false });
    expect(requests.some((r) => r.host === 'blocked.test')).toBe(false);
  }, 30_000);

  it('only blocks a sub-resource on a non-public address', async () => {
    const { outcome } = await crawl(at('site.test', '/blocked-subresource'));
    expect(outcome).toBe('done');
    expect(requests.some((r) => r.host === 'blocked.test')).toBe(false);
  }, 30_000);

  it('reports an unknown domain as a permanent dns_failed', async () => {
    const failure = await crawlFailure(at('missing.test'));
    expect(failure).toMatchObject({ code: 'dns_failed', retryable: false });
  }, 30_000);

  it('marks a page behind basic auth as auth_required', async () => {
    const failure = await crawlFailure(at('site.test', '/auth'));
    expect(failure).toMatchObject({ code: 'auth_required', retryable: false });
  }, 30_000);

  it('fails permanently on a client error and transiently on a server error', async () => {
    await expect(crawlFailure(at('site.test', '/missing'))).resolves.toMatchObject({
      code: 'http_404',
      retryable: false,
    });
    await expect(crawlFailure(at('site.test', '/broken'))).resolves.toMatchObject({
      code: 'http_500',
      retryable: true,
    });
  }, 30_000);

  it('falls back to domcontentloaded when the network never goes idle', async () => {
    const startedAt = Date.now();
    const { outcome } = await crawl(at('site.test', '/busy'), { networkIdleTimeoutMs: 1_500 });

    expect(outcome).toBe('done');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(requests.filter((r) => r.path === '/ping').length).toBeGreaterThan(3);
  }, 30_000);

  it('fails with page_timeout when the budget is already spent', async () => {
    const newContext = vi.spyOn(browser, 'newContext');
    try {
      const error = await crawl(
        at('site.test'),
        {},
        { deadline: new Deadline(Date.now() - 1) },
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'page_timeout', retryable: true });
      expect(newContext).not.toHaveBeenCalled();
    } finally {
      newContext.mockRestore();
    }
  }, 30_000);

  it('fails with page_timeout when the budget runs out during navigation', async () => {
    const error = await crawl(
      at('site.test', '/busy'),
      { networkIdleTimeoutMs: 10_000 },
      { deadline: new Deadline(Date.now() + 1_500) },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'page_timeout', retryable: true });
  }, 30_000);

  it('maps analysis failures and skips the store', async () => {
    const analyzer = { analyze: () => Promise.reject(permanentFailure('analysis_failed')) };
    const { processor, complete } = setup({ analyzer });
    const deadline = new Deadline(Date.now() + 20_000);
    const message: CrawlMessage = {
      uid: '01JCXZ7Y7K3M5V8Q9R2T4W6Y8A',
      url: at('site.test'),
      requestedAt: new Date().toISOString(),
    };

    await expect(processor.process(message, deadline)).rejects.toMatchObject({
      code: 'analysis_failed',
    });
    expect(complete).not.toHaveBeenCalled();
    deadline.dispose();
  }, 30_000);

  it('reports a job finalized elsewhere as skipped', async () => {
    const store = { complete: () => Promise.resolve(false) };
    const { outcome } = await crawl(at('site.test'), { store });
    expect(outcome).toBe('skipped');
  }, 30_000);

  it('turns unexpected errors into transient failures', async () => {
    const store = { complete: () => Promise.reject(new Error('connection reset')) };
    const failure = await crawlFailure(at('site.test'), { store });
    expect(failure).toMatchObject({ code: 'crawl_failed', retryable: true });
  }, 30_000);
});
