import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CRAWL_BUDGET_MS, Deadline } from '../../src/pipeline/deadline.js';
import { CrawlFailure } from '../../src/pipeline/errors.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const timeout = { code: 'page_timeout', retryable: true };

describe('Deadline', () => {
  const deadlines: Deadline[] = [];
  const track = (deadline: Deadline) => {
    deadlines.push(deadline);
    return deadline;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    deadlines.splice(0).forEach((deadline) => deadline.dispose());
    vi.useRealTimers();
  });

  describe('forRequest', () => {
    it('gives a job 30 s from its request time', () => {
      expect(CRAWL_BUDGET_MS).toBe(30_000);
      const deadline = track(Deadline.forRequest('2026-01-01T11:59:50.000Z'));
      expect(deadline.expiresAt).toBe(NOW.getTime() + 20_000);
      expect(deadline.remaining()).toBe(20_000);
    });

    it('accepts a custom budget', () => {
      const deadline = track(Deadline.forRequest(NOW.toISOString(), 5_000));
      expect(deadline.remaining()).toBe(5_000);
    });

    it('never grants more than the budget from now to a request time in the future', () => {
      const deadline = track(Deadline.forRequest('2026-01-01T12:10:00.000Z'));
      expect(deadline.remaining()).toBe(CRAWL_BUDGET_MS);
    });

    it('is already expired for a job requested more than 30 s ago', () => {
      const deadline = track(Deadline.forRequest('2026-01-01T11:59:00.000Z'));
      expect(() => deadline.remaining()).toThrow(CrawlFailure);
    });

    it('grants nothing to an invalid request time', () => {
      const deadline = track(Deadline.forRequest('not a date'));
      expect(() => deadline.remaining()).toThrow(CrawlFailure);
      expect(deadline.fits(0)).toBe(false);
    });
  });

  describe('remaining and cap', () => {
    it('counts down and throws a transient page_timeout at the deadline', () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      vi.advanceTimersByTime(999);
      expect(deadline.remaining()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(() => deadline.remaining()).toThrow('page_timeout');
    });

    it('caps a step timeout to the time left', () => {
      const deadline = track(new Deadline(NOW.getTime() + 2_000));
      expect(deadline.cap(3_000)).toBe(2_000);
      expect(deadline.cap(500)).toBe(500);
      vi.advanceTimersByTime(2_000);
      expect(() => deadline.cap(500)).toThrow('page_timeout');
    });
  });

  describe('fits', () => {
    it('is true only if something starting after the delay finds time left', () => {
      const deadline = track(new Deadline(NOW.getTime() + 2_000));
      expect(deadline.fits(1_999)).toBe(true);
      expect(deadline.fits(2_000)).toBe(false);
      expect(deadline.fits(5_000)).toBe(false);
    });
  });

  describe('signal', () => {
    it('aborts with a page_timeout failure when the budget runs out', () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toMatchObject(timeout);
    });

    it('aborts right away when created already expired', () => {
      const deadline = track(new Deadline(NOW.getTime() - 1));
      vi.advanceTimersByTime(0);
      expect(deadline.signal.aborted).toBe(true);
    });

    it('never aborts once disposed', () => {
      const deadline = new Deadline(NOW.getTime() + 1_000);
      deadline.dispose();
      vi.advanceTimersByTime(5_000);
      expect(deadline.signal.aborted).toBe(false);
    });
  });

  describe('run', () => {
    it('resolves with the operation result within the budget', async () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      await expect(deadline.run(Promise.resolve('value'))).resolves.toBe('value');
    });

    it('passes the operation error through unchanged', async () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      const error = new Error('boom');
      await expect(deadline.run(Promise.reject(error))).rejects.toBe(error);
    });

    it('rejects with page_timeout when the budget runs out first', async () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      const outcome = expect(deadline.run(new Promise(() => undefined))).rejects.toMatchObject(
        timeout,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
    });

    it('rejects at once when already expired, without leaving the operation unhandled', async () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(deadline.run(Promise.reject(new Error('late')))).rejects.toMatchObject(timeout);
    });

    it('ignores the deadline once the operation has settled', async () => {
      const deadline = track(new Deadline(NOW.getTime() + 1_000));
      await expect(deadline.run(Promise.resolve(1))).resolves.toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(deadline.signal.aborted).toBe(true);
    });
  });
});
