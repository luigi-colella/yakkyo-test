export type UrlErrorCode = 'invalid_url' | 'unsupported_scheme';

export class UrlValidationError extends Error {
  constructor(public readonly code: UrlErrorCode) {
    super(code);
    this.name = 'UrlValidationError';
  }
}

/**
 * Validates a user-supplied URL and returns its canonical form, used as the
 * idempotency/cache key. The WHATWG parser already converts the host to
 * punycode, lowercases it, drops default ports and resolves dot segments;
 * the fragment is removed because it never reaches the server.
 *
 * URLs with credentials are rejected: they would be stored, logged and sent
 * to the target, and would bypass the `auth_required` check.
 */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlValidationError('invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError('unsupported_scheme');
  }
  if (!url.hostname || url.username || url.password) {
    throw new UrlValidationError('invalid_url');
  }

  url.hash = '';
  return url.href;
}
