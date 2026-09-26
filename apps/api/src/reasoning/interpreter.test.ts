import { Agent } from '@mastra/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { cleanTender } from '../../../../tests/fixtures/tenders.js';
import { IntakeRequestSchema } from '../contracts.js';
import { MastraTenderInterpreter, resolveProviderConfiguration } from './interpreter.js';

const request = IntakeRequestSchema.parse({
  ...cleanTender,
  textSources: [
    {
      sourceId: 'synthetic-note',
      kind: 'NOTE',
      text: 'The contract ends on 2027-03-31.',
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Mastra interpreter failure classification', () => {
  it('selects OpenRouter GPT-6 Luna from provider-specific environment settings', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-openrouter-key');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('MODEL_API_KEY', '');
    vi.stubEnv('MODEL_API_BASE_URL', '');
    vi.stubEnv('MODEL_ID', '');
    vi.stubEnv('OPENROUTER_MODEL', '');

    expect(new MastraTenderInterpreter().model).toBe('openai/gpt-6-luna');
  });

  it('uses provider-neutral overrides when configured', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-openrouter-key');
    vi.stubEnv('MODEL_API_KEY', 'synthetic-custom-provider-key');
    vi.stubEnv('MODEL_API_BASE_URL', 'https://models.example.test/v1');
    vi.stubEnv('MODEL_ID', 'vendor/model-name');

    const interpreter = new MastraTenderInterpreter();
    expect(interpreter.model).toBe('vendor/model-name');
  });

  it('keeps a generic provider key with its own endpoint when OpenRouter is also configured', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-openrouter-key');
    vi.stubEnv('MODEL_API_KEY', 'synthetic-custom-key');
    vi.stubEnv('MODEL_API_BASE_URL', 'https://models.example.test/v1');
    vi.stubEnv('MODEL_ID', 'vendor/model-name');

    expect(resolveProviderConfiguration()).toMatchObject({
      apiKey: 'synthetic-custom-key',
      baseURL: 'https://models.example.test/v1',
      model: 'vendor/model-name',
    });
  });

  it('rejects a partial generic provider configuration instead of mixing providers', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-openrouter-key');
    vi.stubEnv('MODEL_API_KEY', 'synthetic-custom-key');
    vi.stubEnv('MODEL_API_BASE_URL', '');
    vi.stubEnv('MODEL_ID', '');

    expect(() => resolveProviderConfiguration()).toThrow(
      'Set MODEL_API_KEY, MODEL_API_BASE_URL, and MODEL_ID together.',
    );

    vi.stubEnv('MODEL_API_KEY', '');
    vi.stubEnv('MODEL_API_BASE_URL', 'https://models.example.test/v1');
    expect(() => resolveProviderConfiguration()).toThrow(
      'Set MODEL_API_KEY, MODEL_API_BASE_URL, and MODEL_ID together.',
    );
  });

  it('does not pair an explicit key with another provider endpoint', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-openrouter-key');
    vi.stubEnv('MODEL_API_KEY', '');
    vi.stubEnv('MODEL_API_BASE_URL', '');
    vi.stubEnv('MODEL_ID', '');

    expect(resolveProviderConfiguration({ apiKey: 'synthetic-explicit-key' })).toMatchObject({
      apiKey: 'synthetic-explicit-key',
      baseURL: undefined,
      model: 'gpt-6-luna',
    });
    expect(() =>
      resolveProviderConfiguration({ baseURL: 'https://models.example.test/v1' }),
    ).toThrow('An explicit model base URL requires an explicit API key.');
  });

  it('retries SDK network failures without an HTTP status when marked retryable', async () => {
    vi.spyOn(Agent.prototype, 'generate').mockRejectedValue(
      new Error('Mastra invocation failed', {
        cause: {
          name: 'AI_APICallError',
          isRetryable: true,
          message: 'synthetic network interruption',
        },
      }),
    );
    const interpreter = new MastraTenderInterpreter({ apiKey: 'synthetic-key' });
    await expect(interpreter.interpret(request)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      retryable: true,
    });
  });

  it('classifies Mastra schema errors as invalid model output', async () => {
    const invalid = z.object({ required: z.string() }).safeParse({});
    if (invalid.success) throw new Error('Synthetic invalid output unexpectedly passed.');
    vi.spyOn(Agent.prototype, 'generate').mockRejectedValue(
      new Error('Mastra structured output failed', { cause: invalid.error }),
    );
    const interpreter = new MastraTenderInterpreter({ apiKey: 'synthetic-key' });
    await expect(interpreter.interpret(request)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      retryable: false,
    });
  });

  it('validates the returned object after Mastra warning mode', async () => {
    const generate = vi.spyOn(Agent.prototype, 'generate').mockResolvedValue({
      object: { summary: '' },
    } as never);
    const interpreter = new MastraTenderInterpreter({ apiKey: 'synthetic-key' });
    await expect(interpreter.interpret(request)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      retryable: false,
    });
    expect((generate.mock.calls[0] as unknown[])[1]).toMatchObject({
      structuredOutput: { errorStrategy: 'warn' },
    });
  });
});
