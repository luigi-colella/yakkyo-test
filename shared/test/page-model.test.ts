import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { Connection, Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getPageModel, PENDING_URL_INDEX, pageSchema } from '../src/page-model.js';
import type { Page } from '../src/page-model.js';

const PAGE_URL = 'https://example.com/';

describe('pageSchema', () => {
  it('declares the spec indexes plus the partial unique pending index', () => {
    expect(pageSchema.indexes()).toEqual([
      [{ uid: 1 }, expect.objectContaining({ unique: true })],
      [{ createdAt: -1 }, expect.anything()],
      [{ url: 1, status: 1 }, expect.anything()],
      [
        { url: 1 },
        expect.objectContaining({
          name: PENDING_URL_INDEX,
          unique: true,
          partialFilterExpression: { status: 'pending' },
        }),
      ],
    ]);
  });

  it('stores pages in the pages collection with timestamps', () => {
    expect(pageSchema.get('collection')).toBe('pages');
    expect(pageSchema.path('createdAt')).toBeDefined();
    expect(pageSchema.path('updatedAt')).toBeDefined();
  });
});

describe('Page model (MongoDB)', () => {
  let server: MongoMemoryServer;
  let connection: Connection;
  let Pages: Model<Page>;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(server.getUri()).asPromise();
    Pages = getPageModel(connection);
    await Pages.syncIndexes();
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });

  beforeEach(async () => {
    await Pages.deleteMany({});
  });

  it('returns the same model for the same connection', () => {
    expect(getPageModel(connection)).toBe(Pages);
  });

  it('creates every declared index', async () => {
    const names = (await Pages.collection.indexes()).map((index) => index.name);
    expect(names).toEqual(
      expect.arrayContaining(['uid_1', 'createdAt_-1', 'url_1_status_1', PENDING_URL_INDEX]),
    );
  });

  it('sets createdAt and updatedAt', async () => {
    const page = await Pages.create({ uid: 'a', url: PAGE_URL, status: 'pending' });
    expect(page.createdAt).toBeInstanceOf(Date);
    expect(page.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown status and missing required fields', async () => {
    // Raw documents, as they could come from untyped code paths.
    const invalid: Record<string, unknown>[] = [
      { uid: 'a', url: PAGE_URL, status: 'running' },
      { url: PAGE_URL, status: 'pending' },
      { uid: 'a', status: 'pending' },
    ];
    for (const doc of invalid) {
      await expect(Pages.create(doc)).rejects.toThrow(mongoose.Error.ValidationError);
    }
  });

  it('rejects a duplicate uid', async () => {
    await Pages.create({ uid: 'a', url: PAGE_URL, status: 'done' });
    await expect(
      Pages.create({ uid: 'a', url: 'https://other.example/', status: 'done' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows only one pending job per url', async () => {
    await Pages.create({ uid: 'a', url: PAGE_URL, status: 'pending' });
    await expect(
      Pages.create({ uid: 'b', url: PAGE_URL, status: 'pending' }),
    ).rejects.toMatchObject({
      code: 11000,
      keyPattern: { url: 1 },
    });
  });

  it('converges concurrent pending inserts on a single document', async () => {
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((uid) => Pages.create({ uid, url: PAGE_URL, status: 'pending' })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await Pages.countDocuments({ url: PAGE_URL })).toBe(1);
  });

  it('allows a new pending job next to finished jobs for the same url', async () => {
    await Pages.create({ uid: 'a', url: PAGE_URL, status: 'done' });
    await Pages.create({ uid: 'b', url: PAGE_URL, status: 'error' });
    await expect(
      Pages.create({ uid: 'c', url: PAGE_URL, status: 'pending' }),
    ).resolves.toBeDefined();
  });

  it('frees the url once the pending job is finalized', async () => {
    await Pages.create({ uid: 'a', url: PAGE_URL, status: 'pending' });
    await Pages.updateOne({ uid: 'a' }, { status: 'done', completedAt: new Date() });
    await expect(
      Pages.create({ uid: 'b', url: PAGE_URL, status: 'pending' }),
    ).resolves.toBeDefined();
  });
});
