import { Schema } from 'mongoose';
import type { Connection, Model, Types } from 'mongoose';

import type { PageStatus } from './contracts.js';

export interface PageMeta {
  viewport: { w: number; h: number };
  userAgent: string;
  timestamp: Date;
}

/** A crawl job and, once done, its result. One document per `uid`. */
export interface Page {
  uid: string;
  /** Normalized requested URL: the idempotency and cache key. */
  url: string;
  /** URL after redirects, exposed as `result.url`. */
  finalUrl?: string;
  status: PageStatus;
  description?: string;
  /** GridFS file id (bucket `page-images`) of the JPEG screenshot. */
  imageRef?: Types.ObjectId;
  errorMessage?: string;
  tookMs?: number;
  /** Start of the 60 s cache TTL. */
  completedAt?: Date;
  meta?: PageMeta;
  createdAt: Date;
  updatedAt: Date;
}

export const PENDING_URL_INDEX = 'one_pending_job_per_url';

/** GridFS bucket holding the screenshots referenced by `Page.imageRef`. */
export const PAGE_IMAGES_BUCKET = 'page-images';

const metaSchema = new Schema<PageMeta>(
  {
    viewport: {
      w: { type: Number, required: true },
      h: { type: Number, required: true },
    },
    userAgent: { type: String, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false },
);

export const pageSchema = new Schema<Page>(
  {
    uid: { type: String, required: true },
    url: { type: String, required: true },
    finalUrl: String,
    status: { type: String, enum: ['pending', 'done', 'error'], required: true },
    description: String,
    imageRef: Schema.Types.ObjectId,
    errorMessage: String,
    tookMs: Number,
    completedAt: Date,
    meta: metaSchema,
  },
  { collection: 'pages', timestamps: true },
);

pageSchema.index({ uid: 1 }, { unique: true });
pageSchema.index({ createdAt: -1 });
pageSchema.index({ url: 1, status: 1 });
// At most one pending job per URL: concurrent requests converge on a single uid.
pageSchema.index(
  { url: 1 },
  { name: PENDING_URL_INDEX, unique: true, partialFilterExpression: { status: 'pending' } },
);

/** Returns the `Page` model bound to `connection`, registering it once. */
export function getPageModel(connection: Connection): Model<Page> {
  return (
    (connection.models.Page as Model<Page> | undefined) ??
    connection.model<Page>('Page', pageSchema)
  );
}
