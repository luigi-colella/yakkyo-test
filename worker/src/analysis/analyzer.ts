import OpenAI, { APIError } from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

import { permanentFailure, toCrawlFailure, transientFailure } from '../pipeline/errors.js';
import type { CrawlFailure } from '../pipeline/errors.js';

/** The prompt required by the specification, kept verbatim (Italian). */
export const DESIGN_PROMPT =
  'Descrivi layout, gerarchia visiva, palette, tipografia, pattern UI, densità contenuti. ' +
  'Evita contenuti testuali del sito; concentrati su design e UX.';

/** Vision-capable and fast enough for the 30 s budget; override with `OPENAI_MODEL`. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
/** Upper bound for the description (and the model's reasoning, which shares it). */
export const MAX_OUTPUT_TOKENS = 1_000;

export const MOCK_DESCRIPTION =
  'Mock design analysis: two-column layout with a prominent header, clear visual hierarchy, ' +
  'restrained palette with one accent colour, sans-serif typography, card-based UI patterns ' +
  'and medium content density.';

/** Describes the design of a page from its screenshot. */
export interface DesignAnalyzer {
  analyze(image: Buffer, signal: AbortSignal): Promise<string>;
}

/** Deterministic analyzer for `OPENAI_MOCK=1` (local runs and end-to-end tests). */
export class MockDesignAnalyzer implements DesignAnalyzer {
  analyze(_image: Buffer, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(toCrawlFailure(signal.reason));
    return Promise.resolve(MOCK_DESCRIPTION);
  }
}

/** The part of the OpenAI client the analyzer uses. */
export interface ResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<{ output_text: string }>;
  };
}

/** Sends the screenshot inline to the OpenAI Responses API together with the design prompt. */
export class OpenAiDesignAnalyzer implements DesignAnalyzer {
  constructor(
    private readonly client: ResponsesClient,
    private readonly model: string = DEFAULT_OPENAI_MODEL,
  ) {}

  async analyze(image: Buffer, signal: AbortSignal): Promise<string> {
    let description: string;
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
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
          reasoning: { effort: 'minimal' },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
        },
        { signal },
      );
      description = response.output_text.trim();
    } catch (error: unknown) {
      throw analysisFailure(error, signal);
    }
    if (!description) throw transientFailure('analysis_failed');
    return description;
  }
}

/**
 * OpenAI client without SDK retries: transient failures are retried through the queue,
 * the only retry mechanism, within the job's budget.
 */
export function createOpenAiAnalyzer(apiKey: string, model: string): OpenAiDesignAnalyzer {
  return new OpenAiDesignAnalyzer(new OpenAI({ apiKey, maxRetries: 0 }), model);
}

/** Requests OpenAI rejects for good (bad key, unknown model, invalid image) are permanent. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 409, 429]);

export function analysisFailure(error: unknown, signal: AbortSignal): CrawlFailure {
  if (signal.aborted) return toCrawlFailure(signal.reason);
  const status: unknown = error instanceof APIError ? error.status : undefined;
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_CLIENT_STATUSES.has(status)
  ) {
    return permanentFailure('analysis_failed', error);
  }
  return transientFailure('analysis_failed', error);
}
