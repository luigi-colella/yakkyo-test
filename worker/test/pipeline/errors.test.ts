import { describe, expect, it } from 'vitest';

import {
  CrawlFailure,
  mostRelevantFailure,
  permanentFailure,
  toCrawlFailure,
  transientFailure,
} from '../../src/pipeline/errors.js';

function errorWithCode(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('failure factories', () => {
  it('build permanent and transient failures carrying the code and the cause', () => {
    const cause = new Error('root cause');
    const permanent = permanentFailure('auth_required', cause);
    const transient = transientFailure('http_503');

    expect(permanent).toBeInstanceOf(CrawlFailure);
    expect(permanent).toMatchObject({ code: 'auth_required', retryable: false, cause });
    expect(permanent.message).toBe('auth_required');
    expect(transient).toMatchObject({ code: 'http_503', retryable: true, cause: undefined });
  });
});

describe('toCrawlFailure', () => {
  it('returns a CrawlFailure unchanged', () => {
    const failure = permanentFailure('unsafe_target');
    expect(toCrawlFailure(failure)).toBe(failure);
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ])('maps the Node TLS error %s to a permanent tls_error', (code) => {
    expect(toCrawlFailure(errorWithCode(code))).toMatchObject({
      code: 'tls_error',
      retryable: false,
    });
  });

  it.each([
    'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://self-signed.badssl.com/',
    'page.goto: net::ERR_CERT_DATE_INVALID at https://expired.badssl.com/',
    'page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://example.com/',
    'page.goto: net::ERR_BAD_SSL_CLIENT_AUTH_CERT at https://example.com/',
  ])('maps the Chromium TLS error "%s" to a permanent tls_error', (message) => {
    expect(toCrawlFailure(new Error(message))).toMatchObject({
      code: 'tls_error',
      retryable: false,
    });
  });

  it('maps a timeout (Playwright TimeoutError) to a transient page_timeout', () => {
    const timeout = new Error('page.goto: Timeout 10000ms exceeded.');
    timeout.name = 'TimeoutError';
    expect(toCrawlFailure(timeout)).toMatchObject({ code: 'page_timeout', retryable: true });
  });

  it('maps anything else to a transient crawl_failed keeping the cause', () => {
    const refused = errorWithCode('ECONNREFUSED', 'connect ECONNREFUSED');
    expect(toCrawlFailure(refused)).toMatchObject({
      code: 'crawl_failed',
      retryable: true,
      cause: refused,
    });
    expect(toCrawlFailure(new Error('net::ERR_CONNECTION_RESET'))).toMatchObject({
      code: 'crawl_failed',
    });
    expect(toCrawlFailure('not an error')).toMatchObject({ code: 'crawl_failed' });
    expect(toCrawlFailure(undefined)).toMatchObject({ code: 'crawl_failed' });
  });

  it('does not mistake a "timeout" word in the message for a timeout', () => {
    expect(toCrawlFailure(new Error('upstream timeout'))).toMatchObject({ code: 'crawl_failed' });
  });
});

describe('mostRelevantFailure', () => {
  const transientA = transientFailure('navigation_failed');
  const transientB = transientFailure('dns_failed');
  const permanentA = permanentFailure('unsafe_target');
  const permanentB = permanentFailure('tls_error');

  it('takes the candidate when nothing was recorded yet', () => {
    expect(mostRelevantFailure(undefined, transientA)).toBe(transientA);
  });

  it('keeps the first failure of the same kind', () => {
    expect(mostRelevantFailure(transientA, transientB)).toBe(transientA);
    expect(mostRelevantFailure(permanentA, permanentB)).toBe(permanentA);
  });

  it('lets a permanent failure replace a transient one, never the opposite', () => {
    expect(mostRelevantFailure(transientA, permanentA)).toBe(permanentA);
    expect(mostRelevantFailure(permanentA, transientA)).toBe(permanentA);
  });
});
