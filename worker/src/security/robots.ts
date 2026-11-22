import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { Deadline } from '../pipeline/deadline.js';
import {
  CrawlFailure,
  permanentFailure,
  toCrawlFailure,
  transientFailure,
} from '../pipeline/errors.js';
import type { ResolvedTarget, SafeUrlGuard } from './security.js';

export const ROBOTS_USER_AGENT = 'MiniCrawler/1.0';
export const ROBOTS_TIMEOUT_MS = 3_000;
/** RFC 9309 asks crawlers to parse at least 500 KiB; anything beyond is ignored. */
export const ROBOTS_MAX_BYTES = 512 * 1_024;
export const ROBOTS_MAX_REDIRECTS = 5;

/** Rule values that match every path, so they decide whether `/` may be crawled. */
const ROOT_RULES = new Set(['/', '/*']);

/**
 * Minimal robots.txt parser: true when the rules for `User-agent: *` disallow the root
 * (`Disallow: /`) and do not allow it back (`Allow: /`, which wins a tie in RFC 9309).
 * Consecutive `User-agent` lines share the rules that follow them; other fields are ignored.
 */
export function isRootDisallowed(robotsTxt: string): boolean {
  let agents: string[] = [];
  let groupHasRules = false;
  let disallowed = false;
  let allowed = false;

  for (const rawLine of robotsTxt.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // A user-agent line after rules starts a new group.
      if (groupHasRules) agents = [];
      groupHasRules = false;
      agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      groupHasRules = true;
      if (!agents.includes('*') || !ROOT_RULES.has(value)) continue;
      if (field === 'disallow') disallowed = true;
      else allowed = true;
    }
  }
  return disallowed && !allowed;
}

export interface RobotsCheckOptions {
  guard: SafeUrlGuard;
  deadline: Deadline;
  /** Limit of each robots.txt request (default 3 s), further limited by the deadline. */
  timeoutMs?: number;
}

/**
 * Fetches `/robots.txt` of the page's origin and throws a permanent `robots_disallowed` if it
 * forbids the root to every user agent. Following RFC 9309, a missing file (4xx) or too many
 * redirects allow the crawl, while a server error, a timeout or a network error throws a
 * transient `robots_unavailable` (the crawl must not go ahead without knowing). Each request
 * and redirect goes through the SSRF guard and connects to the address it validated.
 */
export async function assertRobotsAllowed(
  pageUrl: string,
  { guard, deadline, timeoutMs = ROBOTS_TIMEOUT_MS }: RobotsCheckOptions,
): Promise<void> {
  let robotsUrl = new URL('/robots.txt', pageUrl).href;

  for (let redirects = 0; redirects <= ROBOTS_MAX_REDIRECTS; redirects++) {
    let response: RobotsResponse;
    try {
      const target = await guard.resolveTarget(robotsUrl, deadline);
      response = await deadline.run(fetchRobots(target, deadline.cap(timeoutMs)));
    } catch (error: unknown) {
      throw robotsFailure(error, deadline);
    }

    const { status, location, body } = response;
    if (status >= 300 && status < 400) {
      if (!location) return;
      robotsUrl = new URL(location, robotsUrl).href;
      continue;
    }
    if (status >= 500) throw transientFailure('robots_unavailable');
    if (status >= 200 && status < 300 && isRootDisallowed(body)) {
      throw permanentFailure('robots_disallowed');
    }
    return;
  }
  // Too many redirects: treated as a missing file (RFC 9309).
}

function robotsFailure(error: unknown, deadline: Deadline): CrawlFailure {
  if (error instanceof CrawlFailure) return error;
  // The request timeout is capped by the deadline: a timeout at that point is the job's.
  if (!deadline.fits(0)) return transientFailure('page_timeout', error);
  const failure = toCrawlFailure(error);
  // TLS errors stay permanent `tls_error`: the page itself would fail the same way.
  return failure.retryable ? transientFailure('robots_unavailable', error) : failure;
}

interface RobotsResponse {
  status: number;
  location: string | undefined;
  /** Only read for 2xx answers, truncated to `ROBOTS_MAX_BYTES`. */
  body: string;
}

function fetchRobots(target: ResolvedTarget, timeoutMs: number): Promise<RobotsResponse> {
  const send = target.url.protocol === 'https:' ? https.request : http.request;

  return new Promise<RobotsResponse>((resolve, reject) => {
    const request = send(
      {
        // The host name drives TLS (SNI and certificate check); `lookup` pins the address.
        host: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        lookup: pinnedLookup(target),
        headers: { host: target.url.host, 'user-agent': ROBOTS_USER_AGENT },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status < 200 || status >= 300) {
          res.destroy();
          resolve({ status, location, body: '' });
          return;
        }
        readCapped(res).then((body) => resolve({ status, location, body }), reject);
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error('robots.txt request timed out')),
      timeoutMs,
    );
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

/** Reads the body up to `ROBOTS_MAX_BYTES`, then stops downloading. */
function readCapped(res: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= ROBOTS_MAX_BYTES) {
        truncated = true;
        res.destroy();
      }
    });
    res.on('error', reject);
    res.on('close', () => {
      if (!res.complete && !truncated) {
        reject(new Error('robots.txt response was interrupted'));
        return;
      }
      resolve(Buffer.concat(chunks).subarray(0, ROBOTS_MAX_BYTES).toString('utf8'));
    });
  });
}

function pinnedLookup({ address, family }: ResolvedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
