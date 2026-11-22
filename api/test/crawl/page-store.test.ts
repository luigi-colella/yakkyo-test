import { finished } from 'node:stream/promises';

import { getPageModel, PAGE_IMAGES_BUCKET } from '@crawler/shared';
import type { Page } from '@crawler/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { mongo, Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CrawlService,
  DONE_CACHE_TTL_MS,
  PENDING_REUSE_WINDOW_MS,
} from '../../src/crawl/crawl-service.js';
import { MongoPageStore } from '../../src/crawl/page-store.js';
import type { CrawlPublisher } from '../../src/crawl/rabbit.js';

const URL_KEY = 'https://example.com/';
const OTHER_URL = 'https://other.example/';
const NOW = new Date('2026-11-22T12:00:00.000Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1_000);

let server: MongoMemoryServer;
let connection: Connection;
let Pages: Model<Page>;
let store: MongoPageStore;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(server.getUri()).asPromise();
  Pages = getPageModel(connection);
  await Pages.syncIndexes();
  store = new MongoPageStore(connection);
}, 120_000);

afterAll(async () => {
  await connection?.close();
  await server?.stop();
});

beforeEach(async () => {
  await Pages.deleteMany({});
});

let uidCounter = 0;
async function insertPage(fields: Partial<Page>): Promise<string> {
  const uid = fields.uid ?? `uid-${++uidCounter}`;
  await Pages.create({ uid, url: URL_KEY, status: 'pending', createdAt: NOW, ...fields });
  return uid;
}

async function uploadImage(content: Buffer): Promise<Types.ObjectId> {
  const bucket = new mongo.GridFSBucket(connection.db!, { bucketName: PAGE_IMAGES_BUCKET });
  const upload = bucket.openUploadStream('screenshot.jpg');
  upload.end(content);
  await finished(upload);
  return upload.id;
}

describe('MongoPageStore', () => {
  it('requires an open connection', () => {
    const closed = mongoose.createConnection();
    expect(() => new MongoPageStore(closed)).toThrow('MongoDB connection is not open');
  });

  describe('findCachedDone', () => {
    const cutoff = secondsAgo(DONE_CACHE_TTL_MS / 1_000);

    it('measures the TTL from completion, not creation', async () => {
      const uid = await insertPage({
        status: 'done',
        createdAt: secondsAgo(600),
        completedAt: secondsAgo(59),
      });

      await expect(store.findCachedDone(URL_KEY, cutoff)).resolves.toBe(uid);
    });

    it('misses a job completed more than 60 seconds ago even if created recently', async () => {
      await insertPage({ status: 'done', createdAt: secondsAgo(10), completedAt: secondsAgo(61) });

      await expect(store.findCachedDone(URL_KEY, cutoff)).resolves.toBeNull();
    });

    it('treats exactly 60 seconds as expired', async () => {
      await insertPage({ status: 'done', completedAt: cutoff });

      await expect(store.findCachedDone(URL_KEY, cutoff)).resolves.toBeNull();
    });

    it('ignores pending and error jobs and other URLs', async () => {
      await insertPage({ status: 'pending', completedAt: NOW });
      await insertPage({ status: 'error', completedAt: NOW });
      await insertPage({ status: 'done', url: OTHER_URL, completedAt: NOW });

      await expect(store.findCachedDone(URL_KEY, cutoff)).resolves.toBeNull();
    });

    it('returns the most recently completed job', async () => {
      await insertPage({ status: 'done', completedAt: secondsAgo(30) });
      const newest = await insertPage({ status: 'done', completedAt: secondsAgo(5) });
      await insertPage({ status: 'done', completedAt: secondsAgo(20) });

      await expect(store.findCachedDone(URL_KEY, cutoff)).resolves.toBe(newest);
    });
  });

  describe('expireStalePending', () => {
    const cutoff = secondsAgo(PENDING_REUSE_WINDOW_MS / 1_000);

    it('marks pending jobs created at or before the cutoff as stale', async () => {
      const stale = await insertPage({ createdAt: cutoff });

      await store.expireStalePending(URL_KEY, cutoff);

      await expect(Pages.findOne({ uid: stale }).lean()).resolves.toMatchObject({
        status: 'error',
        errorMessage: 'stale_job',
      });
      await expect(store.findPending(URL_KEY)).resolves.toBeNull();
    });

    it('leaves fresh pending jobs, finished jobs and other URLs alone', async () => {
      const fresh = await insertPage({ createdAt: new Date(cutoff.getTime() + 1) });
      const done = await insertPage({ status: 'done', createdAt: secondsAgo(3_600) });
      const other = await insertPage({ url: OTHER_URL, createdAt: secondsAgo(3_600) });

      await store.expireStalePending(URL_KEY, cutoff);

      const statuses = await Pages.find({}, { uid: 1, status: 1 }).lean();
      expect(Object.fromEntries(statuses.map((page) => [page.uid, page.status]))).toEqual({
        [fresh]: 'pending',
        [done]: 'done',
        [other]: 'pending',
      });
    });
  });

  describe('findPending / insertPending', () => {
    it('finds the pending job for a URL', async () => {
      await insertPage({ status: 'done' });
      const pending = await insertPage({ status: 'pending' });

      await expect(store.findPending(URL_KEY)).resolves.toBe(pending);
      await expect(store.findPending(OTHER_URL)).resolves.toBeNull();
    });

    it('stores the given creation time', async () => {
      await expect(store.insertPending('uid-a', URL_KEY, secondsAgo(42))).resolves.toBe(true);

      await expect(Pages.findOne({ uid: 'uid-a' }).lean()).resolves.toMatchObject({
        url: URL_KEY,
        status: 'pending',
        createdAt: secondsAgo(42),
      });
    });

    it('returns false when a pending job for the URL already exists', async () => {
      await store.insertPending('uid-a', URL_KEY, NOW);

      await expect(store.insertPending('uid-b', URL_KEY, NOW)).resolves.toBe(false);
      await expect(Pages.countDocuments()).resolves.toBe(1);
    });

    it('propagates errors other than a duplicate key', async () => {
      const failing = vi.spyOn(Pages, 'create').mockRejectedValueOnce(new Error('boom'));

      await expect(store.insertPending('uid-a', URL_KEY, NOW)).rejects.toThrow('boom');
      failing.mockRestore();
    });
  });

  describe('markError', () => {
    it('fails a pending job', async () => {
      const uid = await insertPage({});

      await store.markError(uid, 'queue_unavailable');

      await expect(store.getStatus(uid)).resolves.toEqual({
        status: 'error',
        message: 'queue_unavailable',
      });
    });

    it('does not overwrite a finished job', async () => {
      const uid = await insertPage({ status: 'done', description: 'kept' });

      await store.markError(uid, 'queue_unavailable');

      await expect(Pages.findOne({ uid }).lean()).resolves.toMatchObject({ status: 'done' });
    });
  });

  describe('getStatus', () => {
    it('returns null for an unknown uid', async () => {
      await expect(store.getStatus('missing')).resolves.toBeNull();
    });

    it('maps a pending job', async () => {
      const uid = await insertPage({});

      await expect(store.getStatus(uid)).resolves.toEqual({ status: 'pending' });
    });

    it('maps an error job, with a fallback message', async () => {
      const withMessage = await insertPage({ status: 'error', errorMessage: 'auth_required' });
      const withoutMessage = await insertPage({ status: 'error' });

      await expect(store.getStatus(withMessage)).resolves.toEqual({
        status: 'error',
        message: 'auth_required',
      });
      await expect(store.getStatus(withoutMessage)).resolves.toEqual({
        status: 'error',
        message: 'crawl_failed',
      });
    });

    it('maps a done job with its screenshot as a data URI and the final URL', async () => {
      const imageRef = await uploadImage(JPEG);
      const uid = await insertPage({
        status: 'done',
        finalUrl: 'https://www.example.com/home',
        description: 'Clean layout',
        imageRef,
        tookMs: 1234,
        completedAt: NOW,
      });

      await expect(store.getStatus(uid)).resolves.toEqual({
        status: 'done',
        result: {
          url: 'https://www.example.com/home',
          description: 'Clean layout',
          image: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
          tookMs: 1234,
        },
      });
    });

    it('falls back to the requested URL when no final URL was stored', async () => {
      const uid = await insertPage({
        status: 'done',
        description: 'd',
        imageRef: await uploadImage(JPEG),
        tookMs: 1,
      });

      const status = await store.getStatus(uid);
      expect(status).toMatchObject({ result: { url: URL_KEY } });
    });

    it.each([
      ['description', { imageRef: new Types.ObjectId(), tookMs: 1 }],
      ['image', { description: 'd', tookMs: 1 }],
      ['duration', { description: 'd', imageRef: new Types.ObjectId() }],
    ])('throws for a done job without its %s', async (_missing, fields) => {
      const uid = await insertPage({ status: 'done', ...fields });

      await expect(store.getStatus(uid)).rejects.toThrow('result is incomplete');
    });

    it('throws when the screenshot file is missing', async () => {
      const uid = await insertPage({
        status: 'done',
        description: 'd',
        imageRef: new Types.ObjectId(),
        tookMs: 1,
      });

      await expect(store.getStatus(uid)).rejects.toThrow();
    });
  });
});

describe('CrawlService with MongoDB', () => {
  let now: Date;
  let publisher: { publish: ReturnType<typeof vi.fn<CrawlPublisher['publish']>> };
  let service: CrawlService;

  beforeEach(() => {
    now = NOW;
    publisher = { publish: vi.fn<CrawlPublisher['publish']>().mockResolvedValue(undefined) };
    service = new CrawlService({ pages: store, publisher, now: () => now });
  });

  it('creates a single job for three concurrent requests', async () => {
    const uids = await Promise.all([
      service.requestCrawl(URL_KEY),
      service.requestCrawl(URL_KEY),
      service.requestCrawl(URL_KEY),
    ]);

    expect(new Set(uids).size).toBe(1);
    await expect(Pages.countDocuments({ url: URL_KEY })).resolves.toBe(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('serves a completed job from cache for 60 seconds after completion', async () => {
    const uid = await service.requestCrawl(URL_KEY);
    await Pages.updateOne(
      { uid },
      { $set: { status: 'done', completedAt: new Date(NOW.getTime() + 20_000) } },
    );

    now = new Date(NOW.getTime() + 79_000);
    await expect(service.requestCrawl(URL_KEY)).resolves.toBe(uid);

    now = new Date(NOW.getTime() + 80_000);
    const fresh = await service.requestCrawl(URL_KEY);
    expect(fresh).not.toBe(uid);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('replaces a pending job older than 5 minutes', async () => {
    const stuck = await service.requestCrawl(URL_KEY);

    now = new Date(NOW.getTime() + PENDING_REUSE_WINDOW_MS - 1);
    await expect(service.requestCrawl(URL_KEY)).resolves.toBe(stuck);

    now = new Date(NOW.getTime() + PENDING_REUSE_WINDOW_MS);
    const replacement = await service.requestCrawl(URL_KEY);
    expect(replacement).not.toBe(stuck);
    await expect(service.getStatus(stuck)).resolves.toEqual({
      status: 'error',
      message: 'stale_job',
    });
    await expect(service.getStatus(replacement)).resolves.toEqual({ status: 'pending' });
  });

  it('fails the job when the queue is unavailable, so the next request starts over', async () => {
    publisher.publish.mockRejectedValueOnce(new Error('RabbitMQ down'));
    const failed = await service.requestCrawl(URL_KEY).catch(() => null);
    expect(failed).toBeNull();

    const retried = await service.requestCrawl(URL_KEY);
    await expect(service.getStatus(retried)).resolves.toEqual({ status: 'pending' });
    await expect(
      Pages.countDocuments({ status: 'error', errorMessage: 'queue_unavailable' }),
    ).resolves.toBe(1);
  });
});
