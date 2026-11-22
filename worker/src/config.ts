import { z } from 'zod';

import { DEFAULT_OPENAI_MODEL } from './analysis/analyzer.js';

const flag = z
  .enum(['0', '1'])
  .default('0')
  .transform((value) => value === '1');

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const configSchema = z
  .object({
    MONGO_URI: z.string().min(1),
    RABBIT_URL: z.string().min(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** `1`: deterministic description instead of OpenAI (local runs, end-to-end tests). */
    OPENAI_MOCK: flag,
    OPENAI_API_KEY: optionalText,
    OPENAI_MODEL: z.string().min(1).default(DEFAULT_OPENAI_MODEL),
    /** `1` only for end-to-end tests: enables `E2E_ALLOWED_HOSTS`. */
    E2E_MODE: flag,
    /** Comma-separated fixture hosts allowed to resolve to non-public addresses. */
    E2E_ALLOWED_HOSTS: optionalText,
  })
  .superRefine((env, context) => {
    if (!env.OPENAI_MOCK && !env.OPENAI_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'required unless OPENAI_MOCK=1',
      });
    }
    // An SSRF exception must never be switched on by a stray variable.
    if (!env.E2E_MODE && env.E2E_ALLOWED_HOSTS) {
      context.addIssue({
        code: 'custom',
        path: ['E2E_ALLOWED_HOSTS'],
        message: 'only allowed with E2E_MODE=1',
      });
    }
  });

export interface WorkerConfig {
  MONGO_URI: string;
  RABBIT_URL: string;
  LOG_LEVEL: z.infer<typeof configSchema>['LOG_LEVEL'];
  /** Set when OpenAI is used; `undefined` means the mock analyzer. */
  openAi: { apiKey: string; model: string } | undefined;
  /** Hosts exempted from the public-address check (end-to-end fixtures only). */
  allowedHosts: ReadonlySet<string>;
}

/** Reads the worker configuration from the environment; throws listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid worker configuration: ${problems.join('; ')}`);
  }
  const { data } = result;
  return {
    MONGO_URI: data.MONGO_URI,
    RABBIT_URL: data.RABBIT_URL,
    LOG_LEVEL: data.LOG_LEVEL,
    openAi:
      data.OPENAI_MOCK || !data.OPENAI_API_KEY
        ? undefined
        : { apiKey: data.OPENAI_API_KEY, model: data.OPENAI_MODEL },
    allowedHosts: new Set(
      (data.E2E_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}
