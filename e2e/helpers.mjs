// Helpers for crawl.test.mjs: the API client, job polling, result checks and the RabbitMQ
// publish tap. The URLs come from scripts/e2e.mjs, which reads them from the running stack.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const API_URL = requiredEnv('E2E_API_URL');
const RABBIT_URL = requiredEnv('E2E_RABBIT_URL');
const RABBIT_AUTH = `Basic ${Buffer.from('guest:guest').toString('base64')}`;

const POLL_INTERVAL_MS = 500;
/** Longer than the worker's 30 s budget: a job must be settled by then. */
export const POLL_TIMEOUT_MS = 45_000;

/**
 * Test-only queue bound like `crawl.requests`: it receives a copy of every crawl request
 * published on the `crawl` exchange, so the tests can count the jobs the API started.
 */
const TAP_QUEUE = 'e2e.tap';

export async function assertApiHealthy() {
  const health = await fetch(`${API_URL}/healthz`);
  assert.equal(health.status, 200, 'the API should report healthy dependencies');
}

/** `POST /crawl`: the 202 body (`{ uid }`, plus `cached: true` on a cache hit). */
export async function requestCrawl(url) {
  const response = await fetch(`${API_URL}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await response.json();
  assert.equal(response.status, 202, `POST /crawl ${url}: ${JSON.stringify(body)}`);
  assert.equal(typeof body.uid, 'string');
  return body;
}

/** `GET /crawl/:uid`: the job status. */
export async function getStatus(uid) {
  const response = await fetch(`${API_URL}/crawl/${uid}`);
  const body = await response.json();
  assert.equal(response.status, 200, `GET /crawl/${uid}: ${JSON.stringify(body)}`);
  return body;
}

/** Polls the job until it is no longer `pending` and returns its final status. */
export async function waitUntilSettled(uid) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getStatus(uid);
    if (status.status !== 'pending') return status;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`job ${uid} still pending after ${POLL_TIMEOUT_MS} ms`);
}

/** A `done` status with a JPEG screenshot, the mocked description and a duration. */
export function assertDone(status, url) {
  assert.equal(status.status, 'done', `${url}: ${JSON.stringify(status)}`);
  const { image, description, tookMs } = status.result;
  const [prefix, base64] = image.split(',');
  assert.equal(prefix, 'data:image/jpeg;base64', url);
  const jpegMagic = Buffer.from(base64, 'base64').subarray(0, 3);
  assert.deepEqual([...jpegMagic], [0xff, 0xd8, 0xff], `${url}: the image should be a JPEG`);
  assert.match(description, /^Mock design analysis:/, url);
  assert.ok(Number.isInteger(tookMs) && tookMs > 0, `${url}: tookMs ${tookMs}`);
}

export async function createPublishTap() {
  await rabbitApi('PUT', `/api/queues/%2F/${TAP_QUEUE}`, { durable: false });
  await rabbitApi('POST', `/api/bindings/%2F/e/crawl/q/${TAP_QUEUE}`, {
    routing_key: 'crawl.requests',
  });
}

/** Removes every message from the tap queue and returns the uids they carried. */
export async function takePublishedUids() {
  const messages = await rabbitApi('POST', `/api/queues/%2F/${TAP_QUEUE}/get`, {
    count: 100,
    ackmode: 'ack_requeue_false',
    encoding: 'auto',
  });
  return messages.map((message) => JSON.parse(message.payload).uid);
}

async function rabbitApi(method, path, body) {
  const response = await fetch(`${RABBIT_URL}${path}`, {
    method,
    headers: { Authorization: RABBIT_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `RabbitMQ ${method} ${path}: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the tests with "yarn test:e2e"`);
  return value;
}
