# Design notes

Key decisions, trade-offs and failure modes. Configuration and commands are in the [README](README.md); the API follows the contract in the [specification](docs/spec.md), with the differences listed under _API and frontend_.

## Structure

Yarn 4 workspaces: `api`, `worker`, `web` and a small `shared` package with everything the services must agree on (page model and indexes, queue topology, message contract, URL normalization), so they cannot drift apart. Each workspace groups `src/` by responsibility, with tests in a mirrored `test/` tree. Classes receive their dependencies, so each layer is unit tested with fakes. The Dockerfiles install with `yarn workspaces focus --production`, the Yarn 4 equivalent of `yarn install --production` for one workspace. Dev tools read `shared` from its source through a custom export condition (no build step, never a stale one); Node loads the compiled `dist/`.

## Idempotency and cache

The normalized URL (WHATWG parser, punycode, fragment dropped, query kept as is) is the key. `POST /crawl` returns, in this order: a `done` job completed less than 60 s ago (TTL from `completedAt`; nothing published; flagged `cached: true`, the one addition to the `{ uid }` contract, so the page reads it at once instead of at the 2 s poll); a `pending` job created less than 5 minutes ago (older ones are marked `error: stale_job`, since a job lasts at most 30 s); otherwise a new `pending` placeholder, published with publisher confirms. URLs with credentials are rejected: the secret would end up in logs and messages and would bypass `auth_required`.

Concurrent requests are settled by MongoDB: a partial unique index allows one `pending` document per URL, so losing inserts fail with a duplicate key and their next lookup returns the winner's uid. _Trade-off:_ the checks are separate queries, not a transaction; the index protects the invariant that matters (one running crawl per URL), and the remaining races cost at most one extra crawl.

## Time budget, queue and retries

Each job has one **30-second budget measured from `requestedAt`**: queue wait, robots.txt, navigation, screenshot, OpenAI, persistence and retries all fit in it. In the worker every step runs through a `Deadline` that also caps the step limits; the frontend polls at absolute offsets (2, 4, 8, 16 s, a bounded check at 27 s) and gives up at 30 s, so the UI and the worker agree on when a job is over.

Retries use native dead-lettering: `crawl.requests` dead-letters to `crawl.dlx`, which routes to `crawl.retry`, a queue with a 2 s TTL dead-lettering back to `crawl`. A transient failure is a plain `nack` without requeue (no timers in the worker), counted through `x-death`, allowed only while fewer than 2 retries happened and the delay fits the budget. Otherwise the page is marked `error` with a stable code, a copy goes to `crawl.dead` and the message is acked. The worker consumes with prefetch 1; both services declare the same topology at startup.

_Trade-off:_ retries only help fast transient failures (HTTP 5xx, OpenAI rate limits); a navigation that times out consumes the whole budget.

## Crawl pipeline

SSRF guard and robots.txt → fresh browser context whose only route out is the job's pinned proxy → `goto` (`domcontentloaded`), then `networkidle` for up to 10 s, otherwise go ahead → final URL re-checked → HTTP status (401/407 → `auth_required`, other 4xx permanent, 5xx transient) → full-page JPEG q50 at 1440×900 → OpenAI → conditional persistence. `result.url` is the URL after redirects; `tookMs` is the time the user waited. TLS verification is never disabled: certificate errors become a permanent `tls_error`.

**robots.txt** (3 s, 512 KiB, ≤ 5 redirects): `Disallow: /` (or `/*`) for `User-agent: *` without `Allow: /` → `robots_disallowed`. Following RFC 9309 a 4xx allows the crawl; a 5xx, timeout or network error is a transient `robots_unavailable` (fail-closed).

**SSRF.** User-supplied URLs are opened from inside the Docker network, next to MongoDB and RabbitMQ. A host is refused (`unsafe_target`) if any of its addresses is not public unicast. Chromium reaches the network only through a per-job loopback proxy that connects to the very address it validated (closing DNS rebinding) and tunnels HTTPS untouched, so certificates are still verified. A route guard re-validates every request: a refused navigation fails the job, a refused sub-resource is just blocked. E2E fixtures are allowlisted only with `E2E_MODE=1`.

**Analysis.** The screenshot goes inline to the OpenAI Responses API with the specification's prompt, verbatim: `gpt-5-mini` with minimal reasoning and at most 1,000 output tokens to fit the budget, SDK retries off (the queue is the only retry policy).

_Trade-offs:_ no scrolling before the capture, so lazy images below the fold may be placeholders. Playwright does not route redirect hops: the proxy still refuses unsafe redirect targets, but a cross-origin target's robots.txt is checked only after loading it.

## Screenshot storage: GridFS

Screenshots live in the GridFS bucket `page-images`, referenced by `pages.imageRef`, not in a `Buffer` inside the document: a full-page capture of a long page can exceed MongoDB's 16 MB document limit even at quality 50, and keeping binaries out of `pages` keeps polling and idempotency queries light. _Trade-off:_ two writes instead of one. The worker uploads first, then switches the page `pending → done` conditionally, and deletes the upload if the update does not apply.

## API and frontend

Domain errors become stable codes in one Express error handler. Differences from the specification's API contract, besides `cached: true`, `stale_job`, `result.url` and `tookMs` above:

- **400 `invalid_url`** for every body that cannot yield a URL (malformed JSON, non-JSON `Content-Type`, over 16 kB, missing `url`, credentials), to stay within the contract's codes; the cause is logged with the request id.
- **429 `rate_limited`** (`RateLimit`, `Retry-After` headers), as the specification leaves the answer open: 10/min per IP, in memory, on `POST /crawl` only so polling never consumes it; bodies the JSON parser rejects are answered first and not counted.
- **503 `storage_unavailable` / `queue_unavailable`:** an outage is retryable, a bad request is not.
- **404 `{ "error": "not_found" }`**, also for a malformed uid, which cannot exist.
- **Job `message`s are stable codes** (`FailureCode` in `worker/src/pipeline/errors.ts`), e.g. `robots_disallowed` for "disallowed by robots", so the page can translate them and tests do not depend on wording.
- **`X-Request-Id`** is also a response header (reused from the request when log-safe), so clients can quote it.
- **`/healthz`** answers `{ status, mongo, rabbit }` (503 if either is down), naming the missing dependency.

`trust proxy` is off because the API is exposed directly.

The Vue page is a small state machine (`idle → submitting → polling → success | error`) in a composable tested without a browser. It validates with the same `normalizeUrl()` as the API and turns error codes into Italian text. The description is Markdown written by a model about a third-party page, so it is untrusted: it is rendered with `marked` and always sanitized with DOMPurify, with the CSP as a second line of defense.

## Deployment and tests

Multi-stage images run as an unprivileged user with production dependencies only. The worker image `mcr.microsoft.com/playwright:v1.47.0-jammy` ships Node 20.17, replaced with the build stage's Node 20 binary (Mongoose 9 needs ≥ 20.19). Compose waits for healthy MongoDB and RabbitMQ, restarts services that exit and publishes only `:8080` and `:15672`.

`yarn test:e2e` runs the real images against a fixture site, hermetically (`.env.e2e-testing`, OpenAI mocked, random ports). To prove that a cache hit publishes nothing, it binds its own queue to the `crawl` exchange and reads it through the management API: real time, unlike queue statistics.

## Failure modes

| Failure                                | Behavior                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB or RabbitMQ down at startup    | Both services retry with exponential backoff (~30 s), then exit 1 and Compose restarts them.                                                                                                              |
| MongoDB down while running (API)       | The driver reconnects; meanwhile requests answer 503 `storage_unavailable` and `/healthz` 503.                                                                                                            |
| MongoDB down while running (worker)    | The message goes through the retry queue instead of spinning; once the budget is spent it is dropped and the API later reports `stale_job`.                                                               |
| RabbitMQ connection or Chromium lost   | The service exits 1 and Compose restarts it; unacked messages are redelivered and, their job still `pending`, crawled again.                                                                              |
| Publish not confirmed within 5 s       | The new job is marked `error: queue_unavailable` and the client gets a 503, so the next request starts over instead of waiting on a lost job.                                                             |
| Worker stopped (SIGTERM)               | It stops consuming, lets the current job finish (up to 10 s) and closes; a job cut short is redelivered.                                                                                                  |
| No worker running                      | Messages wait in the queue and the UI gives up at 30 s; a returning worker fails expired jobs at once (`page_timeout`); after 5 minutes a new request replaces a still-pending job (`stale_job`).         |
| Slow or never-idle page                | `networkidle` is abandoned after 10 s (`crawl finished` logs `networkIdle: false`); past the 30 s budget the job fails with `page_timeout`.                                                               |
| Target site errors                     | Permanent (`robots_disallowed`, `auth_required`, `tls_error`, `unsafe_target`, `dns_failed`, 4xx) end the job at once; transient ones (5xx, network, `robots_unavailable`) are retried within the budget. |
| OpenAI errors                          | Rate limits and 5xx are retried through the queue within the budget; a rejected request is a permanent `analysis_failed`.                                                                                 |
| Job finalized twice (race, redelivery) | Updates apply only to `pending` pages; a losing worker deletes its uploaded screenshot.                                                                                                                   |
