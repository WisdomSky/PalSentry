import type { ApiErrorBody, ApiErrorCode } from '@palsentry/shared';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { PalworldError } from '../palworld/errors.js';

/** An error with an intended HTTP status and machine-readable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string> | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  static unauthorized(message = 'Sign in to continue.'): HttpError {
    return new HttpError(401, 'unauthorized', message);
  }

  static forbidden(message: string): HttpError {
    return new HttpError(403, 'forbidden', message);
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, 'not_found', message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, 'conflict', message);
  }
}

/** Build the standard error envelope. */
export function errorBody(
  code: ApiErrorCode,
  message: string,
  extra: Omit<ApiErrorBody['error'], 'code' | 'message'> = {},
): ApiErrorBody {
  return { error: { code, message, ...extra } };
}

/**
 * Validate a request body, converting zod issues into a 400 with per-field messages.
 *
 * Only the first issue per field is kept: a wall of messages for one input reads worse than one
 * clear sentence.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!(key in fields)) fields[key] = issue.message;
  }

  throw new HttpError(400, 'validation', 'The request body is invalid.', fields);
}

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  /** True when the caller should log this at error level (i.e. it is our bug). */
  unexpected: boolean;
}

/**
 * Map any thrown value to a response.
 *
 * Upstream Palworld failures keep their own status mapping so the UI can distinguish
 * "your server is off" (502) from "you sent something wrong" (400) from "your server took too
 * long" (504).
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof PalworldError) {
    return {
      status: error.httpStatus,
      body: errorBody(error.apiCode, error.message, {
        ...(error.status === null ? {} : { upstreamStatus: error.status }),
      }),
      unexpected: false,
    };
  }

  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: errorBody(
        error.code,
        error.message,
        error.fields === undefined ? {} : { fields: error.fields },
      ),
      unexpected: false,
    };
  }

  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.map(String).join('.') || '_';
      if (!(key in fields)) fields[key] = issue.message;
    }
    return {
      status: 400,
      body: errorBody('validation', 'The request body is invalid.', { fields }),
      unexpected: false,
    };
  }

  // Fastify's own errors (body parse failures, payload too large) carry a statusCode.
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const rawMessage = (error as Record<string, unknown>).message;
      const message = typeof rawMessage === 'string' ? rawMessage : 'Bad request.';
      return {
        status: statusCode,
        body: errorBody(statusCode === 429 ? 'rate_limited' : 'validation', message),
        unexpected: false,
      };
    }
  }

  return {
    status: 500,
    body: errorBody('internal', 'An unexpected internal error occurred.'),
    unexpected: true,
  };
}

/**
 * Condense an error into the flat shape the status/players endpoints return.
 *
 * Those two endpoints answer `200` with `online: false` rather than propagating a 502, because
 * "the game server is switched off" is a normal state the dashboard must render, not a failure
 * of the dashboard itself.
 */
export function toStatusError(error: unknown): { code: ApiErrorCode; message: string } {
  const response = toErrorResponse(error);
  return { code: response.body.error.code, message: response.body.error.message };
}
