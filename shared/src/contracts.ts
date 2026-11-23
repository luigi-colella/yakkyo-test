import { z } from 'zod';

export const pageStatusSchema = z.enum(['pending', 'done', 'error']);
export type PageStatus = z.infer<typeof pageStatusSchema>;

/** Crawl job identifier (ULID). Anything else can never match a page. */
export const uidSchema = z.ulid();

/** `POST /crawl` body. The URL itself is checked by `normalizeUrl()`. */
export const crawlBodySchema = z.object({ url: z.string() });
export type CrawlBody = z.infer<typeof crawlBodySchema>;

/** Message published on `crawl.requests` and consumed by the worker. */
export const crawlMessageSchema = z.strictObject({
  uid: uidSchema,
  url: z.url({ protocol: /^https?$/ }),
  requestedAt: z.iso.datetime(),
});
export type CrawlMessage = z.infer<typeof crawlMessageSchema>;

/** `POST /crawl` 202 body. */
export interface CrawlAccepted {
  uid: string;
  /**
   * Only on a cache hit: the job is already `done`, so the client can read it at once
   * instead of waiting for its first poll. Absent for a new or running job.
   */
  cached?: true;
}

export interface CrawlResult {
  /** Final URL after redirects. */
  url: string;
  description: string;
  /** `data:image/jpeg;base64,...` */
  image: string;
  tookMs: number;
}

export type CrawlStatusResponse =
  | { status: 'pending' }
  | { status: 'done'; result: CrawlResult }
  | { status: 'error'; message: string };
