# Design notes

Key decisions, trade-offs and failure modes. This document is kept short (1–2 pages) and is updated as the implementation evolves.

## Repository structure

Yarn 4 workspaces: `api`, `worker`, `web` and a small `shared` package that owns everything the API and the worker must agree on (Mongoose page model and indexes, RabbitMQ topology, queue message contract, URL normalization). Duplicating these definitions would let the two services drift silently. The Dockerfiles therefore install with `yarn workspaces focus --production`, the Yarn 4 equivalent of `yarn install --production` for a single workspace. Each workspace groups `src/` by responsibility, with tests in a mirrored `test/` tree.

`shared` is published to the other workspaces as compiled code (`dist/`), but its `exports` also declare a custom `@crawler/source` condition pointing at `src/index.ts`. TypeScript (and therefore ESLint) is configured with that condition and Vitest aliases the package to the same file, so lint, typecheck and tests always run against the current source without a build step. Node ignores unknown conditions, so at runtime the services load `dist/`. Each service's `tsconfig.build.json` clears the condition, so the production build is checked against the real compiled package.

## URL normalization

The API and the worker share one `normalizeUrl()`: only absolute `http`/`https` URLs are accepted (`unsupported_scheme` for any other scheme, `invalid_url` otherwise). The WHATWG URL parser already gives a canonical form (punycode host, lowercase host, no default port, resolved dot segments); the fragment is then dropped because it never reaches the server. The query string is kept as-is: reordering it could change the page. The result is the key for idempotency and caching.

URLs carrying credentials (`https://user:pass@host`) are rejected as `invalid_url`: the secret would otherwise be stored in MongoDB, written to logs and queue messages, and would let the crawler bypass basic auth, which must end in `auth_required`.

## Queue topology and retries

`crawl` (direct) routes `crawl.requests` to the queue of the same name. The queue dead-letters rejected messages to `crawl.dlx`, which routes them to `crawl.retry`: a queue with a 2-second message TTL whose own dead-letter target is `crawl` / `crawl.requests`. A transient failure is therefore retried by a plain `nack` without requeue, with no timers in the worker, and the retry count comes from the `x-death` header RabbitMQ maintains. After two retries, or on a permanent failure, the worker publishes the message to `crawl.dlx` with routing key `crawl.dead`, and the page is marked `error`. Both services declare the same topology at startup (declarations are idempotent), so start order does not matter.

## Time budget

Each crawl has a single **30-second budget measured from the request time** (`requestedAt` in the queue message). It covers waiting in the queue, the robots check, navigation, screenshot, OpenAI analysis, persistence and any retry; a retry is scheduled only if it still fits in the remaining budget. The frontend polls with exponential backoff within the same 30 seconds, so the UI and the worker never disagree about when a job is over.

_Trade-off:_ retries are only useful for fast transient failures (e.g. an HTTP 5xx or an OpenAI rate limit); a navigation that times out consumes the whole budget.

## Screenshot storage

Screenshots are stored in **GridFS** (bucket `page-images`) and referenced from `pages.imageRef`, instead of a `Buffer` inside the page document. A full-page capture of a long, image-heavy page can exceed MongoDB's 16 MB document limit even as a quality-50 JPEG, and keeping the binary out of the page document keeps status polling and idempotency queries light.

_Trade-off:_ storing an image and updating the page are two operations. The worker uploads the image first, then conditionally switches the page from `pending` to `done`; if that update does not apply (the job was already finalized elsewhere) the upload is deleted.

## Network safety (SSRF)

The worker opens user-supplied URLs from inside the Docker network, where MongoDB, RabbitMQ and possibly cloud metadata endpoints are reachable. Every hostname is resolved and rejected if any address is not public unicast. Chromium reaches the internet only through a per-job HTTP CONNECT proxy that connects to the already-validated IP address, which closes the DNS-rebinding gap between validation and connection while keeping the original hostname for TLS verification. Every request the page makes (redirects and sub-resources included) is validated again.

## Failure modes _(to be completed)_
