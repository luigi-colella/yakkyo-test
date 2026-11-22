import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';

import ipaddr from 'ipaddr.js';

import type { Deadline } from '../pipeline/deadline.js';
import { permanentFailure, transientFailure } from '../pipeline/errors.js';

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

/** A validated destination: connect to `address`, but keep `hostname` for TLS and `Host`. */
export interface ResolvedTarget {
  url: URL;
  /** Lowercase host name or IP literal, without IPv6 brackets. */
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

export interface SafeUrlGuardOptions {
  /** Hosts allowed to resolve to non-public addresses (end-to-end fixtures only). */
  allowedHosts?: ReadonlySet<string>;
  resolve?: AddressResolver;
}

export const DNS_TIMEOUT_MS = 3_000;

const systemResolver: AddressResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Validates the destination of every connection the worker makes on behalf of a user
 * (SSRF protection). Each call resolves the name again: callers must connect to the
 * returned address instead of resolving it a second time.
 */
export class SafeUrlGuard {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly resolve: AddressResolver;

  constructor({ allowedHosts = new Set(), resolve = systemResolver }: SafeUrlGuardOptions = {}) {
    this.allowedHosts = allowedHosts;
    this.resolve = resolve;
  }

  /**
   * Resolves an http(s) URL to one address, rejecting it with `unsafe_target` if any of its
   * addresses is not public unicast (loopback, private, link-local, metadata endpoints…).
   */
  async resolveTarget(rawUrl: string, deadline: Deadline): Promise<ResolvedTarget> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error: unknown) {
      throw permanentFailure('unsafe_target', error);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw permanentFailure('unsafe_target');
    }

    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const addresses = ipaddr.isValid(hostname)
      ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }]
      : await deadline.run(this.lookup(hostname));

    const allowlisted = this.allowedHosts.has(hostname);
    if (!allowlisted && addresses.some(({ address }) => isBlockedAddress(address))) {
      throw permanentFailure('unsafe_target');
    }

    const [first] = addresses;
    if (!first || (first.family !== 4 && first.family !== 6)) {
      throw permanentFailure('dns_failed');
    }
    return {
      url,
      hostname,
      address: first.address,
      family: first.family,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
  }

  private async lookup(hostname: string): Promise<LookupAddress[]> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(transientFailure('dns_failed')), DNS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.resolve(hostname), timeout]);
    } catch (error: unknown) {
      // A name that does not exist will not exist on retry either.
      const notFound = (error as NodeJS.ErrnoException).code === 'ENOTFOUND';
      throw notFound
        ? permanentFailure('dns_failed', error)
        : transientFailure('dns_failed', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

const GLOBAL_UNICAST_V6 = ipaddr.parseCIDR('2000::/3');

/**
 * True unless `address` is a public unicast IP. IPv4-mapped IPv6 addresses are checked as
 * IPv4; IPv6 must also fall in the global unicast block (which excludes e.g. `::127.0.0.1`).
 * Invalid input is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') return true;
  return parsed.kind() === 'ipv6' && !parsed.match(GLOBAL_UNICAST_V6);
}
