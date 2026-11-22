import { describe, expect, it } from 'vitest';

import {
  crawlBodySchema,
  crawlMessageSchema,
  pageStatusSchema,
  uidSchema,
} from '../src/contracts.js';

const UID = '01JD8X4Z2Q3V5W7Y9A1B3C5D7E';

describe('uidSchema', () => {
  it('accepts a ULID', () => {
    expect(uidSchema.safeParse(UID).success).toBe(true);
  });

  it.each([
    '',
    'abc',
    `${UID}0`,
    UID.slice(1),
    '01JD8X4Z2Q3V5W7Y9A1B3C5D7!',
    '507f1f77bcf86cd799439011',
  ])('rejects %j', (value) => {
    expect(uidSchema.safeParse(value).success).toBe(false);
  });
});

describe('pageStatusSchema', () => {
  it('accepts the three statuses only', () => {
    for (const status of ['pending', 'done', 'error']) {
      expect(pageStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(pageStatusSchema.safeParse('running').success).toBe(false);
  });
});

describe('crawlBodySchema', () => {
  it('accepts a string url and leaves its validation to normalizeUrl', () => {
    expect(crawlBodySchema.parse({ url: 'not a url' })).toEqual({ url: 'not a url' });
  });

  it.each([{}, { url: 42 }, { url: null }, null, 'https://example.com', []])(
    'rejects %j',
    (body) => {
      expect(crawlBodySchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('crawlMessageSchema', () => {
  const valid = { uid: UID, url: 'https://example.com/', requestedAt: '2026-11-22T10:00:00.000Z' };

  it('accepts a valid message', () => {
    expect(crawlMessageSchema.parse(valid)).toEqual(valid);
  });

  it.each(['uid', 'url', 'requestedAt'] as const)('rejects a message without %s', (field) => {
    const message: Record<string, unknown> = { ...valid };
    delete message[field];
    expect(crawlMessageSchema.safeParse(message).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(crawlMessageSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });

  it.each([
    { uid: 'not-a-ulid' },
    { url: 'ftp://example.com/' },
    { url: 'file:///etc/passwd' },
    { url: 'example.com' },
    { requestedAt: 'yesterday' },
    { requestedAt: '2026-11-22' },
    { requestedAt: 1732269600000 },
  ])('rejects %j', (override) => {
    expect(crawlMessageSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('rejects non-JSON-object payloads', () => {
    expect(crawlMessageSchema.safeParse('{"uid":"x"}').success).toBe(false);
    expect(crawlMessageSchema.safeParse(null).success).toBe(false);
  });
});
