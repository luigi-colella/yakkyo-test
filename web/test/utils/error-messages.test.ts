import { describe, expect, it } from 'vitest';

import { describeError } from '../../src/utils/error-messages.js';

const FALLBACK = 'Qualcosa è andato storto. Riprova.';

describe('describeError', () => {
  it.each([
    // Worker failure codes.
    'robots_disallowed',
    'robots_unavailable',
    'auth_required',
    'tls_error',
    'unsafe_target',
    'dns_failed',
    'navigation_failed',
    'page_timeout',
    'analysis_failed',
    'crawl_failed',
    // API codes.
    'stale_job',
    'queue_unavailable',
    'storage_unavailable',
    'internal_error',
    'rate_limited',
    'invalid_url',
    'unsupported_scheme',
    'not_found',
    // Frontend codes.
    'poll_timeout',
    'network_error',
    'invalid_response',
  ])('has a specific message for %s', (code) => {
    const message = describeError(code);
    expect(message).not.toBe(FALLBACK);
    expect(message).not.toContain(code);
  });

  it('gives distinct messages to distinct codes', () => {
    expect(describeError('robots_disallowed')).toContain('robots.txt');
    expect(describeError('auth_required')).toContain('autenticazione');
    expect(describeError('tls_error')).toContain('TLS');
    expect(describeError('robots_disallowed')).not.toBe(describeError('robots_unavailable'));
  });

  it('reports the HTTP status of the crawled page', () => {
    expect(describeError('http_404')).toBe('La pagina ha risposto con un errore HTTP 404.');
    expect(describeError('http_503')).toContain('503');
  });

  it.each(['', 'request_failed', 'something_new', 'http_', 'http_12', 'http_4040', 'toString'])(
    'falls back to a generic message for %j',
    (code) => {
      expect(describeError(code)).toBe(FALLBACK);
    },
  );
});
