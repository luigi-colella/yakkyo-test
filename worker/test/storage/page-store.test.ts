import { getPageModel, PAGE_IMAGES_BUCKET } from '@crawler/shared';
import type { Page } from '@crawler/shared';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { mongo } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MongoWorkerPageStore } from '../../src/storage/page-store.js';
import type { CrawlResultRecord } from '../../src/storage/page-store.js';

const NOW = new Date('2026-11-22T12:00:30.000Z');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const RESULT: CrawlResultRecord = {
  description: 'Two-column layout',
  finalUrl: 'https://www.example.com/home',
  image: JPEG,
  tookMs: 4_321,
  meta: {
    viewport: { w: 1440, h: 900 },
    userAgent: 'Mozilla/5.0 HeadlessChrome',
    timestamp: new Date('2026-11-22T12:00:29.000Z'),
  },
};

let server: MongoMemoryServer;
let connection: Connection;
let Pages: Model<Page>;
let images: mongo.GridFSBucket;
let store: MongoWorkerPageStore;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(server.getUri()).asPromise();
  Pages = getPageModel(connection);
  await Pages.syncIndexes();
  images = new mongo.GridFSBucket(connection.db!, { bucketName: PAGE_IMAGES_BUCKET });
  store = new MongoWorkerPageStore(connection, () => NOW);
}, 120_000);

afterAll(async () => {
  await connection?.close();
  await server?.stop();
});

beforeEach(async () => {
  await Pages.deleteMany({});
  await images.drop().catch(() => undefined);
});

let uidCounter = 0;
async function insertPage(fields: Partial<Page> = {}): Promise<string> {
  const uid = fields.uid ?? `uid-${++uidCounter}`;
  await Pages.create({
    uid,
    url: `https://example.com/${uid}`,
    status: 'pending',
    createdAt: new Date('2026-11-22T12:00:00.000Z'),
    ...fields,
  });
  return uid;
}

async function readImage(id: mongo.ObjectId): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of images.openDownloadStream(id)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const storedImageCount = () =>
  images
    .find()
    .toArray()
    .then((files) => files.length);

describe('MongoWorkerPageStore', () => {
  it('requires an open connection', () => {
    expect(() => new MongoWorkerPageStore(mongoose.createConnection())).toThrow(
      'MongoDB connection is not open',
    );
  });

  describe('isPending', () => {
    it('is true only for a pending job', async () => {
      const pending = await insertPage();
      const done = await insertPage({ status: 'done' });
      const failed = await insertPage({ status: 'error', errorMessage: 'stale_job' });

      await expect(store.isPending(pending)).resolves.toBe(true);
      await expect(store.isPending(done)).resolves.toBe(false);
      await expect(store.isPending(failed)).resolves.toBe(false);
      await expect(store.isPending('unknown')).resolves.toBe(false);
    });
  });

  describe('complete', () => {
    it('stores the result, the completion time and the screenshot', async () => {
      const uid = await insertPage();

      await expect(store.complete(uid, RESULT)).resolves.toBe(true);

      const page = await Pages.findOne({ uid }).lean();
      expect(page).toMatchObject({
        status: 'done',
        description: RESULT.description,
        finalUrl: RESULT.finalUrl,
        tookMs: RESULT.tookMs,
        meta: RESULT.meta,
        completedAt: NOW,
      });
      expect(page?.errorMessage).toBeUndefined();
      await expect(readImage(page!.imageRef!)).resolves.toEqual(JPEG);
    });

    it('names the image after the job', async () => {
      const uid = await insertPage();
      await store.complete(uid, RESULT);

      const [file] = await images.find().toArray();
      expect(file).toMatchObject({ filename: `${uid}.jpg`, metadata: { uid } });
    });

    it.each(['done', 'error'] as const)(
      'leaves a %s job untouched and deletes the upload',
      async (status) => {
        const uid = await insertPage({ status, errorMessage: 'stale_job' });

        await expect(store.complete(uid, RESULT)).resolves.toBe(false);

        const page = await Pages.findOne({ uid }).lean();
        expect(page).toMatchObject({ status, errorMessage: 'stale_job' });
        expect(page?.imageRef).toBeUndefined();
        await expect(storedImageCount()).resolves.toBe(0);
      },
    );

    it('returns false for an unknown uid without keeping the upload', async () => {
      await expect(store.complete('unknown', RESULT)).resolves.toBe(false);
      await expect(storedImageCount()).resolves.toBe(0);
    });

    it('deletes the upload and rethrows when the update fails', async () => {
      const uid = await insertPage();
      const updateOne = vi
        .spyOn(Pages, 'updateOne')
        .mockRejectedValueOnce(new Error('primary stepped down'));

      await expect(store.complete(uid, RESULT)).rejects.toThrow('primary stepped down');

      updateOne.mockRestore();
      await expect(storedImageCount()).resolves.toBe(0);
      await expect(store.isPending(uid)).resolves.toBe(true);
    });

    it('lets only one of two concurrent completions win', async () => {
      const uid = await insertPage();

      const outcomes = await Promise.all([
        store.complete(uid, RESULT),
        store.complete(uid, RESULT),
      ]);

      expect(outcomes.sort()).toEqual([false, true]);
      await expect(storedImageCount()).resolves.toBe(1);
    });
  });

  describe('fail', () => {
    it('marks a pending job as error with the code', async () => {
      const uid = await insertPage();

      await store.fail(uid, 'robots_disallowed');

      await expect(Pages.findOne({ uid }).lean()).resolves.toMatchObject({
        status: 'error',
        errorMessage: 'robots_disallowed',
      });
    });

    it('never overwrites a finalized job', async () => {
      const uid = await insertPage({ status: 'done', description: 'kept' });

      await store.fail(uid, 'page_timeout');

      await expect(Pages.findOne({ uid }).lean()).resolves.toMatchObject({
        status: 'done',
        description: 'kept',
      });
    });
  });
});
