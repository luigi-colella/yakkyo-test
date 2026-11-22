import type { CrawlResult } from '@crawler/shared/contracts';
import { computed, readonly, shallowRef } from 'vue';

import { ApiError, createCrawl, getCrawlStatus } from '../services/api.js';
import { describeError } from '../utils/error-messages.js';
import { pollUntilSettled, PollTimeoutError } from '../services/polling.js';

export type CrawlView =
  | { name: 'idle' }
  | { name: 'submitting' }
  | { name: 'polling' }
  | { name: 'success'; result: CrawlResult }
  | { name: 'error'; message: string };

export interface CrawlDeps {
  createCrawl: typeof createCrawl;
  getCrawlStatus: typeof getCrawlStatus;
  pollUntilSettled: typeof pollUntilSettled;
  now: () => number;
}

const defaultDeps: CrawlDeps = {
  createCrawl,
  getCrawlStatus,
  pollUntilSettled,
  now: () => Date.now(),
};

/**
 * The page's state machine: idle → submitting → polling → success | error.
 * A new submission cancels the previous one, whose late results are ignored.
 */
export function useCrawl(deps: CrawlDeps = defaultDeps) {
  const view = shallowRef<CrawlView>({ name: 'idle' });
  const busy = computed(() => view.value.name === 'submitting' || view.value.name === 'polling');
  let controller: AbortController | undefined;
  let lastUrl = '';

  async function submit(url: string): Promise<void> {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    lastUrl = url;
    // The 30 s polling budget starts when the user asks, like the worker's starts at the request.
    const startedAt = deps.now();
    view.value = { name: 'submitting' };

    try {
      const uid = await deps.createCrawl(url, current.signal);
      view.value = { name: 'polling' };
      const status = await deps.pollUntilSettled(
        (signal) => deps.getCrawlStatus(uid, signal),
        current.signal,
        startedAt,
      );
      if (current.signal.aborted) return;
      view.value =
        status.status === 'done'
          ? { name: 'success', result: status.result }
          : { name: 'error', message: describeError(status.message) };
    } catch (error) {
      if (current.signal.aborted) return;
      view.value = { name: 'error', message: describeError(errorCode(error)) };
    }
  }

  /** Submits the last URL again: an unfinished job is picked up again by the API. */
  function retry(): Promise<void> {
    return submit(lastUrl);
  }

  function dispose(): void {
    controller?.abort();
  }

  return { view: readonly(view), busy, submit, retry, dispose };
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError || error instanceof PollTimeoutError) return error.code;
  return 'request_failed';
}
