export type UnavailableCode = 'storage_unavailable' | 'queue_unavailable';

/** A backing service (MongoDB or RabbitMQ) failed: the request can be retried later. */
export class ServiceUnavailableError extends Error {
  constructor(
    public readonly code: UnavailableCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ServiceUnavailableError';
  }
}
