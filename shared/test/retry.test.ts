import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RETRY_DELAYS_MS, retryWithBackoff } from '../src/retry.js';

afterEach(() => vi.useRealTimers());

function fakeSleep() {
  return vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
}

describe('retryWithBackoff', () => {
  it('returns the first successful result without waiting', async () => {
    const sleep = fakeSleep();

    await expect(retryWithBackoff(() => Promise.resolve('ok'), { sleep })).resolves.toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries after each failure with the configured delays', async () => {
    const sleep = fakeSleep();
    const onRetry = vi.fn();
    const failures = [new Error('first'), new Error('second')];
    const operation = vi.fn(() => {
      const failure = failures.shift();
      return failure ? Promise.reject(failure) : Promise.resolve('connected');
    });

    const result = await retryWithBackoff(operation, { delaysMs: [10, 20, 30], onRetry, sleep });

    expect(result).toBe('connected');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(onRetry.mock.calls).toEqual([
      [new Error('first'), 1, 10],
      [new Error('second'), 2, 20],
    ]);
  });

  it('rethrows the last error once the delays run out', async () => {
    const sleep = fakeSleep();
    let attempt = 0;
    const operation = () => Promise.reject(new Error(`attempt ${++attempt}`));

    await expect(retryWithBackoff(operation, { delaysMs: [1, 1], sleep })).rejects.toThrow(
      'attempt 3',
    );
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('makes a single attempt when there are no delays', async () => {
    const operation = vi.fn(() => Promise.reject(new Error('down')));

    await expect(retryWithBackoff(operation, { delaysMs: [] })).rejects.toThrow('down');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('uses an exponential default schedule', async () => {
    const sleep = fakeSleep();

    await expect(
      retryWithBackoff(() => Promise.reject(new Error('down')), { sleep }),
    ).rejects.toThrow('down');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...DEFAULT_RETRY_DELAYS_MS]);
  });

  it('waits for real with the default sleep', async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('up');

    const result = retryWithBackoff(operation, { delaysMs: [1_000] });
    await vi.advanceTimersByTimeAsync(999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('up');
  });
});
