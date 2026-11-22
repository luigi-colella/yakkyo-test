/**
 * Stable codes stored as the page's error `message`. The frontend turns them into readable text.
 * `http_<status>` reports an unusable HTTP status of the crawled page.
 */
export type FailureCode =
  | 'analysis_failed'
  | 'auth_required'
  | 'crawl_failed'
  | 'dns_failed'
  | 'navigation_failed'
  | 'page_timeout'
  | 'robots_disallowed'
  | 'robots_unavailable'
  | 'tls_error'
  | 'unsafe_target'
  | `http_${number}`;

/**
 * A crawl failure with its public code. Transient failures may be retried while the job's
 * time budget allows it; permanent ones (and exhausted retries) end the job in `error`.
 */
export class CrawlFailure extends Error {
  constructor(
    public readonly code: FailureCode,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'CrawlFailure';
  }
}

export function permanentFailure(code: FailureCode, cause?: unknown): CrawlFailure {
  return new CrawlFailure(code, false, { cause });
}

export function transientFailure(code: FailureCode, cause?: unknown): CrawlFailure {
  return new CrawlFailure(code, true, { cause });
}

/**
 * Node TLS error codes, e.g. `CERT_HAS_EXPIRED`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
 * `ERR_TLS_CERT_ALTNAME_INVALID`, `ERR_SSL_WRONG_VERSION_NUMBER`.
 */
const NODE_TLS_CODE = /CERT|SSL|TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE/;
/** Chromium certificate and handshake errors as reported by Playwright, e.g. `net::ERR_CERT_DATE_INVALID`. */
const CHROMIUM_TLS_ERROR = /net::ERR_(CERT_|SSL_|BAD_SSL_)/;

/**
 * Maps any error to a `CrawlFailure`. TLS problems are permanent (verification is never turned
 * off, so retrying cannot help); timeouts and unknown errors are transient.
 */
export function toCrawlFailure(error: unknown): CrawlFailure {
  if (error instanceof CrawlFailure) return error;
  if (isTlsError(error)) return permanentFailure('tls_error', error);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return transientFailure('page_timeout', error);
  }
  return transientFailure('crawl_failed', error);
}

function isTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    (typeof code === 'string' && NODE_TLS_CODE.test(code)) || CHROMIUM_TLS_ERROR.test(error.message)
  );
}

/**
 * Of two failures seen during the same job, keeps the one that best explains the outcome:
 * the first one, unless a later failure is permanent and the first was not.
 */
export function mostRelevantFailure(
  current: CrawlFailure | undefined,
  candidate: CrawlFailure,
): CrawlFailure {
  return current && (!current.retryable || candidate.retryable) ? current : candidate;
}
