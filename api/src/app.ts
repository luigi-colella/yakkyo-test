import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { crawlBodySchema, UrlValidationError, uidSchema } from '@crawler/shared';
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import type { CrawlService } from './crawl/crawl-service.js';
import { ServiceUnavailableError } from './crawl/errors.js';
import type { HealthCheck } from './health/health.js';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface AppDeps {
  crawlService: Pick<CrawlService, 'requestCrawl' | 'getStatus'>;
  checkHealth: HealthCheck;
  logger: Logger;
  /** Directory of the built frontend; it may not exist (e.g. in tests). */
  publicDir: string;
  /** Applies to `POST /crawl` only. */
  rateLimit?: RateLimitOptions;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { limit: 10, windowMs: 60_000 };
const JSON_BODY_LIMIT = '16kb';
/** A client-supplied request id is reused only if it is short and log-safe. */
const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;
const API_PATHS = ['/crawl', '/healthz'];

export function createApp({
  crawlService,
  checkHealth,
  logger,
  publicDir,
  rateLimit: rateLimitOptions = DEFAULT_RATE_LIMIT,
}: AppDeps): express.Express {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = requestIdFrom(req) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, error) => {
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return error ? 'error' : 'info';
      },
    }),
  );
  // Helmet's default CSP already allows `img-src 'self' data:`, which the screenshot needs.
  // `upgrade-insecure-requests` is dropped: the API serves plain HTTP, and the directive would
  // make browsers fetch the frontend's assets over HTTPS from any host other than localhost.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/healthz', async (_req, res) => {
    const health = await checkHealth();
    const healthy = health.mongo && health.rabbit;
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable', ...health });
  });

  const crawlRateLimit = rateLimit({
    ...rateLimitOptions,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });

  app.post('/crawl', crawlRateLimit, async (req, res) => {
    const body = crawlBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'invalid_url' });
      return;
    }
    res.status(202).json(await crawlService.requestCrawl(body.data.url));
  });

  app.get('/crawl/:uid', async (req, res) => {
    // A malformed uid can never match a page: skip the database.
    const uid = uidSchema.safeParse(req.params.uid);
    const status = uid.success ? await crawlService.getStatus(uid.data) : null;
    if (!status) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.set('Cache-Control', 'no-store').json(status);
  });

  app.use(express.static(publicDir));
  app.use(spaFallback(publicDir));
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler);

  return app;
}

function requestIdFrom(req: IncomingMessage): string | undefined {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : undefined;
}

/** Serves `index.html` for client-side routes, never for API paths or missing assets. */
function spaFallback(publicDir: string): RequestHandler {
  const indexFile = path.resolve(publicDir, 'index.html');
  return (req, res, next) => {
    const isApiPath = API_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`));
    if (req.method !== 'GET' || isApiPath || !req.accepts('html') || !existsSync(indexFile)) {
      next();
      return;
    }
    res.sendFile(indexFile);
  };
}

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  void _next;
  // pino-http logs the error with the request when the response finishes.
  res.err = error instanceof Error ? error : new Error(String(error));

  if (error instanceof UrlValidationError) {
    res.status(400).json({ error: error.code });
  } else if (isBodyParserError(error)) {
    // Any body that cannot yield a URL (malformed JSON, too large…) is an invalid URL.
    res.status(400).json({ error: 'invalid_url' });
  } else if (error instanceof ServiceUnavailableError) {
    res.status(503).json({ error: error.code });
  } else {
    res.status(500).json({ error: 'internal_error' });
  }
};

/** body-parser errors carry a 4xx `status` and a `type` such as `entity.parse.failed`. */
function isBodyParserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}
