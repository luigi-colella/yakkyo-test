import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Deadline } from '../../src/pipeline/deadline.js';
import {
  ROBOTS_MAX_BYTES,
  ROBOTS_USER_AGENT,
  assertRobotsAllowed,
  isRootDisallowed,
} from '../../src/security/robots.js';
import { SafeUrlGuard } from '../../src/security/security.js';

describe('isRootDisallowed', () => {
  it('detects a root-wide ban for every user agent', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /')).toBe(true);
  });

  it('treats "/*" like "/"', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /*')).toBe(true);
  });

  it('allows an empty or missing rule set', () => {
    expect(isRootDisallowed('')).toBe(false);
    expect(isRootDisallowed('User-agent: *\nDisallow:')).toBe(false);
    expect(isRootDisallowed('Sitemap: https://example.com/sitemap.xml')).toBe(false);
  });

  it('ignores partial paths', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /private\nDisallow: /admin/')).toBe(false);
  });

  it('ignores bans aimed at other user agents', () => {
    expect(
      isRootDisallowed('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp'),
    ).toBe(false);
  });

  it('applies rules to every user agent of the same group', () => {
    expect(isRootDisallowed('User-agent: BadBot\nUser-agent: *\nDisallow: /')).toBe(true);
  });

  it('does not carry "*" into the next group', () => {
    expect(
      isRootDisallowed('User-agent: *\nAllow: /public\n\nUser-agent: BadBot\nDisallow: /'),
    ).toBe(false);
  });

  it('keeps a group together across blank lines and unknown fields', () => {
    expect(isRootDisallowed('User-agent: *\n\nCrawl-delay: 5\n\nDisallow: /')).toBe(true);
  });

  it('lets "Allow: /" win a tie with "Disallow: /", as in RFC 9309', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /\nAllow: /')).toBe(false);
  });

  it('merges several "*" groups', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /')).toBe(
      true,
    );
  });

  it('is case-insensitive on field names and agents, and ignores comments and spacing', () => {
    expect(isRootDisallowed('# robots\nUSER-AGENT : * # everyone\n  DISALLOW:   /   # all')).toBe(
      true,
    );
  });

  it('handles CRLF and CR line endings and a byte order mark', () => {
    expect(isRootDisallowed('﻿User-agent: *\r\nDisallow: /\r\n')).toBe(true);
    expect(isRootDisallowed('User-agent: *\rDisallow: /\r')).toBe(true);
  });

  it('does not treat path values case-insensitively or with a prefix as root', () => {
    expect(isRootDisallowed('User-agent: *\nDisallow: /index.html')).toBe(false);
  });
});

describe('assertRobotsAllowed', () => {
  /** `fixture.test` does not exist in DNS: reaching it proves the pinned address was used. */
  const HOST = 'fixture.test';
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  type Handler = (request: IncomingMessage, response: ServerResponse) => void;

  async function startSite(handler: Handler): Promise<{ origin: string; requests: string[] }> {
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      handler(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    return { origin: `http://${HOST}:${port}`, requests };
  }

  function options({
    resolve = (): Promise<LookupAddress[]> =>
      Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    allowedHosts = new Set([HOST]),
    budgetMs = 10_000,
    timeoutMs = 1_000,
  } = {}) {
    const deadline = new Deadline(Date.now() + budgetMs);
    cleanups.push(() => deadline.dispose());
    return { guard: new SafeUrlGuard({ allowedHosts, resolve }), deadline, timeoutMs };
  }

  const robots =
    (body: string, status = 200): Handler =>
    (_request, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' }).end(body);
    };

  it('allows the crawl when robots.txt permits the root', async () => {
    const site = await startSite(robots('User-agent: *\nDisallow: /private'));
    await expect(
      assertRobotsAllowed(`${site.origin}/some/page?x=1`, options()),
    ).resolves.toBeUndefined();
    expect(site.requests).toEqual(['/robots.txt']);
  });

  it('throws a permanent robots_disallowed when the root is forbidden to everyone', async () => {
    const site = await startSite(robots('User-agent: *\nDisallow: /'));
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).rejects.toMatchObject({
      code: 'robots_disallowed',
      retryable: false,
    });
  });

  it('sends the original Host and the crawler user agent', async () => {
    let headers: IncomingHttpHeaders = {};
    const site = await startSite((request, response) => {
      headers = request.headers;
      response.end('');
    });
    await assertRobotsAllowed(`${site.origin}/`, options());
    expect(headers.host).toBe(new URL(site.origin).host);
    expect(headers['user-agent']).toBe(ROBOTS_USER_AGENT);
  });

  it.each([401, 403, 404, 410])('allows the crawl when robots.txt answers %i', async (status) => {
    const site = await startSite(robots('User-agent: *\nDisallow: /', status));
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).resolves.toBeUndefined();
  });

  it.each([500, 503])('throws a transient robots_unavailable on %i', async (status) => {
    const site = await startSite(robots('', status));
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).rejects.toMatchObject({
      code: 'robots_unavailable',
      retryable: true,
    });
  });

  it('follows redirects, validating each hop, and applies the final file', async () => {
    const site = await startSite((request, response) => {
      if (request.url === '/robots.txt') {
        response.writeHead(301, { location: '/moved/robots.txt' }).end();
      } else if (request.url === '/moved/robots.txt') {
        response
          .writeHead(302, { location: `http://${HOST}:${request.socket.localPort}/final.txt` })
          .end();
      } else {
        response.end('User-agent: *\nDisallow: /');
      }
    });
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
    expect(site.requests).toEqual(['/robots.txt', '/moved/robots.txt', '/final.txt']);
  });

  it('refuses a redirect to a non-public address with unsafe_target', async () => {
    const site = await startSite((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).rejects.toMatchObject({
      code: 'unsafe_target',
      retryable: false,
    });
  });

  it('allows the crawl after more than 5 redirects, as for a missing file', async () => {
    let hops = 0;
    const site = await startSite((_request, response) => {
      hops += 1;
      response.writeHead(302, { location: `/hop-${hops}` }).end();
    });
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).resolves.toBeUndefined();
    expect(site.requests).toHaveLength(6);
  });

  it('allows the crawl on a redirect without a Location', async () => {
    const site = await startSite(robots('', 302));
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).resolves.toBeUndefined();
  });

  it('reads at most 512 KiB, ignoring what follows', async () => {
    const filler = `# ${'x'.repeat(1_000)}\n`.repeat(Math.ceil(ROBOTS_MAX_BYTES / 1_003));
    const beyondLimit = await startSite(robots(`${filler}User-agent: *\nDisallow: /`));
    await expect(assertRobotsAllowed(`${beyondLimit.origin}/`, options())).resolves.toBeUndefined();

    const withinLimit = await startSite(robots(`User-agent: *\nDisallow: /\n${filler}`));
    await expect(assertRobotsAllowed(`${withinLimit.origin}/`, options())).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
  });

  it('throws a transient robots_unavailable when the server does not answer in time', async () => {
    const site = await startSite(() => undefined);
    await expect(
      assertRobotsAllowed(`${site.origin}/`, options({ timeoutMs: 100 })),
    ).rejects.toMatchObject({ code: 'robots_unavailable', retryable: true });
  });

  it('throws a transient robots_unavailable when the body stalls', async () => {
    const site = await startSite((_request, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('User-agent: *\n');
    });
    await expect(
      assertRobotsAllowed(`${site.origin}/`, options({ timeoutMs: 100 })),
    ).rejects.toMatchObject({ code: 'robots_unavailable', retryable: true });
  });

  it('throws a transient robots_unavailable when the connection is refused', async () => {
    const site = await startSite(robots(''));
    await cleanups.pop()?.();
    await expect(assertRobotsAllowed(`${site.origin}/`, options())).rejects.toMatchObject({
      code: 'robots_unavailable',
      retryable: true,
    });
  });

  it('stops with page_timeout when the job deadline comes first', async () => {
    const site = await startSite(() => undefined);
    await expect(
      assertRobotsAllowed(`${site.origin}/`, options({ budgetMs: 100, timeoutMs: 5_000 })),
    ).rejects.toMatchObject({ code: 'page_timeout', retryable: true });
  });

  it('refuses a page whose host is not public before any request', async () => {
    const site = await startSite(robots(''));
    await expect(
      assertRobotsAllowed(`${site.origin}/`, options({ allowedHosts: new Set() })),
    ).rejects.toMatchObject({ code: 'unsafe_target' });
    expect(site.requests).toHaveLength(0);
  });

  it('keeps TLS errors as a permanent tls_error', async () => {
    const request = vi.spyOn(http, 'request').mockImplementation(() => {
      throw Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    });
    cleanups.push(() => request.mockRestore());
    await expect(assertRobotsAllowed(`http://${HOST}/`, options())).rejects.toMatchObject({
      code: 'tls_error',
      retryable: false,
    });
  });
});
