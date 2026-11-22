# Mini Crawler

Submit a URL, get back a full-page screenshot and an AI-generated description of the page's design (layout, visual hierarchy, palette, typography, UI patterns, content density).

- **API** (Express) — validates and queues crawl requests, serves the results and the static frontend.
- **Worker** (Node + Playwright) — consumes the queue, captures the page, asks OpenAI for a design-oriented description and stores the result in MongoDB.
- **Web** (Vue 3 + TypeScript) — single page to submit a URL and follow the crawl.
- **Infrastructure** — MongoDB and RabbitMQ, everything runnable with `docker compose`.

> This README is completed incrementally. Sections marked _(coming soon)_ are filled in as the corresponding parts are implemented.

## Prerequisites

- Node.js 20+ and Yarn 4 (enable it with `corepack enable`; the exact version is pinned in `package.json`).
- Docker with Docker Compose.

## Quick start _(coming soon)_

## Configuration

Copy `.env.example` to `.env` and adjust the values. Every variable is documented in `.env.example`.

## Development

```bash
yarn install
yarn lint          # ESLint
yarn format:check  # Prettier
yarn typecheck     # TypeScript in every workspace
yarn test          # unit and integration tests
```

## API _(coming soon)_

## Design

Key decisions, trade-offs and failure modes are documented in [design.md](design.md).
