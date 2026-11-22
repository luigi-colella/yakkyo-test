import { getPageModel, PAGE_IMAGES_BUCKET } from '@crawler/shared';
import type { CrawlStatusResponse, Page } from '@crawler/shared';
import { mongo } from 'mongoose';
import type { Connection, Model, Types } from 'mongoose';

/** Persistence operations the crawl service needs. Every lookup is by normalized URL or uid. */
export interface PageStore {
  /** uid of the most recent `done` job for `url` completed strictly after `completedAfter`. */
  findCachedDone(url: string, completedAfter: Date): Promise<string | null>;
  /** Marks `pending` jobs for `url` created at or before `createdAtOrBefore` as `error: stale_job`. */
  expireStalePending(url: string, createdAtOrBefore: Date): Promise<void>;
  findPending(url: string): Promise<string | null>;
  /** Inserts a `pending` job; `false` when another pending job for `url` won the race. */
  insertPending(uid: string, url: string, createdAt: Date): Promise<boolean>;
  /** Fails a job that is still `pending`; finalized jobs are left untouched. */
  markError(uid: string, message: string): Promise<void>;
  getStatus(uid: string): Promise<CrawlStatusResponse | null>;
}

const DUPLICATE_KEY = 11_000;
const FALLBACK_ERROR_MESSAGE = 'crawl_failed';

export class MongoPageStore implements PageStore {
  private readonly pages: Model<Page>;
  private readonly images: mongo.GridFSBucket;

  /** `connection` must already be open. */
  constructor(connection: Connection) {
    if (!connection.db) throw new Error('MongoDB connection is not open');
    this.pages = getPageModel(connection);
    this.images = new mongo.GridFSBucket(connection.db, { bucketName: PAGE_IMAGES_BUCKET });
  }

  async findCachedDone(url: string, completedAfter: Date): Promise<string | null> {
    const page = await this.pages
      .findOne({ url, status: 'done', completedAt: { $gt: completedAfter } }, { uid: 1 })
      .sort({ completedAt: -1 })
      .lean();
    return page?.uid ?? null;
  }

  async expireStalePending(url: string, createdAtOrBefore: Date): Promise<void> {
    await this.pages.updateMany(
      { url, status: 'pending', createdAt: { $lte: createdAtOrBefore } },
      { $set: { status: 'error', errorMessage: 'stale_job' } },
    );
  }

  async findPending(url: string): Promise<string | null> {
    const page = await this.pages.findOne({ url, status: 'pending' }, { uid: 1 }).lean();
    return page?.uid ?? null;
  }

  async insertPending(uid: string, url: string, createdAt: Date): Promise<boolean> {
    try {
      await this.pages.create({ uid, url, status: 'pending', createdAt });
      return true;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async markError(uid: string, message: string): Promise<void> {
    await this.pages.updateOne(
      { uid, status: 'pending' },
      { $set: { status: 'error', errorMessage: message } },
    );
  }

  async getStatus(uid: string): Promise<CrawlStatusResponse | null> {
    const page = await this.pages
      .findOne(
        { uid },
        { status: 1, url: 1, finalUrl: 1, description: 1, imageRef: 1, errorMessage: 1, tookMs: 1 },
      )
      .lean();
    if (!page) return null;

    switch (page.status) {
      case 'pending':
        return { status: 'pending' };
      case 'error':
        return { status: 'error', message: page.errorMessage ?? FALLBACK_ERROR_MESSAGE };
      case 'done': {
        const { description, imageRef, tookMs } = page;
        if (description === undefined || imageRef === undefined || tookMs === undefined) {
          throw new Error(`Page ${uid} is done but its result is incomplete`);
        }
        const image = await this.readImage(imageRef);
        return {
          status: 'done',
          result: {
            url: page.finalUrl ?? page.url,
            description,
            image: `data:image/jpeg;base64,${image.toString('base64')}`,
            tookMs,
          },
        };
      }
    }
  }

  private async readImage(imageRef: Types.ObjectId): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.images.openDownloadStream(imageRef)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === DUPLICATE_KEY;
}
