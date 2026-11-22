import { describe, expect, it } from 'vitest';

import { DEFAULT_OPENAI_MODEL } from '../src/analysis/analyzer.js';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  MONGO_URI: 'mongodb://localhost:27017/crawler',
  RABBIT_URL: 'amqp://localhost:5672',
  OPENAI_API_KEY: 'sk-test',
};

describe('loadConfig', () => {
  it('applies the defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      MONGO_URI: REQUIRED.MONGO_URI,
      RABBIT_URL: REQUIRED.RABBIT_URL,
      LOG_LEVEL: 'info',
      openAi: { apiKey: 'sk-test', model: DEFAULT_OPENAI_MODEL },
      allowedHosts: new Set(),
    });
  });

  it('reads the optional variables', () => {
    const config = loadConfig({ ...REQUIRED, LOG_LEVEL: 'debug', OPENAI_MODEL: 'gpt-5' });
    expect(config).toMatchObject({ LOG_LEVEL: 'debug', openAi: { model: 'gpt-5' } });
  });

  it('lists every invalid variable', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud', OPENAI_MOCK: 'yes' })).toThrow(
      /Invalid worker configuration: .*MONGO_URI.*RABBIT_URL.*LOG_LEVEL.*OPENAI_MOCK/,
    );
  });

  describe('OpenAI', () => {
    it('uses the mock without a key when OPENAI_MOCK=1', () => {
      const config = loadConfig({ ...REQUIRED, OPENAI_API_KEY: undefined, OPENAI_MOCK: '1' });
      expect(config.openAi).toBeUndefined();
    });

    it('ignores the key when OPENAI_MOCK=1', () => {
      expect(loadConfig({ ...REQUIRED, OPENAI_MOCK: '1' }).openAi).toBeUndefined();
    });

    it.each([undefined, '', '   '])('requires a key unless mocked (key %j)', (key) => {
      expect(() => loadConfig({ ...REQUIRED, OPENAI_API_KEY: key, OPENAI_MOCK: '0' })).toThrow(
        'OPENAI_API_KEY: required unless OPENAI_MOCK=1',
      );
    });
  });

  describe('end-to-end allowlist', () => {
    it('parses a comma-separated, case-insensitive host list in E2E mode', () => {
      const config = loadConfig({
        ...REQUIRED,
        E2E_MODE: '1',
        E2E_ALLOWED_HOSTS: ' Fixture-OK ,fixture-robots,, ',
      });
      expect(config.allowedHosts).toEqual(new Set(['fixture-ok', 'fixture-robots']));
    });

    it('allows E2E mode without hosts', () => {
      expect(loadConfig({ ...REQUIRED, E2E_MODE: '1' }).allowedHosts.size).toBe(0);
    });

    it.each([undefined, '0'])('rejects hosts unless E2E_MODE=1 (E2E_MODE %j)', (mode) => {
      expect(() =>
        loadConfig({ ...REQUIRED, E2E_MODE: mode, E2E_ALLOWED_HOSTS: 'fixture-ok' }),
      ).toThrow('E2E_ALLOWED_HOSTS: only allowed with E2E_MODE=1');
    });

    it('accepts an empty host list outside E2E mode', () => {
      expect(loadConfig({ ...REQUIRED, E2E_ALLOWED_HOSTS: '' }).allowedHosts.size).toBe(0);
    });
  });
});
