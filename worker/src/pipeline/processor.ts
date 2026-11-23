import type { CrawlMessage } from '@crawler/shared';
import type { Browser, BrowserContext, Page, Route } from 'playwright';

import type { DesignAnalyzer } from '../analysis/analyzer.js';
import type { Deadline } from './deadline.js';
import {
  mostRelevantFailure,
  permanentFailure,
  toCrawlFailure,
  transientFailure,
} from './errors.js';
import type { CrawlFailure } from './errors.js';
import type { WorkerPageStore } from '../storage/page-store.js';
import { PinnedHttpProxy } from '../security/proxy.js';
import { assertRobotsAllowed } from '../security/robots.js';
import type { SafeUrlGuard } from '../security/security.js';

/** A wide desktop viewport; `fullPage` captures the whole height anyway. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;
/** How long navigation may wait for `networkidle` before settling for `domcontentloaded`. */
export const NETWORK_IDLE_TIMEOUT_MS = 10_000;
/** Upper bound for closing the browser context and the proxy after a job. */
const CLEANUP_TIMEOUT_MS = 5_000;
const JPEG_QUALITY = 50;

export interface ProcessResult {
  /** `skipped` when the job was finalized elsewhere while it was being crawled. */
  outcome: 'done' | 'skipped';
  /** Whether the page reached `networkidle`; `false` means it settled for `domcontentloaded`. */
  networkIdle: boolean;
}

interface Navigation {
  /** HTTP status of the final document, if any. */
  status: number | undefined;
  networkIdle: boolean;
}

export interface CrawlProcessorOptions {
  browser: Pick<Browser, 'newContext'>;
  guard: SafeUrlGuard;
  analyzer: DesignAnalyzer;
  store: Pick<WorkerPageStore, 'complete'>;
  viewport?: { width: number; height: number };
  networkIdleTimeoutMs?: number;
  now?: () => number;
}

/**
 * Crawls one page: SSRF and robots checks, navigation through a per-job pinned proxy,
 * full-page JPEG screenshot, design analysis and persistence. Every failure is thrown as a
 * `CrawlFailure`; the caller decides between retry and final error.
 */
export class CrawlProcessor {
  private readonly browser: Pick<Browser, 'newContext'>;
  private readonly guard: SafeUrlGuard;
  private readonly analyzer: DesignAnalyzer;
  private readonly store: Pick<WorkerPageStore, 'complete'>;
  private readonly viewport: { width: number; height: number };
  private readonly networkIdleTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: CrawlProcessorOptions) {
    this.browser = options.browser;
    this.guard = options.guard;
    this.analyzer = options.analyzer;
    this.store = options.store;
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.networkIdleTimeoutMs = options.networkIdleTimeoutMs ?? NETWORK_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async process(message: CrawlMessage, deadline: Deadline): Promise<ProcessResult> {
    try {
      return await this.crawl(message, deadline);
    } catch (error: unknown) {
      throw toCrawlFailure(error);
    }
  }

  private async crawl(
    { uid, url, requestedAt }: CrawlMessage,
    deadline: Deadline,
  ): Promise<ProcessResult> {
    const job = new CrawlJob(this.guard, deadline);
    // Refuse early, before a browser context is even created.
    await job.assertNavigationAllowed(url);

    const proxy = new PinnedHttpProxy(this.guard, deadline);
    let context: BrowserContext | undefined;
    try {
      const proxyServer = await proxy.start();
      context = await deadline.run(
        this.browser.newContext({
          // `<-loopback>` removes Chromium's implicit proxy bypass for localhost.
          proxy: { server: proxyServer, bypass: '<-loopback>' },
          viewport: this.viewport,
          serviceWorkers: 'block',
          acceptDownloads: false,
        }),
      );
      await deadline.run(context.route('**/*', (route) => job.screen(route)));
      const page = await deadline.run(context.newPage());

      let navigation: Navigation;
      try {
        navigation = await this.navigate(page, url, deadline);
      } catch (error: unknown) {
        throw explainNavigationError(error, job.navigationFailure, proxy.failure);
      }
      job.assertNoNavigationFailure();
      // Playwright does not route redirect hops: the proxy has validated their address, but
      // the final URL is checked here (guard and robots.txt of its origin) before its status,
      // because a refused plain-HTTP hop reaches Chromium as the proxy's 403.
      const finalUrl = page.url();
      await job.assertNavigationAllowed(finalUrl);
      const statusFailure = httpStatusFailure(navigation.status);
      if (statusFailure) throw statusFailure;

      const image = await page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality: JPEG_QUALITY,
        timeout: deadline.remaining(),
      });
      job.assertNoNavigationFailure();
      const userAgent = await deadline.run(page.evaluate<string>('navigator.userAgent'));

      const description = await deadline.run(this.analyzer.analyze(image, deadline.signal));
      const stored = await deadline.run(
        this.store.complete(uid, {
          description,
          finalUrl,
          image,
          // What the user waited: queue time and earlier attempts included.
          tookMs: Math.max(0, this.now() - Date.parse(requestedAt)),
          meta: {
            viewport: { w: this.viewport.width, h: this.viewport.height },
            userAgent,
            timestamp: new Date(this.now()),
          },
        }),
      );
      return { outcome: stored ? 'done' : 'skipped', networkIdle: navigation.networkIdle };
    } finally {
      if (context) await settleWithin(context.close(), CLEANUP_TIMEOUT_MS);
      await settleWithin(proxy.stop(), CLEANUP_TIMEOUT_MS);
    }
  }

  /**
   * Waits for `networkidle` for at most `networkIdleTimeoutMs` from the start of the
   * navigation, then settles for `domcontentloaded` (pages that never stop polling).
   */
  private async navigate(page: Page, url: string, deadline: Deadline): Promise<Navigation> {
    const startedAt = Date.now();
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: deadline.remaining(),
    });
    const idleBudgetMs = this.networkIdleTimeoutMs - (Date.now() - startedAt);
    let networkIdle = false;
    if (idleBudgetMs > 0) {
      try {
        await page.waitForLoadState('networkidle', { timeout: deadline.cap(idleBudgetMs) });
        networkIdle = true;
      } catch (error: unknown) {
        if (!(error instanceof Error && error.name === 'TimeoutError')) throw error;
      }
    }
    return { status: response?.status(), networkIdle };
  }
}

/** Per-job state: robots answers memoized by origin and the failure of a refused navigation. */
class CrawlJob {
  private readonly robotsChecks = new Map<string, Promise<void>>();
  /** Why a main-frame navigation was refused; Chromium itself only reports a blocked request. */
  navigationFailure: CrawlFailure | undefined;

  constructor(
    private readonly guard: SafeUrlGuard,
    private readonly deadline: Deadline,
  ) {}

  /** SSRF guard, then robots.txt of the URL's origin (fetched once per origin). */
  async assertNavigationAllowed(url: string): Promise<void> {
    await this.guard.resolveTarget(url, this.deadline);
    const { origin } = new URL(url);
    let check = this.robotsChecks.get(origin);
    if (!check) {
      check = assertRobotsAllowed(url, { guard: this.guard, deadline: this.deadline });
      this.robotsChecks.set(origin, check);
    }
    await check;
  }

  assertNoNavigationFailure(): void {
    if (this.navigationFailure) throw this.navigationFailure;
  }

  /**
   * Validates every request of the page. A refused sub-resource is only blocked; a refused
   * main-frame navigation (the page or one of its redirects) also decides the job's failure.
   */
  async screen(route: Route): Promise<void> {
    const request = route.request();
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      await route.continue().catch(() => undefined);
      return;
    }

    const mainFrameNavigation =
      request.isNavigationRequest() && request.frame().parentFrame() === null;
    try {
      if (mainFrameNavigation) await this.assertNavigationAllowed(url);
      else await this.guard.resolveTarget(url, this.deadline);
    } catch (error: unknown) {
      if (mainFrameNavigation) {
        this.navigationFailure = mostRelevantFailure(this.navigationFailure, toCrawlFailure(error));
      }
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    // The page may have been closed meanwhile.
    await route.continue().catch(() => undefined);
  }
}

/**
 * The failure behind a navigation error. A refused navigation explains it best; then a
 * specific browser error (TLS, timeout); then what the proxy met, because Chromium reports
 * proxy refusals and unreachable hosts only as a generic tunnel error.
 */
export function explainNavigationError(
  error: unknown,
  navigationFailure: CrawlFailure | undefined,
  proxyFailure: CrawlFailure | undefined,
): CrawlFailure {
  if (navigationFailure) return navigationFailure;
  const failure = toCrawlFailure(error);
  if (failure.code !== 'crawl_failed') return failure;
  return proxyFailure ?? transientFailure('navigation_failed', error);
}

/**
 * Maps the final document's HTTP status: 401/407 → `auth_required`, other 4xx permanent,
 * 5xx transient. No status at all (e.g. no document) is a transient navigation failure.
 */
export function httpStatusFailure(status: number | undefined): CrawlFailure | undefined {
  if (status === undefined) return transientFailure('navigation_failed');
  if (status === 401 || status === 407) return permanentFailure('auth_required');
  if (status >= 500) return transientFailure(`http_${status}`);
  if (status >= 400) return permanentFailure(`http_${status}`);
  return undefined;
}

/** Waits for `operation` at most `timeoutMs`, ignoring its outcome (cleanup steps). */
async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
