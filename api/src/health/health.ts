export interface HealthStatus {
  mongo: boolean;
  rabbit: boolean;
}

export type HealthCheck = () => Promise<HealthStatus>;

export interface HealthCheckDeps {
  /** Round trip to MongoDB (e.g. the `ping` command). */
  pingMongo: () => Promise<unknown>;
  isRabbitOpen: () => boolean;
  timeoutMs?: number;
}

export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * MongoDB is pinged on every check: the driver may report a connection as
 * open for a while after the server went away. RabbitMQ needs no round trip:
 * losing it closes the connection, which the caller tracks.
 */
export function createHealthCheck({
  pingMongo,
  isRabbitOpen,
  timeoutMs = HEALTH_TIMEOUT_MS,
}: HealthCheckDeps): HealthCheck {
  return async () => ({
    mongo: await succeedsWithin(pingMongo, timeoutMs),
    rabbit: isRabbitOpen(),
  });
}

async function succeedsWithin(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const attempt = Promise.resolve()
    .then(operation)
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
