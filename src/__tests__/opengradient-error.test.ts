import { describe, it, expect } from 'vitest';
import { APICallError, UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { OpenGradientError } from 'opengradient-sdk';
import { mapOpenGradientError } from '../opengradient-error';

const body = { model: 'anthropic/claude-haiku-4-5' };

describe('mapOpenGradientError', () => {
  it('makes a 402 payment rejection actionable and non-retryable', () => {
    const mapped = mapOpenGradientError(
      new OpenGradientError('payment required', 402),
      body,
      'https://tee',
    );

    expect(mapped).toBeInstanceOf(APICallError);
    const apiError = mapped as APICallError;
    expect(apiError.statusCode).toBe(402);
    expect(apiError.isRetryable).toBe(false);
    expect(apiError.message).toContain('checkOpenGradientSetup');
    expect(apiError.message).toContain('ensureOpgApproval');
    expect(apiError.message).toContain('hub.opengradient.ai');
  });

  it('maps a json_object rejection to UnsupportedFunctionalityError', () => {
    const mapped = mapOpenGradientError(
      new Error('Anthropic does not support response_format json_object'),
      body,
    );

    expect(mapped).toBeInstanceOf(UnsupportedFunctionalityError);
    expect(mapped.message).toContain('json_schema');
  });

  it('marks 5xx as retryable and keeps the raw message', () => {
    const mapped = mapOpenGradientError(
      new OpenGradientError('upstream exploded', 503),
      body,
    ) as APICallError;

    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped.isRetryable).toBe(true);
    expect(mapped.message).toBe('upstream exploded');
  });

  it('returns an existing APICallError unchanged', () => {
    const original = new APICallError({
      message: 'already mapped',
      url: 'https://tee',
      requestBodyValues: body,
    });

    expect(mapOpenGradientError(original, body)).toBe(original);
  });
});
