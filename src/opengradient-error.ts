import { APICallError, UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { DEFAULT_HUB_SIGNUP_URL, OpenGradientError } from 'opengradient-sdk';

/**
 * Map an error thrown by the OpenGradient SDK into an AI SDK error.
 *
 * Where the cause is knowable, the mapped error is made actionable — it tells the
 * caller what to do (fund OPG, grant Permit2 allowance, provide a JSON schema)
 * rather than surfacing the raw upstream message alone. `OpenGradientError` carries
 * no URL, so a best-effort `url` is passed for `APICallError`'s required field.
 */
export function mapOpenGradientError(
  error: unknown,
  requestBodyValues: unknown,
  url = 'opengradient:tee',
): Error {
  if (error instanceof APICallError) {
    return error;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);

  if (isJsonResponseFormatRejection(rawMessage)) {
    return new UnsupportedFunctionalityError({
      functionality: 'json-response-format',
      message:
        'OpenGradient: this model rejects `response_format: json_object`. ' +
        'Provide a schema (mapped to `json_schema`) instead. ' +
        `Upstream message: ${rawMessage}`,
    });
  }

  const statusCode =
    error instanceof OpenGradientError ? error.statusCode : undefined;

  return new APICallError({
    message: actionableMessage(rawMessage, statusCode),
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

function isJsonResponseFormatRejection(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('json_object') || lower.includes('response_format');
}

function actionableMessage(
  rawMessage: string,
  statusCode: number | undefined,
): string {
  if (statusCode === 402) {
    return (
      `${rawMessage} — payment rejected. Check your OPG balance and Permit2 ` +
      'allowance on Base: call `checkOpenGradientSetup()` to diagnose, then run ' +
      '`ensureOpgApproval(account, 5, 100)` once if the allowance is 0. ' +
      `Fund OPG at ${DEFAULT_HUB_SIGNUP_URL}.`
    );
  }
  return rawMessage;
}
