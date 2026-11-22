import type { CrawlStatusResponse } from '@crawler/shared/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../src/services/api.js';
import {
  pollUntilSettled,
  PollTimeoutError,
  type StatusCheck,
} from '../../src/services/polling.js';

const DONE: CrawlStatusResponse = {
  status: 'done',
  result: {
    url: 'https://example.com/',
    description: 'd',
    image: 'data:image/jpeg;base64,',
    tookMs: 1,
  },
};
const PENDING: CrawlStatusResponse = { status: 'pending' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

type Answer = () => Promise<CrawlStatusResponse>;

/** A check that records the time of each call and answers from `answers` in order (then pending). */
function checkAnswering(...answers: Answer[]) {
  const times: number[] = [];
  const check = vi.fn<StatusCheck>(() => {
    times.push(Date.now());
    const next = answers[times.length - 1] ?? answer(PENDING);
    return next();
  });
  return { check, times };
}

function answer(status: CrawlStatusResponse): Answer {
  return () => Promise.resolve(status);
}

function fail(error: Error): Answer {
  return () => Promise.reject(error);
}

const hang: Answer = () => new Promise<CrawlStatusResponse>(() => undefined);

type Outcome = { status: CrawlStatusResponse } | { error: unknown };

/** Starts polling and captures its outcome, so fake timers can run before it is awaited. */
function start(
  check: StatusCheck,
  signal = new AbortController().signal,
  startedAt = 0,
): Promise<Outcome> {
  return pollUntilSettled(check, signal, startedAt).then(
    (status) => ({ status }),
    (error: unknown) => ({ error }),
  );
}

async function errorOf(outcome: Promise<Outcome>): Promise<unknown> {
  const settled = await outcome;
  expect(settled).toHaveProperty('error');
  return (settled as { error: unknown }).error;
}

describe('pollUntilSettled', () => {
  it('checks at 2, 4, 8, 16 and 27 s, then times out at 30 s', async () => {
    const { check, times } = checkAnswering();
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(times).toEqual([2_000, 4_000, 8_000, 16_000, 27_000]);
    await vi.advanceTimersByTimeAsync(1);

    const error = await errorOf(outcome);
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect((error as PollTimeoutError).code).toBe('poll_timeout');
  });

  it('measures the offsets from startedAt, not from the call', async () => {
    vi.setSystemTime(1_500);
    const { check, times } = checkAnswering(answer(PENDING), answer(DONE));
    const outcome = start(check, undefined, 0);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(times).toEqual([2_000, 4_000]);
    expect(await outcome).toEqual({ status: DONE });
  });

  it('checks at once when the first offset has already passed', async () => {
    vi.setSystemTime(2_500);
    const { check, times } = checkAnswering(answer(DONE));
    const outcome = start(check, undefined, 0);

    await vi.advanceTimersByTimeAsync(0);

    expect(times).toEqual([2_500]);
    expect(await outcome).toEqual({ status: DONE });
  });

  it('returns the first settled status and stops polling', async () => {
    const failed: CrawlStatusResponse = { status: 'error', message: 'robots_disallowed' };
    const { check } = checkAnswering(answer(PENDING), answer(PENDING), answer(failed));
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toEqual({ status: failed });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('keeps polling after transient failures', async () => {
    const { check } = checkAnswering(
      fail(new ApiError('network_error')),
      fail(new ApiError('storage_unavailable', 503)),
      answer(DONE),
    );
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(await outcome).toEqual({ status: DONE });
  });

  it.each([
    ['not_found', new ApiError('not_found', 404)],
    ['invalid_response', new ApiError('invalid_response', 200)],
    ['an unexpected error', new Error('bug')],
  ])('stops on %s', async (_name, failure) => {
    const { check } = checkAnswering(fail(failure));
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(await errorOf(outcome)).toBe(failure);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('abandons a check after 3 s and still checks at the next offset', async () => {
    const { check, times } = checkAnswering(hang, hang, answer(DONE));
    const outcome = start(check);

    // The check started at 2 s hangs and is abandoned at 5 s.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(times).toEqual([2_000]);
    expect(check.mock.calls[0]![0].aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(check.mock.calls[0]![0].aborted).toBe(true);
    // The 4 s offset has passed, so its check starts at once and is bounded again (until 8 s).
    expect(times).toEqual([2_000, 5_000]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(times).toEqual([2_000, 5_000, 8_000]);
    expect(await outcome).toEqual({ status: DONE });
  });

  it('bounds the last check by the 30 s timeout', async () => {
    const { check } = checkAnswering(
      answer(PENDING),
      answer(PENDING),
      answer(PENDING),
      answer(PENDING),
      hang,
    );
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(check.mock.calls[4]![0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(check.mock.calls[4]![0].aborted).toBe(true);
    expect(await errorOf(outcome)).toBeInstanceOf(PollTimeoutError);
  });

  it('times out on schedule even if no check ever settles', async () => {
    const { check } = checkAnswering(hang, hang, hang, hang, hang);
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await errorOf(outcome)).toBeInstanceOf(PollTimeoutError);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('bounds a check that ignores its signal', async () => {
    // `hang` never looks at the signal: the bound must not depend on the check honoring it.
    const { check } = checkAnswering(hang, answer(DONE));
    const outcome = start(check);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await outcome).toEqual({ status: DONE });
  });

  it('rejects with the abort reason while waiting, without further checks', async () => {
    const controller = new AbortController();
    const { check } = checkAnswering();
    const outcome = start(check, controller.signal);

    await vi.advanceTimersByTimeAsync(2_500);
    const reason = new Error('cancelled');
    controller.abort(reason);

    expect(await errorOf(outcome)).toBe(reason);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('aborts a running check together with polling', async () => {
    const controller = new AbortController();
    const { check } = checkAnswering(hang);
    const outcome = start(check, controller.signal);

    await vi.advanceTimersByTimeAsync(2_000);
    const reason = new Error('cancelled');
    controller.abort(reason);

    expect(await errorOf(outcome)).toBe(reason);
    expect(check.mock.calls[0]![0].aborted).toBe(true);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const { check } = checkAnswering();

    expect(await errorOf(start(check, controller.signal))).toBe(reason);
    expect(check).not.toHaveBeenCalled();
  });
});
