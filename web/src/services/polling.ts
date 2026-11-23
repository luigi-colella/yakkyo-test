import type { CrawlStatusResponse } from '@crawler/shared/contracts';

import { ApiError } from './api.js';

/**
 * Status checks happen at these offsets from the moment the user submitted the URL:
 * every 2 s with exponential backoff, then a last check that must end by the 30 s mark,
 * the same budget the worker has for the whole job.
 */
export const POLL_OFFSETS_MS = [2_000, 4_000, 8_000, 16_000, 27_000] as const;
export const POLL_TIMEOUT_MS = 30_000;
/** A single status request that takes longer than this is abandoned and retried later. */
export const CHECK_TIMEOUT_MS = 3_000;

export type SettledStatus = Exclude<CrawlStatusResponse, { status: 'pending' }>;
export type StatusCheck = (signal: AbortSignal) => Promise<CrawlStatusResponse>;

export interface PollOptions {
  /**
   * Check once right away, before the schedule: for a job already known to be settled
   * (a cache hit), so its result shows without waiting for the 2 s offset.
   */
  checkAtOnce?: boolean;
}

export class PollTimeoutError extends Error {
  readonly code = 'poll_timeout';

  constructor() {
    super('poll_timeout');
    this.name = 'PollTimeoutError';
  }
}

/**
 * Polls until the job is `done` or `error`. Offsets are absolute, so a slow check never
 * shifts the schedule. A check that hangs, or fails on the server or network side, is simply
 * repeated at the next offset; any other failure (e.g. 404) ends polling. Rejects with
 * `PollTimeoutError` at 30 s and with the abort reason as soon as `signal` aborts.
 */
export async function pollUntilSettled(
  check: StatusCheck,
  signal: AbortSignal,
  startedAt: number = Date.now(),
  { checkAtOnce = false }: PollOptions = {},
): Promise<SettledStatus> {
  const deadline = startedAt + POLL_TIMEOUT_MS;
  const offsets = checkAtOnce ? [0, ...POLL_OFFSETS_MS] : POLL_OFFSETS_MS;

  for (const offset of offsets) {
    await sleepUntil(startedAt + offset, signal);
    const status = await checkOnce(check, signal, deadline);
    if (status && status.status !== 'pending') return status;
  }

  await sleepUntil(deadline, signal);
  throw new PollTimeoutError();
}

/** One status check bounded in time; `undefined` means "try again at the next offset". */
async function checkOnce(
  check: StatusCheck,
  signal: AbortSignal,
  deadline: number,
): Promise<CrawlStatusResponse | undefined> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.min(CHECK_TIMEOUT_MS, Math.max(0, deadline - Date.now())));
  signal.addEventListener('abort', abort, { once: true });

  try {
    // Racing the abort keeps the bound even if `check` ignores its signal.
    return await Promise.race([check(controller.signal), rejectOnAbort(controller.signal)]);
  } catch (error) {
    signal.throwIfAborted();
    if (controller.signal.aborted || (error instanceof ApiError && error.transient)) {
      return undefined;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

function sleepUntil(time: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const delay = time - Date.now();
  if (delay <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
