import { finished } from 'node:stream/promises';

import { getPageModel, PAGE_IMAGES_BUCKET } from '@crawler/shared';
import type { Page, PageMeta } from '@crawler/shared';
import { mongo } from 'mongoose';
import type { Connection, Model, Types } from 'mongoose';

/** What a successful crawl stores. */
export interface CrawlResultRecord {
  description: string;
  /** URL after redirects. */
  finalUrl: string;
  /** JPEG screenshot. */
  image: Buffer;
  tookMs: number;
  meta: PageMeta;
}

/** Persistence operations of the worker. Every write applies only to a job still `pending`. */
export interface WorkerPageStore {
  isPending(uid: string): Promise<boolean>;
  /** Stores the result; `false` when the job is no longer pending (nothing is kept). */
  complete(uid: string, result: CrawlResultRecord): Promise<boolean>;
  /** Marks a pending job as `error` with a failure code. */
  fail(uid: string, code: string): Promise<void>;
}

export class MongoWorkerPageStore implements WorkerPageStore {
  private readonly pages: Model<Page>;
  private readonly images: mongo.GridFSBucket;

  /** `connection` must already be open. */
  constructor(
    connection: Connection,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!connection.db) throw new Error('MongoDB connection is not open');
    this.pages = getPageModel(connection);
    this.images = new mongo.GridFSBucket(connection.db, { bucketName: PAGE_IMAGES_BUCKET });
  }

  async isPending(uid: string): Promise<boolean> {
    return (await this.pages.exists({ uid, status: 'pending' })) !== null;
  }

  /**
   * Uploads the screenshot first, then switches the job from `pending` to `done` in one
   * conditional update, so a job finalized meanwhile (e.g. marked stale) is never overwritten.
   * If the update does not apply, or fails, the upload is deleted instead of being orphaned.
   */
  async complete(uid: string, result: CrawlResultRecord): Promise<boolean> {
    const imageRef = await this.uploadImage(uid, result.image);
    try {
      const update = await this.pages.updateOne(
        { uid, status: 'pending' },
        {
          $set: {
            status: 'done',
            description: result.description,
            finalUrl: result.finalUrl,
            imageRef,
            tookMs: result.tookMs,
            meta: result.meta,
            completedAt: this.now(),
          },
          $unset: { errorMessage: 1 },
        },
      );
      if (update.modifiedCount === 1) return true;
    } catch (error: unknown) {
      await this.deleteImage(imageRef);
      throw error;
    }
    await this.deleteImage(imageRef);
    return false;
  }

  async fail(uid: string, code: string): Promise<void> {
    await this.pages.updateOne(
      { uid, status: 'pending' },
      { $set: { status: 'error', errorMessage: code } },
    );
  }

  private async uploadImage(uid: string, image: Buffer): Promise<Types.ObjectId> {
    const upload = this.images.openUploadStream(`${uid}.jpg`, {
      metadata: { uid, contentType: 'image/jpeg' },
    });
    upload.end(image);
    await finished(upload);
    return upload.id;
  }

  /** Best effort: a leftover image only wastes space, it never changes a job's outcome. */
  private async deleteImage(imageRef: Types.ObjectId): Promise<void> {
    await this.images.delete(imageRef).catch(() => undefined);
  }
}
