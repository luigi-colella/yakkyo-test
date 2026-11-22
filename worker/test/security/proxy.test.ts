import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Deadline } from '../../src/pipeline/deadline.js';
import { PinnedHttpProxy } from '../../src/security/proxy.js';
import { SafeUrlGuard } from '../../src/security/security.js';

/** `fixture.test` does not exist in DNS: reaching it proves the proxy used the pinned address. */
const FIXTURE_HOST = 'fixture.test';
const loopback: LookupAddress[] = [{ address: '127.0.0.1', family: 4 }];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server | net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => {
    (server as Server).closeAllConnections?.();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

/** An upstream site echoing what it received. */
async function startUpstream(): Promise<{ port: number; received: IncomingHttpHeaders[] }> {
  const received: IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
    response.end(`hello from ${request.url}`);
  });
  return { port: await listen(server), received };
}

async function startProxy(
  resolve: (hostname: string) => Promise<LookupAddress[]>,
  { allowlisted = true, budgetMs = 10_000 } = {},
): Promise<{ proxy: PinnedHttpProxy; port: number }> {
  const guard = new SafeUrlGuard({
    allowedHosts: new Set(allowlisted ? [FIXTURE_HOST] : []),
    resolve,
  });
  const deadline = new Deadline(Date.now() + budgetMs);
  const proxy = new PinnedHttpProxy(guard, deadline);
  const url = new URL(await proxy.start());
  cleanups.push(async () => {
    await proxy.stop();
    deadline.dispose();
  });
  return { proxy, port: Number(url.port) };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Plain HTTP through the proxy: the request line carries the absolute URL. */
function getViaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxyPort, path: url, headers, agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** Sends `CONNECT authority` and resolves with the proxy's status and the tunnel socket. */
function connectViaProxy(
  proxyPort: number,
  authority: string,
): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      agent: false,
    });
    request.on('connect', (response, socket) => {
      cleanups.push(() => void socket.destroy());
      resolve({ status: response.statusCode ?? 0, socket });
    });
    request.on('error', reject);
    request.end();
  });
}

/** Speaks HTTP/1.0 over an established tunnel and returns the raw response. */
async function getThroughTunnel(socket: Socket, path: string): Promise<string> {
  socket.write(`GET ${path} HTTP/1.0\r\nHost: ${FIXTURE_HOST}\r\n\r\n`);
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (raw += chunk));
  await once(socket, 'end');
  return raw;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('PinnedHttpProxy', () => {
  describe('plain HTTP', () => {
    it('forwards the request to the pinned address and relays the response', async () => {
      const upstream = await startUpstream();
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback));

      const reply = await getViaProxy(port, `http://${FIXTURE_HOST}:${upstream.port}/page?q=1`);

      expect(reply).toMatchObject({ status: 200, body: 'hello from /page?q=1' });
      expect(reply.headers['x-upstream']).toBe('yes');
      expect(proxy.failure).toBeUndefined();
    });

    it('sends the original Host and drops proxy-only headers', async () => {
      const upstream = await startUpstream();
      const { port } = await startProxy(() => Promise.resolve(loopback));

      await getViaProxy(port, `http://${FIXTURE_HOST}:${upstream.port}/`, {
        'proxy-authorization': 'Basic c2VjcmV0',
        'proxy-connection': 'keep-alive',
        'x-custom': 'kept',
      });

      const [headers] = upstream.received;
      expect(headers?.host).toBe(`${FIXTURE_HOST}:${upstream.port}`);
      expect(headers?.['x-custom']).toBe('kept');
      expect(headers).not.toHaveProperty('proxy-authorization');
      expect(headers).not.toHaveProperty('proxy-connection');
    });

    it('refuses a non-public target with 403 and records unsafe_target', async () => {
      const upstream = await startUpstream();
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback), {
        allowlisted: false,
      });

      const reply = await getViaProxy(port, `http://internal.example:${upstream.port}/`);

      expect(reply.status).toBe(403);
      expect(upstream.received).toHaveLength(0);
      expect(proxy.failure).toMatchObject({ code: 'unsafe_target', retryable: false });
    });

    it('refuses a request line without an absolute URL', async () => {
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback));
      const reply = await getViaProxy(port, '/relative');
      expect(reply.status).toBe(403);
      expect(proxy.failure).toMatchObject({ code: 'unsafe_target' });
    });

    it('answers 502 and records navigation_failed when the site is unreachable', async () => {
      const port = await closedPort();
      const proxy = await startProxy(() => Promise.resolve(loopback));

      const reply = await getViaProxy(proxy.port, `http://${FIXTURE_HOST}:${port}/`);

      expect(reply.status).toBe(502);
      expect(proxy.proxy.failure).toMatchObject({ code: 'navigation_failed', retryable: true });
    });
  });

  describe('CONNECT tunnels', () => {
    it('opens a tunnel to the pinned address and relays bytes both ways', async () => {
      const upstream = await startUpstream();
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback));

      const { status, socket } = await connectViaProxy(port, `${FIXTURE_HOST}:${upstream.port}`);
      expect(status).toBe(200);
      const raw = await getThroughTunnel(socket, '/secure');

      expect(raw).toMatch(/^HTTP\/1\.1 200 OK/);
      expect(raw).toContain('hello from /secure');
      expect(proxy.failure).toBeUndefined();
    });

    it('refuses a non-public target with 403 and records unsafe_target', async () => {
      const upstream = await startUpstream();
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback), {
        allowlisted: false,
      });

      const { status } = await connectViaProxy(port, `metadata.example:${upstream.port}`);

      expect(status).toBe(403);
      expect(upstream.received).toHaveLength(0);
      expect(proxy.failure).toMatchObject({ code: 'unsafe_target', retryable: false });
    });

    it('validates the name again, so a rebinding after an earlier check is refused', async () => {
      const resolve = vi
        .fn<(hostname: string) => Promise<LookupAddress[]>>()
        .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
        .mockResolvedValue(loopback);
      const { proxy, port } = await startProxy(resolve, { allowlisted: false });
      // The page-level check passed while the name still pointed to a public address...
      const guard = new SafeUrlGuard({ resolve });
      const deadline = new Deadline(Date.now() + 5_000);
      await guard.resolveTarget('https://rebind.example/', deadline);
      deadline.dispose();

      // ...then the name moved to loopback before Chromium connected.
      const { status } = await connectViaProxy(port, 'rebind.example:443');

      expect(status).toBe(403);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(proxy.failure).toMatchObject({ code: 'unsafe_target' });
    });

    it('answers 502 and records a transient dns_failed when resolution fails', async () => {
      const failure = Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' });
      const { proxy, port } = await startProxy(() => Promise.reject(failure));

      const { status } = await connectViaProxy(port, `${FIXTURE_HOST}:443`);

      expect(status).toBe(502);
      expect(proxy.failure).toMatchObject({ code: 'dns_failed', retryable: true });
    });

    it('answers 502 and records navigation_failed when the site is unreachable', async () => {
      const port = await closedPort();
      const proxy = await startProxy(() => Promise.resolve(loopback));

      const { status } = await connectViaProxy(proxy.port, `${FIXTURE_HOST}:${port}`);

      expect(status).toBe(502);
      expect(proxy.proxy.failure).toMatchObject({ code: 'navigation_failed', retryable: true });
    });

    it('answers 502 with page_timeout once the job budget is spent', async () => {
      const upstream = await startUpstream();
      const { proxy, port } = await startProxy(() => Promise.resolve(loopback), { budgetMs: 0 });

      const { status } = await connectViaProxy(port, `${FIXTURE_HOST}:${upstream.port}`);

      expect(status).toBe(502);
      expect(upstream.received).toHaveLength(0);
      expect(proxy.failure).toMatchObject({ code: 'page_timeout', retryable: true });
    });
  });

  it('keeps a permanent failure over transient ones recorded before or after', async () => {
    const port = await closedPort();
    const resolve = (hostname: string) =>
      Promise.resolve(
        hostname === 'internal.example' ? [{ address: '10.0.0.1', family: 4 }] : loopback,
      );
    const proxy = await startProxy(resolve);

    await getViaProxy(proxy.port, `http://${FIXTURE_HOST}:${port}/`);
    expect(proxy.proxy.failure).toMatchObject({ code: 'navigation_failed' });
    await getViaProxy(proxy.port, 'http://internal.example/');
    expect(proxy.proxy.failure).toMatchObject({ code: 'unsafe_target' });
    await getViaProxy(proxy.port, `http://${FIXTURE_HOST}:${port}/`);
    expect(proxy.proxy.failure).toMatchObject({ code: 'unsafe_target' });
  });

  it('closes open tunnels on stop', async () => {
    const idle = net.createServer(() => undefined);
    const upstreamPort = await listen(idle);
    const guard = new SafeUrlGuard({
      allowedHosts: new Set([FIXTURE_HOST]),
      resolve: () => Promise.resolve(loopback),
    });
    const deadline = new Deadline(Date.now() + 10_000);
    const proxy = new PinnedHttpProxy(guard, deadline);
    const port = Number(new URL(await proxy.start()).port);

    const { status, socket } = await connectViaProxy(port, `${FIXTURE_HOST}:${upstreamPort}`);
    expect(status).toBe(200);
    const closed = once(socket, 'close');
    await proxy.stop();
    deadline.dispose();
    await closed;

    expect(socket.destroyed).toBe(true);
    await expect(proxy.stop()).resolves.toBeUndefined();
  });
});
