import type { ApiErrorCode } from '@palsentry/shared';

/**
 * Failure modes when talking to the Palworld REST API.
 *
 * Deliberately finer-grained than HTTP status codes: the most common problems in practice are
 * a server that is switched off and `RESTAPIEnabled=False`, neither of which produces a status
 * code at all. Callers need to tell those apart to say anything useful to the operator.
 */
export type PalworldErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'bad_request'
  | 'not_found'
  | 'server_error'
  | 'invalid_response';

/** HTTP status to report to our own clients, per failure kind. */
const UPSTREAM_STATUS: Record<PalworldErrorKind, number> = {
  unreachable: 502,
  timeout: 504,
  unauthorized: 502,
  bad_request: 400,
  not_found: 404,
  server_error: 502,
  invalid_response: 502,
};

/** Our API error code for each upstream failure kind. */
const API_CODE: Record<PalworldErrorKind, ApiErrorCode> = {
  unreachable: 'unreachable',
  timeout: 'timeout',
  unauthorized: 'palworld_error',
  bad_request: 'palworld_error',
  not_found: 'not_found',
  server_error: 'palworld_error',
  invalid_response: 'palworld_error',
};

export interface PalworldErrorOptions {
  kind: PalworldErrorKind;
  endpoint: string;
  message: string;
  /** Upstream HTTP status, when there was a response at all. */
  status?: number | null;
  /** Upstream response body, truncated — useful in the audit log. */
  body?: string | null;
  cause?: unknown;
}

export class PalworldError extends Error {
  readonly kind: PalworldErrorKind;
  readonly endpoint: string;
  readonly status: number | null;
  readonly body: string | null;

  constructor(options: PalworldErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'PalworldError';
    this.kind = options.kind;
    this.endpoint = options.endpoint;
    this.status = options.status ?? null;
    this.body = options.body ?? null;
  }

  /** Status our HTTP layer should return for this failure. */
  get httpStatus(): number {
    return UPSTREAM_STATUS[this.kind];
  }

  /** Machine-readable code our HTTP layer should return for this failure. */
  get apiCode(): ApiErrorCode {
    return API_CODE[this.kind];
  }

  /** True when the failure is plausibly transient and worth retrying by a human. */
  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'unreachable' || this.kind === 'server_error';
  }
}

/** Narrow an unknown error to a PalworldError. */
export function isPalworldError(error: unknown): error is PalworldError {
  return error instanceof PalworldError;
}

/**
 * Turn a `fetch` rejection into an actionable message.
 *
 * Node's fetch reports everything as `TypeError: fetch failed` and hides the real reason in
 * `cause.code`, so without this the operator just sees "fetch failed" and has nothing to act on.
 */
export function describeFetchFailure(error: unknown, endpoint: string): PalworldError {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return new PalworldError({
        kind: 'timeout',
        endpoint,
        message: `Timed out waiting for the Palworld server (${endpoint}). It may be overloaded or unreachable.`,
        cause: error,
      });
    }
    if (error.name === 'AbortError') {
      return new PalworldError({
        kind: 'timeout',
        endpoint,
        message: `Request to the Palworld server was aborted (${endpoint}).`,
        cause: error,
      });
    }
  }

  const code = extractErrorCode(error);

  switch (code) {
    case 'ECONNREFUSED':
      return new PalworldError({
        kind: 'unreachable',
        endpoint,
        message:
          `Connection refused by the Palworld server (${endpoint}). ` +
          `Check that the server is running and that RESTAPIEnabled=True with RESTAPIPort matching the port in PALWORLD_REST_URL.`,
        cause: error,
      });
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new PalworldError({
        kind: 'unreachable',
        endpoint,
        message: `Could not resolve the Palworld server hostname (${endpoint}). Check PALWORLD_REST_URL.`,
        cause: error,
      });
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return new PalworldError({
        kind: 'timeout',
        endpoint,
        message: `Connection to the Palworld server timed out (${endpoint}).`,
        cause: error,
      });
    case 'ECONNRESET':
      return new PalworldError({
        kind: 'unreachable',
        endpoint,
        message: `The Palworld server closed the connection unexpectedly (${endpoint}). It may be restarting.`,
        cause: error,
      });
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new PalworldError({
        kind: 'unreachable',
        endpoint,
        message: `TLS certificate validation failed for ${endpoint} (${code}).`,
        cause: error,
      });
    default:
      return new PalworldError({
        kind: 'unreachable',
        endpoint,
        message:
          `Could not reach the Palworld server (${endpoint})` +
          (code ? `: ${code}` : '') +
          '. Check PALWORLD_REST_URL and that the server is running.',
        cause: error,
      });
  }
}

/** Dig the socket-level code out of a nested `fetch failed` error. */
function extractErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return null;
}
