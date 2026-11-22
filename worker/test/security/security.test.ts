import type { LookupAddress } from 'node:dns';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Deadline } from '../../src/pipeline/deadline.js';
import { DNS_TIMEOUT_MS, SafeUrlGuard, isBlockedAddress } from '../../src/security/security.js';
import type { AddressResolver } from '../../src/security/security.js';

const unsafe = { code: 'unsafe_target', retryable: false };

function resolvesTo(...addresses: LookupAddress[]) {
  return vi.fn<AddressResolver>(() => Promise.resolve(addresses));
}

describe('isBlockedAddress', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['240.0.0.1', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::127.0.0.1', 'IPv4-compatible (deprecated)'],
    ['64:ff9b::7f00:1', 'NAT64'],
    ['2002:7f00:1::', '6to4'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['not-an-ip', 'invalid'],
    ['', 'empty'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.215.14',
    '172.32.0.1',
    '::ffff:8.8.8.8',
    '2606:4700::1111',
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('SafeUrlGuard.resolveTarget', () => {
  const deadlines: Deadline[] = [];
  const deadline = (ms = 30_000) => {
    const created = new Deadline(Date.now() + ms);
    deadlines.push(created);
    return created;
  };

  afterEach(() => {
    deadlines.splice(0).forEach((created) => created.dispose());
    vi.useRealTimers();
  });

  it('returns the resolved public address with host name and default ports', async () => {
    const resolve = resolvesTo({ address: '93.184.215.14', family: 4 });
    const guard = new SafeUrlGuard({ resolve });

    await expect(
      guard.resolveTarget('https://example.com/a?b=1', deadline()),
    ).resolves.toMatchObject({
      hostname: 'example.com',
      address: '93.184.215.14',
      family: 4,
      port: 443,
    });
    await expect(guard.resolveTarget('http://example.com/', deadline())).resolves.toMatchObject({
      port: 80,
    });
    await expect(
      guard.resolveTarget('http://example.com:8080/', deadline()),
    ).resolves.toMatchObject({ port: 8080 });
    expect(resolve).toHaveBeenCalledWith('example.com');
  });

  it('keeps the parsed URL for the caller', async () => {
    const guard = new SafeUrlGuard({ resolve: resolvesTo({ address: '8.8.8.8', family: 4 }) });
    const target = await guard.resolveTarget('https://example.com/path?q=1', deadline());
    expect(target.url.href).toBe('https://example.com/path?q=1');
  });

  it('rejects a host when any of its addresses is not public', async () => {
    const guard = new SafeUrlGuard({
      resolve: resolvesTo({ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }),
    });
    await expect(guard.resolveTarget('https://mixed.example/', deadline())).rejects.toMatchObject(
      unsafe,
    );
  });

  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
  ])('rejects the IP literal %s without resolving it', async (url) => {
    const resolve = resolvesTo({ address: '8.8.8.8', family: 4 });
    const guard = new SafeUrlGuard({ resolve });
    await expect(guard.resolveTarget(url, deadline())).rejects.toMatchObject(unsafe);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal, without brackets in the result', async () => {
    const guard = new SafeUrlGuard();
    await expect(
      guard.resolveTarget('https://[2606:4700::1111]/', deadline()),
    ).resolves.toMatchObject({
      hostname: '2606:4700::1111',
      address: '2606:4700::1111',
      family: 6,
    });
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'data:text/html,hi', 'not a url'])(
    'rejects %s, which is not an http(s) URL',
    async (url) => {
      const guard = new SafeUrlGuard({ resolve: resolvesTo({ address: '8.8.8.8', family: 4 }) });
      await expect(guard.resolveTarget(url, deadline())).rejects.toMatchObject(unsafe);
    },
  );

  it('rejects localhost through its resolved loopback address', async () => {
    const guard = new SafeUrlGuard({ resolve: resolvesTo({ address: '127.0.0.1', family: 4 }) });
    await expect(guard.resolveTarget('http://localhost:27017/', deadline())).rejects.toMatchObject(
      unsafe,
    );
  });

  it('resolves again on every call, so a later rebinding is caught', async () => {
    const resolve = vi
      .fn<AddressResolver>()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const guard = new SafeUrlGuard({ resolve });

    await expect(guard.resolveTarget('https://rebind.example/', deadline())).resolves.toMatchObject(
      {
        address: '8.8.8.8',
      },
    );
    await expect(guard.resolveTarget('https://rebind.example/', deadline())).rejects.toMatchObject(
      unsafe,
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  describe('allowlist (end-to-end fixtures)', () => {
    it('lets an allowlisted host resolve to a private address', async () => {
      const guard = new SafeUrlGuard({
        allowedHosts: new Set(['fixture']),
        resolve: resolvesTo({ address: '172.18.0.4', family: 4 }),
      });
      await expect(guard.resolveTarget('http://fixture/page', deadline())).resolves.toMatchObject({
        address: '172.18.0.4',
      });
    });

    it('does not extend to other hosts or subdomains', async () => {
      const guard = new SafeUrlGuard({
        allowedHosts: new Set(['fixture']),
        resolve: resolvesTo({ address: '172.18.0.4', family: 4 }),
      });
      await expect(guard.resolveTarget('http://mongo/', deadline())).rejects.toMatchObject(unsafe);
      await expect(guard.resolveTarget('http://a.fixture/', deadline())).rejects.toMatchObject(
        unsafe,
      );
    });
  });

  describe('DNS failures', () => {
    it('treats a name that does not exist as permanent', async () => {
      const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      const guard = new SafeUrlGuard({ resolve: () => Promise.reject(notFound) });
      await expect(guard.resolveTarget('https://nope.example/', deadline())).rejects.toMatchObject({
        code: 'dns_failed',
        retryable: false,
        cause: notFound,
      });
    });

    it('treats other resolver errors as transient', async () => {
      const again = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
      const guard = new SafeUrlGuard({ resolve: () => Promise.reject(again) });
      await expect(guard.resolveTarget('https://slow.example/', deadline())).rejects.toMatchObject({
        code: 'dns_failed',
        retryable: true,
      });
    });

    it('fails an empty answer', async () => {
      const guard = new SafeUrlGuard({ resolve: resolvesTo() });
      await expect(guard.resolveTarget('https://empty.example/', deadline())).rejects.toMatchObject(
        {
          code: 'dns_failed',
        },
      );
    });

    it('gives up after 3 s with a transient dns_failed', async () => {
      vi.useFakeTimers();
      const guard = new SafeUrlGuard({ resolve: () => new Promise(() => undefined) });
      const outcome = expect(
        guard.resolveTarget('https://hang.example/', deadline()),
      ).rejects.toMatchObject({ code: 'dns_failed', retryable: true });
      await vi.advanceTimersByTimeAsync(DNS_TIMEOUT_MS);
      await outcome;
    });

    it('stops at the job deadline when it comes first', async () => {
      vi.useFakeTimers();
      const guard = new SafeUrlGuard({ resolve: () => new Promise(() => undefined) });
      const outcome = expect(
        guard.resolveTarget('https://hang.example/', deadline(1_000)),
      ).rejects.toMatchObject({ code: 'page_timeout', retryable: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
    });
  });
});
