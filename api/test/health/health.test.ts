import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHealthCheck, HEALTH_TIMEOUT_MS } from '../../src/health/health.js';

afterEach(() => vi.useRealTimers());

describe('createHealthCheck', () => {
  it('reports both dependencies up', async () => {
    const check = createHealthCheck({
      pingMongo: () => Promise.resolve({ ok: 1 }),
      isRabbitOpen: () => true,
    });

    await expect(check()).resolves.toEqual({ mongo: true, rabbit: true });
  });

  it('reports MongoDB down when the ping rejects', async () => {
    const check = createHealthCheck({
      pingMongo: () => Promise.reject(new Error('connection refused')),
      isRabbitOpen: () => true,
    });

    await expect(check()).resolves.toEqual({ mongo: false, rabbit: true });
  });

  it('reports MongoDB down when the ping throws synchronously', async () => {
    const check = createHealthCheck({
      pingMongo: () => {
        throw new Error('not connected');
      },
      isRabbitOpen: () => true,
    });

    await expect(check()).resolves.toEqual({ mongo: false, rabbit: true });
  });

  it('reports MongoDB down when the ping does not answer in time', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({
      pingMongo: () => new Promise(() => undefined),
      isRabbitOpen: () => true,
    });

    const result = check();
    await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ mongo: false, rabbit: true });
  });

  it('honors a custom timeout and accepts a ping that answers just before it', async () => {
    vi.useFakeTimers();
    const check = createHealthCheck({
      pingMongo: () => new Promise((resolve) => setTimeout(resolve, 499)),
      isRabbitOpen: () => true,
      timeoutMs: 500,
    });

    const result = check();
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ mongo: true, rabbit: true });
  });

  it('reports RabbitMQ down when its connection is closed', async () => {
    const check = createHealthCheck({
      pingMongo: () => Promise.resolve(),
      isRabbitOpen: () => false,
    });

    await expect(check()).resolves.toEqual({ mongo: true, rabbit: false });
  });

  it('reads the state on every call', async () => {
    let open = true;
    const pingMongo = vi.fn(() => Promise.resolve());
    const check = createHealthCheck({ pingMongo, isRabbitOpen: () => open });

    await check();
    open = false;

    await expect(check()).resolves.toEqual({ mongo: true, rabbit: false });
    expect(pingMongo).toHaveBeenCalledTimes(2);
  });
});
