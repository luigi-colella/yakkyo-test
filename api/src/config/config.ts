import { z } from 'zod';

const configSchema = z.object({
  MONGO_URI: z.string().min(1),
  RABBIT_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** `POST /crawl` requests allowed per IP per minute. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
});

export type ApiConfig = z.infer<typeof configSchema>;

/** Reads the API configuration from the environment; throws listing every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid API configuration: ${problems.join('; ')}`);
  }
  return result.data;
}
