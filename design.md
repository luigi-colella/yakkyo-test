# Design notes

Key decisions, trade-offs and failure modes. This document is kept short (1–2 pages) and is updated as the implementation evolves.

## Repository structure

Yarn 4 workspaces: `api`, `worker`, `web` and a small `shared` package that owns everything the API and the worker must agree on (Mongoose page model and indexes, RabbitMQ topology, queue message contract, URL normalization). Duplicating these definitions would let the two services drift silently. The Dockerfiles therefore install with `yarn workspaces focus --production`, the Yarn 4 equivalent of `yarn install --production` for a single workspace. Each workspace groups `src/` by responsibility, with tests in a mirrored `test/` tree.

`shared` is published to the other workspaces as compiled code (`dist/`), but its `exports` also declare a custom `@crawler/source` condition pointing at `src/index.ts`. TypeScript (and therefore ESLint) is configured with that condition and Vitest aliases the package to the same file, so lint, typecheck and tests always run against the current source without a build step. Node ignores unknown conditions, so at runtime the services load `dist/`. Each service's `tsconfig.build.json` clears the condition, so the production build is checked against the real compiled package.

## URL normalization

The API and the worker share one `normalizeUrl()`: only absolute `http`/`https` URLs are accepted (`unsupported_scheme` for any other scheme, `invalid_url` otherwise). The WHATWG URL parser already gives a canonical form (punycode host, lowercase host, no default port, resolved dot segments); the fragment is then dropped because it never reaches the server. The query string is kept as-is: reordering it could change the page. The result is the key for idempotency and caching.

URLs carrying credentials (`https://user:pass@host`) are rejected as `invalid_url`: the secret would otherwise be stored in MongoDB, written to logs and queue messages, and would let the crawler bypass basic auth, which must end in `auth_required`.

## Idempotency and cache

`POST /crawl` resolves a request to a job keyed by the normalized URL, in this order:

1. **Cache:** a `done` job completed less than 60 seconds ago (`completedAt`, strict bound) is returned as-is: same uid, nothing published, no new screenshot.
2. **Stale jobs:** `pending` jobs created 5 minutes ago or earlier are marked `error: stale_job`. With a 30-second budget per job they can only be left behind by a crash.
3. **Running job:** a remaining `pending` job is reused.
4. **New job:** a `pending` placeholder is inserted and the message is published with publisher confirms.

Concurrent requests are settled by MongoDB, not by the application: a partial unique index allows one `pending` document per URL, so the losing inserts fail with a duplicate key and their next lookup returns the winner's uid. If the publish fails (or is not confirmed within 5 seconds) the new job is marked `error: queue_unavailable` and the client gets a 503, so the next request starts over instead of waiting on a job no worker will ever see.

_Trade-off:_ the checks are separate queries rather than one transaction. The unique index keeps the important invariant (one running crawl per URL) under any interleaving; the remaining races, such as a job completing between the cache lookup and the insert, cost at most one extra crawl.

## Queue topology and retries

`crawl` (direct) routes `crawl.requests` to the queue of the same name. The queue dead-letters rejected messages to `crawl.dlx`, which routes them to `crawl.retry`: a queue with a 2-second message TTL whose own dead-letter target is `crawl` / `crawl.requests`. A transient failure is therefore retried by a plain `nack` without requeue, with no timers in the worker, and the retry count comes from the `x-death` header RabbitMQ maintains. After two retries, or on a permanent failure, the worker publishes the message to `crawl.dlx` with routing key `crawl.dead`, and the page is marked `error`. Both services declare the same topology at startup (declarations are idempotent), so start order does not matter.

The worker consumes with prefetch 1 and settles every message exactly once. A crawl that succeeds is acked. A transient failure is retried (the `nack` above) only while fewer than two retries have happened and the 2-second delay still fits in the job's budget; otherwise the page is marked `error` with the failure code, a copy of the message goes to `crawl.dead` (header `x-crawl-failure`, published with confirms, best effort because the outcome already lives in MongoDB) and the original is acked. A message that is not a valid job goes straight to `crawl.dead`; a job that is no longer `pending` (already finalized, or marked stale by the API) is acked without crawling. If MongoDB fails while the worker reads or finalizes a job, the message goes through the retry queue too, which delays it instead of spinning on a down database; once the budget is spent it is dropped and the API later reports the job as `stale_job`.

## HTTP API

The Express app is built by a factory that receives its dependencies (crawl service, health check, logger, frontend directory), so the HTTP layer is tested with supertest and fakes, without MongoDB or RabbitMQ. Domain errors become stable codes in one error handler: URL validation → 400 `invalid_url` / `unsupported_scheme`, MongoDB or RabbitMQ failures → 503 `storage_unavailable` / `queue_unavailable`, anything else → 500 `internal_error` with the details only in the logs. Every `POST /crawl` body that cannot yield a URL (malformed JSON, a body over 16 kB, a missing or non-string `url`) answers `invalid_url`, to stay within the 400 codes of the contract; the actual cause is logged. A malformed uid on `GET /crawl/:uid` is a 404 without a database query.

Each request gets an id, taken from `X-Request-Id` when it is short and log-safe or generated otherwise, echoed in the response and attached to every log line (pino, JSON). The rate limit (by default 10 requests per minute per IP, in memory) applies to `POST /crawl` only, so polling never consumes it. `trust proxy` is off because the API is exposed directly: honoring `X-Forwarded-For` would let any client pick its own rate-limit key. `GET /healthz` pings MongoDB (2-second timeout) and checks that the RabbitMQ connection is open; any other `GET` that accepts HTML falls back to the frontend's `index.html`.

Responses carry helmet's default security headers (CSP, `nosniff`, frame protection…) with one change: the CSP drops `upgrade-insecure-requests`. The API serves plain HTTP on port 8080, and the directive makes browsers request the frontend's scripts and styles over HTTPS from any host other than `localhost`, leaving a blank page. It protects nothing here: every asset is same-origin and relative, and the screenshot is a data URI. HTTPS, if ever added in front of the API, is enforced by HSTS, which helmet already sends.

## Time budget

Each crawl has a single **30-second budget measured from the request time** (`requestedAt` in the queue message). It covers waiting in the queue, the robots check, navigation, screenshot, OpenAI analysis, persistence and any retry; a retry is scheduled only if it still fits in the remaining budget. The frontend polls with exponential backoff within the same 30 seconds, so the UI and the worker never disagree about when a job is over.

In the worker the budget is a `Deadline` object: every step runs through it (or receives its abort signal) and step limits (3 s for DNS and robots.txt, 10 s for upstream connections) are capped by what is left of it. When it runs out the job fails with a transient `page_timeout`, which can no longer be retried.

_Trade-off:_ retries are only useful for fast transient failures (e.g. an HTTP 5xx or an OpenAI rate limit); a navigation that times out consumes the whole budget.

## Crawl pipeline

For each job the worker: validates the URL with the SSRF guard and reads robots.txt of its origin (answers are memoized per origin for the job); opens a fresh browser context whose only route to the network is the job's pinned proxy (see below); navigates with `waitUntil: 'domcontentloaded'`, then waits for `networkidle` until 10 seconds after the navigation started and otherwise goes ahead (pages that never stop polling); re-checks the final URL; maps the HTTP status (401/407 → `auth_required`, other 4xx permanent `http_<status>`, 5xx transient); takes a full-page JPEG at quality 50 with a 1440×900 viewport; sends it to the analyzer; and stores the result. `result.url` is the URL after redirects, and `tookMs` is measured from `requestedAt`, i.e. the time the user actually waited, queue and retries included. The context and the proxy are closed whatever happens.

_Trade-offs:_ the page is not scrolled before the capture, so images that load lazily below the fold may appear as placeholders: the specification asks for `networkidle` and a full-page capture, and scrolling would add timing paths for a cosmetic gain. Playwright does not route redirect hops, so a redirect to another origin is checked after the fact: the proxy validates its address before connecting (SSRF is never bypassed), but its robots.txt is read once the page has been fetched; the job is still refused with `robots_disallowed`.

## Screenshot storage

Screenshots are stored in **GridFS** (bucket `page-images`) and referenced from `pages.imageRef`, instead of a `Buffer` inside the page document. A full-page capture of a long, image-heavy page can exceed MongoDB's 16 MB document limit even as a quality-50 JPEG, and keeping the binary out of the page document keeps status polling and idempotency queries light.

_Trade-off:_ storing an image and updating the page are two operations. The worker uploads the image first, then conditionally switches the page from `pending` to `done`; if that update does not apply (the job was already finalized elsewhere) the upload is deleted.

## Network safety (SSRF)

The worker opens user-supplied URLs from inside the Docker network, where MongoDB, RabbitMQ and possibly cloud metadata endpoints are reachable. Every hostname is resolved and rejected (`unsafe_target`) if **any** of its addresses is not public unicast: loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges, IPv4-mapped/NAT64/6to4 forms of them, and any IPv6 outside `2000::/3`. Chromium reaches the internet only through a per-job forward proxy on loopback (HTTP `CONNECT` for HTTPS, absolute-form requests for plain HTTP) that validates each connection and opens it to the address it just validated, which closes the DNS-rebinding gap between validation and connection. HTTPS is tunnelled untouched, so Chromium still verifies the certificate against the original host name. The robots.txt request uses the same rule (its own `lookup` returns the validated address). Every request the page makes (redirects and sub-resources included) is validated again. End-to-end fixtures on the Docker network are reachable only through an explicit host allowlist, accepted only when `E2E_MODE=1`.

Chromium only reports a generic proxy error, so the proxy records the most relevant failure it met (a permanent one wins over transient ones) and the worker uses it to explain a failed crawl. Chromium never sends loopback traffic to a proxy by default; the context removes that exception (`<-loopback>`), so `localhost` is refused like any private address. Only a refused main-frame navigation (the page, a redirect, a script navigation) fails the job: a refused sub-resource, such as an image pointing at a private address, is just blocked and the page is still captured.

## robots.txt

Before crawling, the worker fetches `/robots.txt` of the page's origin (3-second limit, at most 512 KiB read, up to 5 redirects, each one validated). The page is refused with `robots_disallowed` when the rules for `User-agent: *` contain `Disallow: /` (or `/*`) and no `Allow: /`, which wins the tie in RFC 9309. Following the same RFC, a missing file (any 4xx) or too many redirects allow the crawl, while a 5xx, a timeout or a network error is a transient `robots_unavailable`: the crawl never goes ahead without knowing the rules (fail-closed), and the job is retried within its budget.

## Failure classification

Every failure ends up as a `CrawlFailure` with a stable code (stored as the page's error `message`) and a retryable flag. Permanent: `unsafe_target`, `robots_disallowed`, `auth_required`, `tls_error`, an unknown domain (`dns_failed`), HTTP 4xx (`http_<status>`), OpenAI rejecting the request (`analysis_failed` on 4xx other than 408/409/429). Transient: timeouts (`page_timeout`), DNS and network errors, robots.txt unavailable, HTTP 5xx, OpenAI rate limits, server or connection errors, and anything unexpected. Certificate and handshake errors (Node codes such as `CERT_HAS_EXPIRED`, Chromium `net::ERR_CERT_*`/`net::ERR_SSL_*`) are a permanent `tls_error`: verification is never turned off, so a retry cannot help.

## Design analysis (OpenAI)

The screenshot is sent inline (base64 data URI) to the Responses API with the specification's prompt, verbatim. The default model is `gpt-5-mini` (vision-capable and fast) with `reasoning.effort: minimal` and at most 1,000 output tokens, so the call fits in the 30-second budget; `OPENAI_MODEL` overrides it. Requests are not stored (`store: false`) and the SDK's own retries are off: transient failures are retried through the queue like any other step, so there is a single retry policy. `OPENAI_MOCK=1` replaces the client with a deterministic description for local runs and end-to-end tests. The SDK is pinned to the 6.x line because 7.x requires Node 22, while the Playwright image runs Node 20.

## Frontend

A single Vue 3 page driven by a small state machine (`idle → submitting → polling → success | error`) kept in a composable that receives the API functions, the poller and the clock, so it is tested without a browser. While a crawl runs, a full-screen loader blocks the page; a new submission or leaving the page aborts the running one, and its late answers are ignored. "Riprova" submits the same URL again: an unfinished job is picked up again thanks to the API's idempotency.

Polling uses **absolute offsets** from the moment the user submitted (2, 4, 8, 16 s, then a final check at 27 s), so a slow request never shifts the schedule, and gives up at 30 s, the same budget the worker has. Each status request is bounded (3 s, never past the 30 s mark); network errors and 5xx answers are just retried at the next offset, while a 404 or an unexpected body ends the crawl with an error.

The API and the worker report failures as stable codes; the frontend alone turns them into readable text (in Italian, the product language of the page). The design description is Markdown written by a model that looked at a third-party page, so it is untrusted: it is rendered with `marked` and always sanitized with DOMPurify before reaching the DOM (no scripts, event handlers, `javascript:` links, images or forms). The screenshot is only accepted as an inline JPEG data URI.

URL validation reuses `normalizeUrl()` from `shared` (subpath `@crawler/shared/url`), and the response types come from `@crawler/shared/contracts` as type-only imports, so the client can never accept a URL the API rejects and the bundle contains no server code. Vite resolves `shared` through the same `@crawler/source` condition as the other dev tools, so `yarn build-frontend` does not need a build of `shared`. The built files are copied into `api/public`, served by the API with a SPA fallback.

## Failure modes _(to be completed)_

- **MongoDB unreachable:** the API keeps running and the driver reconnects on its own; meanwhile requests answer 503 `storage_unavailable` and `/healthz` answers 503.
- **RabbitMQ connection lost:** nothing can be published any more, so the API shuts down with exit code 1 and Docker Compose restarts it; at startup both services are retried with exponential backoff (about 30 seconds in total) before giving up.
- **Publish not confirmed:** the new job is marked `error: queue_unavailable` and the client gets a 503 (see above).
- **Worker loses RabbitMQ or Chromium:** the worker exits with code 1 and Docker Compose restarts it; the unacked message is redelivered and, its job still being `pending`, crawled again.
- **Worker stopped (SIGTERM):** it stops consuming, lets the current job finish (up to 10 seconds) and closes; a job cut short is redelivered.
- **MongoDB unreachable from the worker:** messages wait in the retry queue until the job's budget runs out (see the queue section).
