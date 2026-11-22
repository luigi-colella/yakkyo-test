import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OPENAI_MODEL,
  DESIGN_PROMPT,
  MOCK_DESCRIPTION,
  MockDesignAnalyzer,
  OpenAiDesignAnalyzer,
  analysisFailure,
  createOpenAiAnalyzer,
} from '../../src/analysis/analyzer.js';
import type { ResponsesClient } from '../../src/analysis/analyzer.js';
import { permanentFailure, transientFailure } from '../../src/pipeline/errors.js';

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function fakeClient(create: ResponsesClient['responses']['create']): ResponsesClient {
  return { responses: { create: vi.fn(create) } };
}

function apiError(status: number): APIError {
  return APIError.generate(status, { message: `status ${status}` }, undefined, new Headers());
}

describe('MockDesignAnalyzer', () => {
  it('returns the same description for any image', async () => {
    const analyzer = new MockDesignAnalyzer();
    const signal = new AbortController().signal;
    await expect(analyzer.analyze(image, signal)).resolves.toBe(MOCK_DESCRIPTION);
    await expect(analyzer.analyze(Buffer.alloc(0), signal)).resolves.toBe(MOCK_DESCRIPTION);
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(transientFailure('page_timeout'));
    await expect(new MockDesignAnalyzer().analyze(image, controller.signal)).rejects.toMatchObject({
      code: 'page_timeout',
    });
  });
});

describe('OpenAiDesignAnalyzer', () => {
  it('sends the spec prompt and the screenshot inline to the Responses API', async () => {
    const client = fakeClient(() => Promise.resolve({ output_text: '  A clean layout.\n' }));
    const signal = new AbortController().signal;

    await expect(
      new OpenAiDesignAnalyzer(client, 'some-model').analyze(image, signal),
    ).resolves.toBe('A clean layout.');

    expect(client.responses.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'some-model',
        store: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: DESIGN_PROMPT },
              {
                type: 'input_image',
                detail: 'auto',
                image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
              },
            ],
          },
        ],
      }),
      { signal },
    );
  });

  it('uses the spec prompt verbatim', () => {
    expect(DESIGN_PROMPT).toBe(
      'Descrivi layout, gerarchia visiva, palette, tipografia, pattern UI, densità contenuti. ' +
        'Evita contenuti testuali del sito; concentrati su design e UX.',
    );
  });

  it('defaults to gpt-5-mini', async () => {
    const client = fakeClient(() => Promise.resolve({ output_text: 'ok' }));
    await new OpenAiDesignAnalyzer(client).analyze(image, new AbortController().signal);
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5-mini');
    expect(client.responses.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5-mini' }),
      expect.anything(),
    );
  });

  it('fails with a transient analysis_failed on an empty description', async () => {
    const client = fakeClient(() => Promise.resolve({ output_text: '  \n' }));
    await expect(
      new OpenAiDesignAnalyzer(client).analyze(image, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'analysis_failed', retryable: true });
  });

  it('classifies API errors', async () => {
    const client = fakeClient(() => Promise.reject(apiError(401)));
    await expect(
      new OpenAiDesignAnalyzer(client).analyze(image, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'analysis_failed', retryable: false });
  });

  it('reports the deadline, not an API error, once the signal has aborted', async () => {
    const controller = new AbortController();
    const client = fakeClient(() => {
      controller.abort(transientFailure('page_timeout'));
      return Promise.reject(new Error('Request was aborted.'));
    });
    await expect(
      new OpenAiDesignAnalyzer(client).analyze(image, controller.signal),
    ).rejects.toMatchObject({ code: 'page_timeout' });
  });

  it('builds a client with SDK retries disabled', () => {
    const analyzer = createOpenAiAnalyzer('sk-test', 'some-model');
    expect(analyzer).toBeInstanceOf(OpenAiDesignAnalyzer);
    const { client } = analyzer as unknown as { client: { maxRetries: number } };
    expect(client.maxRetries).toBe(0);
  });
});

describe('analysisFailure', () => {
  const signal = new AbortController().signal;

  it.each([400, 401, 403, 404, 422])('treats HTTP %i as permanent', (status) => {
    expect(analysisFailure(apiError(status), signal)).toMatchObject({
      code: 'analysis_failed',
      retryable: false,
    });
  });

  it.each([408, 409, 429, 500, 503])('treats HTTP %i as transient', (status) => {
    expect(analysisFailure(apiError(status), signal)).toMatchObject({
      code: 'analysis_failed',
      retryable: true,
    });
  });

  it('treats connection errors and unknown errors as transient', () => {
    expect(analysisFailure(new APIConnectionError({ message: 'reset' }), signal)).toMatchObject({
      retryable: true,
    });
    expect(analysisFailure(new APIConnectionTimeoutError(), signal)).toMatchObject({
      retryable: true,
    });
    expect(analysisFailure(new Error('boom'), signal)).toMatchObject({
      code: 'analysis_failed',
      retryable: true,
    });
  });

  it('keeps the original error as the cause', () => {
    const error = apiError(400);
    expect(analysisFailure(error, signal).cause).toBe(error);
  });

  it('returns the abort reason when the signal has aborted', () => {
    const controller = new AbortController();
    const reason = permanentFailure('unsafe_target');
    controller.abort(reason);
    expect(analysisFailure(apiError(500), controller.signal)).toBe(reason);
  });
});
