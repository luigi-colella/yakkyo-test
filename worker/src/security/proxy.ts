import { once } from 'node:events';
import http, { STATUS_CODES } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { Deadline } from '../pipeline/deadline.js';
import { mostRelevantFailure, toCrawlFailure, transientFailure } from '../pipeline/errors.js';
import type { CrawlFailure } from '../pipeline/errors.js';
import type { ResolvedTarget, SafeUrlGuard } from './security.js';

/** Idle timeout of an upstream connection, further limited by the job's deadline. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** Headers that only concern the client ↔ proxy hop. */
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection'];

/**
 * A per-job forward proxy on loopback through which Chromium reaches the internet.
 * Every connection (HTTPS tunnels via `CONNECT`, plain HTTP requests) is validated by the
 * guard and opened to the address it resolved, so a DNS answer cannot change between
 * validation and connection (DNS rebinding). TLS stays end to end between Chromium and the
 * site, so certificates are still verified against the original host name.
 */
export class PinnedHttpProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private recordedFailure: CrawlFailure | undefined;

  constructor(
    private readonly guard: SafeUrlGuard,
    private readonly deadline: Deadline,
  ) {
    this.server = http.createServer((request, response) => {
      void this.forwardRequest(request, response);
    });
    this.server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
      void this.openTunnel(request, client, head);
    });
    this.server.on('connection', (socket: Duplex) => this.track(socket));
    this.server.on('clientError', (_error, socket: Duplex) => socket.destroy());
  }

  /**
   * The most relevant failure met so far (a refused target or an unreachable host). Chromium
   * only reports a generic proxy error, so the caller uses this to explain a failed crawl.
   */
  get failure(): CrawlFailure | undefined {
    return this.recordedFailure;
  }

  /** Listens on a random loopback port and returns the proxy URL. */
  async start(): Promise<string> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Closes the server and every open connection. */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Plain HTTP: the request line carries an absolute URL. */
  private async forwardRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: ResolvedTarget;
    let timeoutMs: number;
    try {
      target = await this.guard.resolveTarget(request.url ?? '', this.deadline);
      timeoutMs = this.deadline.cap(UPSTREAM_TIMEOUT_MS);
    } catch (error: unknown) {
      response.writeHead(this.refuse(error)).end();
      return;
    }

    const upstream = http.request({
      host: target.address,
      family: target.family,
      port: target.port,
      method: request.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: forwardedHeaders(request.headers, target.url.host),
      agent: false,
      timeout: timeoutMs,
    });
    let abandoned = false;
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream connection timed out')));
    upstream.on('error', (error) => {
      // Chromium cancelling a request is not a failure of the site.
      if (abandoned) return;
      this.record(transientFailure('navigation_failed', error));
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    upstream.on('response', (upstreamResponse) => {
      upstreamResponse.on('error', () => response.destroy());
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    response.on('close', () => {
      abandoned = !response.writableFinished;
      upstream.destroy();
    });
    request.pipe(upstream);
  }

  /** HTTPS (and WebSockets): `CONNECT host:port`, then bytes are relayed untouched. */
  private async openTunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    let target: ResolvedTarget;
    let timeoutMs: number;
    try {
      target = await this.guard.resolveTarget(`https://${request.url ?? ''}/`, this.deadline);
      timeoutMs = this.deadline.cap(UPSTREAM_TIMEOUT_MS);
    } catch (error: unknown) {
      endTunnel(client, this.refuse(error));
      return;
    }

    let connected = false;
    const upstream = net.connect({
      host: target.address,
      family: target.family,
      port: target.port,
      timeout: timeoutMs,
    });
    this.track(upstream);
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream connection timed out')));
    upstream.once('connect', () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', (error) => {
      this.record(transientFailure('navigation_failed', error));
      if (connected) client.destroy();
      else endTunnel(client, 502);
    });
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  }

  /** Records why a target was refused and picks the status Chromium will see. */
  private refuse(error: unknown): 403 | 502 {
    const failure = toCrawlFailure(error);
    this.record(failure);
    return failure.retryable ? 502 : 403;
  }

  private record(failure: CrawlFailure): void {
    this.recordedFailure = mostRelevantFailure(this.recordedFailure, failure);
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { ...headers, host };
  for (const name of HOP_BY_HOP_HEADERS) delete forwarded[name];
  return forwarded;
}

function endTunnel(client: Duplex, status: 403 | 502): void {
  if (client.destroyed) return;
  client.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
}
