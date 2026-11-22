import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/config.js';

const REQUIRED = { MONGO_URI: 'mongodb://mongo:27017/crawler', RABBIT_URL: 'amqp://rabbit:5672' };

describe('loadConfig', () => {
  it('applies defaults for optional variables', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      PORT: 8080,
      LOG_LEVEL: 'info',
      RATE_LIMIT_PER_MINUTE: 10,
    });
  });

  it('coerces numeric variables from strings', () => {
    const config = loadConfig({ ...REQUIRED, PORT: '3000', RATE_LIMIT_PER_MINUTE: '50' });

    expect(config.PORT).toBe(3000);
    expect(config.RATE_LIMIT_PER_MINUTE).toBe(50);
  });

  it('ignores unrelated environment variables', () => {
    expect(loadConfig({ ...REQUIRED, PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(/MONGO_URI.*RABBIT_URL/);
  });

  it('rejects an empty required variable', () => {
    expect(() => loadConfig({ ...REQUIRED, MONGO_URI: '' })).toThrow(/MONGO_URI/);
  });

  it.each(['0', '65536', '80.5', 'http'])('rejects PORT=%s', (port) => {
    expect(() => loadConfig({ ...REQUIRED, PORT: port })).toThrow(/PORT/);
  });

  it.each(['0', '-1', 'ten'])('rejects RATE_LIMIT_PER_MINUTE=%s', (limit) => {
    expect(() => loadConfig({ ...REQUIRED, RATE_LIMIT_PER_MINUTE: limit })).toThrow(
      /RATE_LIMIT_PER_MINUTE/,
    );
  });

  it('accepts pino log levels and rejects others', () => {
    expect(loadConfig({ ...REQUIRED, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(() => loadConfig({ ...REQUIRED, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
