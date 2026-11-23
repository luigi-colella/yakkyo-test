import type { CrawlStatusResponse } from '@crawler/shared/contracts';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Api from '../src/services/api.js';
import { ApiError, createCrawl, getCrawlStatus } from '../src/services/api.js';
import App from '../src/App.vue';
import { describeError } from '../src/utils/error-messages.js';

vi.mock('../src/services/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  createCrawl: vi.fn(),
  getCrawlStatus: vi.fn(),
}));

const UID = '01JD4V1H3Q7X9Z8Y6W5V4T3S2R';
const DONE: CrawlStatusResponse = {
  status: 'done',
  result: {
    url: 'https://example.com/',
    description: '## Layout\n\nTwo **columns**.',
    image: 'data:image/jpeg;base64,/9j/',
    tookMs: 4321,
  },
};

let wrapper: VueWrapper;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(createCrawl).mockResolvedValue({ uid: UID });
  vi.mocked(getCrawlStatus).mockResolvedValue({ status: 'pending' });
  wrapper = mount(App);
});

afterEach(() => {
  wrapper.unmount();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const input = () => wrapper.get<HTMLInputElement>('input#url');
const crawlButton = () => wrapper.get<HTMLButtonElement>('button[type="submit"]');

async function crawl(url: string): Promise<void> {
  await input().setValue(url);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

describe('App', () => {
  it('validates the URL while typing', async () => {
    expect(wrapper.find('#url-error').exists()).toBe(false);
    expect(crawlButton().element.disabled).toBe(true);

    await input().setValue('example.com');
    expect(wrapper.get('#url-error').text()).toContain('URL completo');
    expect(input().attributes('aria-invalid')).toBe('true');
    expect(crawlButton().element.disabled).toBe(true);

    await input().setValue('ftp://example.com');
    expect(wrapper.get('#url-error').text()).toContain('http:// e https://');

    await input().setValue('https://example.com');
    expect(wrapper.find('#url-error').exists()).toBe(false);
    expect(crawlButton().element.disabled).toBe(false);
  });

  it('does not submit an invalid URL', async () => {
    await crawl('not a url');

    expect(createCrawl).not.toHaveBeenCalled();
    expect(wrapper.find('.loader').exists()).toBe(false);
  });

  it('blocks the page while crawling and shows the result', async () => {
    vi.mocked(getCrawlStatus).mockResolvedValueOnce({ status: 'pending' }).mockResolvedValue(DONE);

    await crawl('  https://example.com  ');

    expect(createCrawl).toHaveBeenCalledWith('https://example.com', expect.any(AbortSignal));
    expect(wrapper.get('.loader').attributes('role')).toBe('status');
    expect(input().element.disabled).toBe(true);
    expect(crawlButton().element.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);

    expect(getCrawlStatus).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.loader').exists()).toBe(false);
    expect(wrapper.get('.screenshot img').attributes('src')).toBe('data:image/jpeg;base64,/9j/');
    const description = wrapper.get('.description');
    expect(description.find('h2').text()).toBe('Layout');
    expect(description.find('strong').text()).toBe('columns');
    expect(wrapper.get('.meta').text()).toContain('4.3 s');
    expect(input().element.disabled).toBe(false);
  });

  it('shows a cache hit at once', async () => {
    vi.mocked(createCrawl).mockResolvedValue({ uid: UID, cached: true });
    vi.mocked(getCrawlStatus).mockResolvedValue(DONE);

    await crawl('https://example.com');

    expect(getCrawlStatus).toHaveBeenCalledOnce();
    expect(wrapper.find('.loader').exists()).toBe(false);
    expect(wrapper.get('.screenshot img').attributes('src')).toBe('data:image/jpeg;base64,/9j/');
  });

  it('waits for the first poll for a new job', async () => {
    vi.mocked(getCrawlStatus).mockResolvedValue(DONE);

    await crawl('https://example.com');

    expect(getCrawlStatus).not.toHaveBeenCalled();
    expect(wrapper.find('.loader').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getCrawlStatus).toHaveBeenCalledOnce();
    expect(wrapper.find('.screenshot').exists()).toBe(true);
  });

  it('shows a readable error and retries the same URL', async () => {
    vi.mocked(getCrawlStatus).mockResolvedValue({ status: 'error', message: 'robots_disallowed' });

    await crawl('https://example.com/denied');
    await vi.advanceTimersByTimeAsync(2_000);

    const error = wrapper.get('.error');
    expect(error.attributes('role')).toBe('alert');
    expect(error.text()).toContain(describeError('robots_disallowed'));

    vi.mocked(getCrawlStatus).mockResolvedValue(DONE);
    await error.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.loader').exists()).toBe(true);
    expect(createCrawl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createCrawl).mock.calls[1]![0]).toBe('https://example.com/denied');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(wrapper.find('.error').exists()).toBe(false);
    expect(wrapper.find('.screenshot').exists()).toBe(true);
  });

  it('gives up after 30 seconds', async () => {
    await crawl('https://example.com');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(wrapper.get('.error').text()).toContain(describeError('poll_timeout'));
  });

  it('shows API errors such as the rate limit', async () => {
    vi.mocked(createCrawl).mockRejectedValue(new ApiError('rate_limited', 429));

    await crawl('https://example.com');

    expect(wrapper.get('.error').text()).toContain(describeError('rate_limited'));
  });

  it('cancels the running crawl when unmounted', async () => {
    await crawl('https://example.com');
    const signal = vi.mocked(createCrawl).mock.calls[0]![1];

    wrapper.unmount();

    expect(signal.aborted).toBe(true);
    wrapper = mount(App);
  });
});
