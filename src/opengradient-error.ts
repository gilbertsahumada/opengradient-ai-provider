import { APICallError } from '@ai-sdk/provider';
import { OpenGradientError } from 'opengradient-sdk';

/**
 * Map an error thrown by the OpenGradient SDK into an AI SDK error.
 *
 * Basic mapping for Phase 2 — finalized (retry classification, Anthropic
 * json_object rejection, etc.) in Phase 5. `OpenGradientError` carries no URL,
 * so a best-effort `url` is passed for `APICallError`'s required field.
 */
export function mapOpenGradientError(
  error: unknown,
  requestBodyValues: unknown,
  url = 'opengradient:tee',
): Error {
  if (error instanceof APICallError) {
    return error;
  }

  const statusCode =
    error instanceof OpenGradientError ? error.statusCode : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return new APICallError({
    message,
    url,
    requestBodyValues,
    statusCode,
    isRetryable:
      statusCode != null &&
      (statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 429 ||
        statusCode >= 500),
    cause: error,
  });
}
