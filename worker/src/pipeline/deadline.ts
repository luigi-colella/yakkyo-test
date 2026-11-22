import { transientFailure } from './errors.js';

/** End-to-end budget of a crawl job, measured from the moment it was requested. */
export const CRAWL_BUDGET_MS = 30_000;

/**
 * The time left to a crawl job. It covers every step (queue wait, robots, navigation,
 * analysis, persistence, retries); when it runs out, `signal` aborts and every pending
 * `run()` rejects with a transient `page_timeout`. Call `dispose()` when the job is over.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;

  constructor(readonly expiresAt: number) {
    this.timer = setTimeout(
      () => this.controller.abort(transientFailure('page_timeout')),
      Math.max(0, expiresAt - Date.now()),
    );
    this.timer.unref();
  }

  /**
   * The deadline of a job requested at `requestedAt` (ISO date). A timestamp in the future
   * (clock skew between containers) never grants more than `budgetMs` from now; an invalid
   * one grants nothing.
   */
  static forRequest(requestedAt: string, budgetMs = CRAWL_BUDGET_MS): Deadline {
    const requestedMs = Date.parse(requestedAt);
    if (Number.isNaN(requestedMs)) return new Deadline(Date.now());
    return new Deadline(Math.min(requestedMs, Date.now()) + budgetMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds left; throws a transient `page_timeout` once the budget is spent. */
  remaining(): number {
    const remainingMs = this.expiresAt - Date.now();
    if (!(remainingMs > 0)) throw transientFailure('page_timeout');
    return remainingMs;
  }

  /** A step timeout: `limitMs`, shortened to what is left of the budget. */
  cap(limitMs: number): number {
    return Math.min(limitMs, this.remaining());
  }

  /** Whether something starting after `delayMs` (e.g. a retry) would still find budget left. */
  fits(delayMs: number): boolean {
    return Date.now() + delayMs < this.expiresAt;
  }

  /**
   * Settles like `operation`, or rejects with `page_timeout` when the budget runs out first.
   * The operation itself is not cancelled: pass `signal` to it when it supports one.
   */
  run<T>(operation: Promise<T>): Promise<T> {
    const { signal } = this;
    if (signal.aborted) {
      operation.catch(() => undefined);
      return Promise.reject(signal.reason as Error);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason as Error);
      signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: Error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
