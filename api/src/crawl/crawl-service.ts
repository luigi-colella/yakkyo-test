import { normalizeUrl } from '@crawler/shared';
import type { CrawlStatusResponse } from '@crawler/shared';
import { ulid } from 'ulid';

import { ServiceUnavailableError } from './errors.js';
import type { PageStore } from './page-store.js';
import type { CrawlPublisher } from './rabbit.js';

/** A `done` job is served from cache for this long after its completion. */
export const DONE_CACHE_TTL_MS = 60_000;
/** A `pending` job older than this is considered stuck and replaced. */
export const PENDING_REUSE_WINDOW_MS = 5 * 60_000;
/** Inserts lost to a concurrent request before giving up (each loss is retried once). */
const MAX_INSERT_ATTEMPTS = 2;

export interface CrawlServiceDeps {
  pages: PageStore;
  publisher: CrawlPublisher;
  now?: () => Date;
  createUid?: () => string;
}

interface Job {
  uid: string;
  /** `true` only for a job created by this request, which must then be published. */
  created: boolean;
}

export class CrawlService {
  private readonly pages: PageStore;
  private readonly publisher: CrawlPublisher;
  private readonly now: () => Date;
  private readonly createUid: () => string;

  constructor({ pages, publisher, now = () => new Date(), createUid = ulid }: CrawlServiceDeps) {
    this.pages = pages;
    this.publisher = publisher;
    this.now = now;
    this.createUid = createUid;
  }

  /**
   * Returns the uid of the job answering a crawl request for `input`:
   * a recently completed job (cache), a running one (idempotency) or a new
   * one, published to the queue. Throws `UrlValidationError` for an invalid
   * URL and `ServiceUnavailableError` when MongoDB or RabbitMQ fail.
   */
  async requestCrawl(input: string): Promise<string> {
    const url = normalizeUrl(input);
    const requestedAt = this.now();

    const job = await withStorage(() => this.findOrCreateJob(url, requestedAt));
    if (!job.created) return job.uid;

    try {
      await this.publisher.publish({ uid: job.uid, url, requestedAt: requestedAt.toISOString() });
    } catch (error: unknown) {
      // If this write fails too, the job stays pending until the stale sweep retires it.
      await this.pages.markError(job.uid, 'queue_unavailable').catch(() => undefined);
      throw new ServiceUnavailableError('queue_unavailable', { cause: error });
    }
    return job.uid;
  }

  getStatus(uid: string): Promise<CrawlStatusResponse | null> {
    return withStorage(() => this.pages.getStatus(uid));
  }

  private async findOrCreateJob(url: string, requestedAt: Date): Promise<Job> {
    const now = requestedAt.getTime();

    const cachedUid = await this.pages.findCachedDone(url, new Date(now - DONE_CACHE_TTL_MS));
    if (cachedUid) return { uid: cachedUid, created: false };

    await this.pages.expireStalePending(url, new Date(now - PENDING_REUSE_WINDOW_MS));

    // The partial unique index allows one pending job per URL: a lost insert
    // means a concurrent request created it, and the next lookup returns it.
    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
      const pendingUid = await this.pages.findPending(url);
      if (pendingUid) return { uid: pendingUid, created: false };

      const uid = this.createUid();
      if (await this.pages.insertPending(uid, url, requestedAt)) return { uid, created: true };
    }
    throw new Error(`Could not settle a pending job for ${url}`);
  }
}

async function withStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new ServiceUnavailableError('storage_unavailable', { cause: error });
  }
}
