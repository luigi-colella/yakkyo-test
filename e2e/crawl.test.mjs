// End-to-end tests against the Compose stack started by scripts/e2e.mjs (`yarn test:e2e`).
// The steps run in order and share state: the cache steps reuse the job of the idempotency step.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { before, describe, it } from 'node:test';
import {
  POLL_TIMEOUT_MS,
  assertApiHealthy,
  assertDone,
  createPublishTap,
  getStatus,
  requestCrawl,
  takePublishedUids,
  waitUntilSettled,
} from './helpers.mjs';

/** The pages of the fixture site (fixture-site/server.mjs) used by the scenarios. */
const SITE = 'http://fixture-site:8081';
const FIXTURE = {
  plain: `${SITE}/`,
  redirect: `${SITE}/redirect`, // 301 to /spa
  spa: `${SITE}/spa`, // rendered on the client
  busy: `${SITE}/busy`, // never network-idle
  auth: `${SITE}/auth`, // 401 basic auth
  robotsDenied: 'http://fixture-robots-denied:8081/', // same server, robots.txt forbids it
};
/** Fresh URL for the idempotency and cache steps (no earlier job may exist for it). */
const CACHE_URL = `${FIXTURE.plain}?case=cache`;

const CACHE_TTL_MS = 60_000;
/** The worker waits this long for `networkidle` before settling for `domcontentloaded`. */
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

describe('mini crawler end to end', () => {
  /** The job created by the idempotency step, reused by the cache steps. */
  let firstJob;

  before(async () => {
    await assertApiHealthy();
    await createPublishTap();
  });

  it('crawls the fixture URLs and reports each outcome', async () => {
    const cases = [
      { url: FIXTURE.plain, finalUrl: FIXTURE.plain },
      // The result describes the page the redirect lands on.
      { url: FIXTURE.redirect, finalUrl: FIXTURE.spa },
      { url: FIXTURE.robotsDenied, error: 'robots_disallowed' },
      { url: FIXTURE.auth, error: 'auth_required' },
      // Private address outside the e2e allowlist: the SSRF guard still applies.
      { url: 'http://mongo:27017/', error: 'unsafe_target' },
    ];

    const accepted = await Promise.all(cases.map(({ url }) => requestCrawl(url)));
    const statuses = await Promise.all(accepted.map(({ uid }) => waitUntilSettled(uid)));

    cases.forEach((testCase, index) => {
      const status = statuses[index];
      if ('error' in testCase) {
        assert.deepEqual(status, { status: 'error', message: testCase.error }, testCase.url);
      } else {
        assertDone(status, testCase.url);
        assert.equal(status.result.url, testCase.finalUrl, `final URL of ${testCase.url}`);
      }
    });
  });

  it('starts a single job for 3 concurrent requests of the same URL', async () => {
    await takePublishedUids();

    // Fragments are dropped by the normalization: the three requests share one URL.
    const accepted = await Promise.all(
      [CACHE_URL, `${CACHE_URL}#a`, `${CACHE_URL}#b`].map((url) => requestCrawl(url)),
    );
    assert.ok(
      accepted.every((body) => body.cached === undefined),
      'a running job is not a cache hit',
    );
    const uids = accepted.map((body) => body.uid);
    assert.equal(new Set(uids).size, 1, `expected one uid, got ${uids.join(', ')}`);
    assert.deepEqual(await takePublishedUids(), [uids[0]], 'exactly one job should be published');

    const status = await waitUntilSettled(uids[0]);
    assertDone(status, CACHE_URL);
    firstJob = { uid: uids[0], result: status.result, doneSeenAt: Date.now() };
  });

  it('returns the cached job within 60 s of completion without a new job', async () => {
    assert.ok(firstJob, 'needs the job of the previous step');
    await takePublishedUids();

    const { uid, ...rest } = await requestCrawl(CACHE_URL);
    assert.equal(uid, firstJob.uid, 'a cache hit keeps the uid');
    assert.deepEqual(rest, { cached: true }, 'a cache hit is flagged');
    assert.deepEqual(await takePublishedUids(), [], 'a cache hit publishes nothing');

    const status = await getStatus(uid);
    assert.equal(status.status, 'done', 'a cache hit is answered immediately');
    assert.equal(status.result.image, firstJob.result.image, 'no new screenshot');
    assert.equal(status.result.tookMs, firstJob.result.tookMs);
  });

  // Runs while the cache step below waits for the TTL, so it adds no time to the suite.
  it('captures a page that never goes network-idle after the 10 s fallback', async () => {
    const { uid } = await requestCrawl(FIXTURE.busy);
    const status = await waitUntilSettled(uid);

    assertDone(status, FIXTURE.busy);
    // The queue is empty here, so the wait can only come from the networkidle fallback:
    // the same page would otherwise be captured in a second or two.
    assert.ok(
      status.result.tookMs >= NETWORK_IDLE_TIMEOUT_MS,
      `tookMs ${status.result.tookMs} should include the ${NETWORK_IDLE_TIMEOUT_MS} ms wait`,
    );
  });

  it(
    'starts a new job more than 60 s after completion',
    { timeout: CACHE_TTL_MS + 2 * POLL_TIMEOUT_MS },
    async () => {
      assert.ok(firstJob, 'needs the job of the previous step');
      // The job completed before `done` was observed: this is over 60 s from `completedAt`.
      await sleep(Math.max(0, firstJob.doneSeenAt + CACHE_TTL_MS + 1_000 - Date.now()));
      await takePublishedUids();

      const accepted = await requestCrawl(CACHE_URL);
      assert.deepEqual(Object.keys(accepted), ['uid'], 'a cache miss is not flagged');
      const { uid } = accepted;
      assert.notEqual(uid, firstJob.uid, 'a cache miss gets a new uid');
      assert.deepEqual(await takePublishedUids(), [uid], 'a cache miss publishes a new job');
      assertDone(await waitUntilSettled(uid), CACHE_URL);
    },
  );
});
