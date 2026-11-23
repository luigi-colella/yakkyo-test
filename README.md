# Mini Crawler

Submit a URL, get back a full-page screenshot and an AI-generated description of the page's design (layout, visual hierarchy, palette, typography, UI patterns, content density).

- **API** (Express) — validates and queues crawl requests, serves the results and the static frontend.
- **Worker** (Node + Playwright) — consumes the queue, captures the page, asks OpenAI for a design-oriented description and stores the result in MongoDB.
- **Web** (Vue 3 + TypeScript) — single page to submit a URL and follow the crawl.
- **Infrastructure** — MongoDB and RabbitMQ, everything runnable with `docker compose`.

![Typical flow of a crawl: the page submits a URL, the API stores a pending job and publishes it to RabbitMQ, the worker checks robots.txt, captures the page with Chromium, asks OpenAI for a design description and stores the result, the page polls until done; a second request within 60 seconds is a cache hit](docs/crawl-flow.gif)

Key decisions, trade-offs, failure modes and the differences from the specification's API contract are documented in [design.md](design.md).

## Prerequisites

- Node.js 20.19 or later.
- Yarn 4 through Corepack: run `corepack enable` once (on Windows, if it fails with `EPERM` because Node is installed under `Program Files`, use an administrator terminal or `npm install -g corepack` instead). The exact Yarn version is pinned in `package.json`.
- Docker with Docker Compose (2.24.4 or later for the end-to-end tests).

## Quick start

```bash
yarn install              # Yarn needs the workspace installed before it can run any script
cp .env.example .env      # works as is: OPENAI_MOCK=1 needs no OpenAI key
yarn build-frontend       # builds web/ and copies it into api/public
docker compose up --build # builds the images and starts API, worker, MongoDB and RabbitMQ
```

- App: <http://localhost:8080>
- RabbitMQ management UI: <http://localhost:15672>, default credentials **`guest` / `guest`**

For real design descriptions set `OPENAI_MOCK=0` and `OPENAI_API_KEY` in `.env`, then run `docker compose up` again: it recreates the services whose configuration changed (`docker compose restart` keeps the old values). `docker compose down` stops the stack; add `--volumes` to delete the MongoDB data as well.

`yarn build-frontend` must run before `docker compose up --build`: the API image copies the frontend built on the host (`api/public`, git-ignored).

## Configuration

Docker Compose passes `.env` to the API and the worker. Every variable is also documented in [`.env.example`](.env.example).

| Variable                | Used by      | Default      | Description                                                                                                          |
| ----------------------- | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`             | api, worker  | — (required) | MongoDB connection string, e.g. `mongodb://mongo:27017/crawler`.                                                     |
| `RABBIT_URL`            | api, worker  | — (required) | RabbitMQ connection string, e.g. `amqp://rabbit:5672`.                                                               |
| `PORT`                  | api, Compose | `8080`       | HTTP port of the API, also published on the host.                                                                    |
| `RATE_LIMIT_PER_MINUTE` | api          | `10`         | `POST /crawl` requests allowed per IP per minute.                                                                    |
| `LOG_LEVEL`             | api, worker  | `info`       | pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`).                                       |
| `OPENAI_MOCK`           | worker       | `0`          | `1`: deterministic description instead of calling OpenAI.                                                            |
| `OPENAI_API_KEY`        | worker       | —            | OpenAI key, required unless `OPENAI_MOCK=1`.                                                                         |
| `OPENAI_MODEL`          | worker       | `gpt-5-mini` | Vision-capable model used for the description.                                                                       |
| `E2E_MODE`              | worker       | `0`          | End-to-end tests only: `1` enables `E2E_ALLOWED_HOSTS`.                                                              |
| `E2E_ALLOWED_HOSTS`     | worker       | —            | End-to-end tests only: comma-separated hosts allowed to resolve to private addresses (refused without `E2E_MODE=1`). |

Invalid or missing variables stop the service at startup with a message listing all of them.

## Project layout

Inside each workspace, `src/` holds production code only, grouped by responsibility, and `test/` mirrors its structure (`worker/src/security/robots.ts` → `worker/test/security/robots.test.ts`).

```text
.
├── api/                     # Express API; also serves the built frontend
│   ├── src/
│   │   ├── index.ts         # composition root: config, MongoDB/RabbitMQ connections, HTTP server
│   │   ├── app.ts           # Express app: routes, rate limit, static frontend, error handler
│   │   ├── config/          # env validation (zod) and pino logger
│   │   ├── crawl/           # crawl service: cache, idempotency, page store, RabbitMQ publisher
│   │   └── health/          # dependency checks behind GET /healthz
│   ├── test/                # mirrors src/
│   └── public/              # built frontend, copied by yarn build-frontend (git-ignored)
├── worker/                  # RabbitMQ consumer that captures and describes pages
│   ├── src/
│   │   ├── index.ts         # composition root
│   │   ├── config.ts        # env validation (zod)
│   │   ├── messaging/       # queue consumer: ack, retries, dead-lettering
│   │   ├── pipeline/        # crawl job: Playwright capture, 30 s deadline, failure codes
│   │   ├── security/        # SSRF guard, IP-pinning proxy for Chromium, robots.txt
│   │   ├── analysis/        # OpenAI design description (or the mock)
│   │   └── storage/         # screenshot upload to GridFS, page result update
│   └── test/                # mirrors src/
├── web/                     # Vue 3 + TypeScript single page (Vite)
│   ├── src/
│   │   ├── main.ts          # entry point
│   │   ├── App.vue          # the page
│   │   ├── assets/          # styles
│   │   ├── composables/     # use-crawl: submit-and-poll state machine
│   │   ├── services/        # API client and status poller
│   │   └── utils/           # URL validation, error messages, Markdown rendering
│   └── test/                # mirrors src/
├── shared/                  # code the services agree on
│   ├── src/                 # contracts, page model, queue topology, retry, URL normalization (flat)
│   └── test/                # mirrors src/
├── scripts/                 # frontend copy and end-to-end orchestration
├── e2e/                     # end-to-end suite (crawl.test.mjs + helpers.mjs) and its fixture site
├── docs/                    # specification and README assets
├── docker-compose.yml       # full stack: api, worker, MongoDB, RabbitMQ
├── docker-compose.e2e.yml   # overrides for the end-to-end tests
├── Dockerfile.api           # API image
├── Dockerfile.worker        # worker image (Playwright base)
├── design.md                # decisions, trade-offs, failure modes
└── .env.example             # every configuration variable, documented
```

## Development

### First setup

```bash
yarn install
yarn setup:browser   # once per machine: Chromium for Playwright 1.47, needed by the worker tests
```

### Checks

```bash
yarn lint            # ESLint (type-aware)
yarn format:check    # Prettier (yarn format to fix)
yarn typecheck       # TypeScript in every workspace
yarn test            # unit and integration tests (Vitest)
yarn test:e2e        # end-to-end tests on the Docker stack
```

None of them needs a build first: lint, typecheck, tests and the frontend build read `shared` from its TypeScript source.

### Frontend with hot reload

Start the API on `localhost:8080` (the Compose stack is enough), then:

```bash
yarn workspace @crawler/web dev   # Vite dev server; proxies /crawl and /healthz to localhost:8080
```

### Services outside Docker

1. In `.env`, point `MONGO_URI` and `RABBIT_URL` at instances reachable from the host, e.g. `mongodb://localhost:27017/crawler` and `amqp://localhost:5672`. The Compose ones will not do: the stack does not publish MongoDB or the AMQP port.
2. Build and start the services from the repository root:

   ```bash
   yarn build-frontend                  # once: the API serves api/public
   yarn workspace @crawler/shared build
   yarn workspace @crawler/api build && node --env-file=.env api/dist/index.js
   yarn workspace @crawler/worker build && node --env-file=.env worker/dist/index.js   # needs yarn setup:browser
   ```

### Tests

#### Unit and integration: `yarn test`

Runs every `*.test.ts` under the workspaces' `test/` folders (Vitest).

- **Chromium required:** the worker's browser tests drive a real headless Chromium against a local fixture server and fail if it is missing (run `yarn setup:browser`).
- **First run is slower:** the MongoDB tests download a MongoDB 7.0 binary once.

#### End-to-end: `yarn test:e2e`

Builds the frontend, starts the real images with `docker-compose.e2e.yml` and runs `e2e/crawl.test.mjs` against them.

- **Duration:** about 2.5 minutes, one of which is the 60-second cache TTL waited for real.
- **Requirements:** Docker Compose 2.24.4 or later; no OpenAI key (the committed `.env.e2e-testing` replaces `.env` and mocks OpenAI).
- **Isolation:** random loopback ports, so it does not clash with a running stack; containers and volumes are always removed.

| Scenario                                 | Expected outcome                                       |
| ---------------------------------------- | ------------------------------------------------------ |
| Plain page                               | `done`                                                 |
| Redirect                                 | `done`, `result.url` is the final page                 |
| Page disallowed by robots.txt            | error `robots_disallowed`                              |
| Page behind basic auth                   | error `auth_required`                                  |
| Internal address                         | error `unsafe_target` (SSRF guard)                     |
| 3 concurrent requests for the same URL   | one uid, one job published                             |
| Same URL again within 60 s of completion | cache hit: same uid, `cached: true`, nothing published |
| Page that never goes network-idle        | `done` after the 10-second `networkidle` wait (\*)     |
| Same URL more than 60 s after completion | cache miss: new uid, new job published                 |

(\*) This scenario takes about 10 seconds but does not make the run longer. The last scenario has to wait for the 60-second cache to expire anyway: the network-idle scenario runs within that minute, and the suite then waits only for what is left of it.
