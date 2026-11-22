import { pino } from 'pino';
import type { Logger, LevelWithSilent } from 'pino';

export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  });
}
