import type {
  ActionResponse,
  AnnounceRequest,
  AuditQuery,
  AuditResponse,
  BanRequest,
  BansResponse,
  BasesResponse,
  HealthResponse,
  HistoryResponse,
  HistorySelection,
  KickRequest,
  LoginRequest,
  MeResponse,
  MetaResponse,
  PlayersResponse,
  RestartRequest,
  RestartStatusResponse,
  SettingsResponse,
  ShutdownRequest,
  StatusResponse,
  UnbanRequest,
} from '@palsentry/shared';

/** An error returned by the Palsentry API, carrying the machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;
  readonly upstreamStatus: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { fields?: Record<string, string>; upstreamStatus?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = options.fields;
    this.upstreamStatus = options.upstreamStatus;
  }

  /** True when the session is missing or expired. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** True when the action exists but is switched off by configuration. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

function isErrorEnvelope(value: unknown): value is {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    upstreamStatus?: number;
  };
} {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value as { error?: unknown };
  return typeof error === 'object' && error !== null && 'message' in error;
}

/** Called whenever a request comes back 401, so the app can bounce to the login screen. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      // Same-origin in both dev (Vite proxies /api) and production (one container).
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        // The server requires a JSON content type on mutations as a CSRF defence, so it must be
        // set on every request that carries a body.
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    // A network-level failure: the Palsentry server itself is unreachable.
    throw new ApiError(
      0,
      'unreachable',
      'Could not reach the Palsentry server. Check that the container is running.',
      { ...(error === undefined ? {} : {}) },
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      // A non-JSON body means something other than our API answered (a proxy error page, say).
      if (!response.ok) {
        throw new ApiError(
          response.status,
          'internal',
          `Unexpected non-JSON response (HTTP ${response.status}).`,
        );
      }
      throw new ApiError(response.status, 'internal', 'The server returned a malformed response.');
    }
  }

  if (!response.ok) {
    if (response.status === 401) onUnauthorized?.();

    if (isErrorEnvelope(payload)) {
      throw new ApiError(response.status, payload.error.code, payload.error.message, {
        ...(payload.error.fields === undefined ? {} : { fields: payload.error.fields }),
        ...(payload.error.upstreamStatus === undefined
          ? {}
          : { upstreamStatus: payload.error.upstreamStatus }),
      });
    }

    throw new ApiError(response.status, 'internal', `Request failed with HTTP ${response.status}.`);
  }

  return payload as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    ...(body === undefined ? { body: JSON.stringify({}) } : { body: JSON.stringify(body) }),
  });
}

/** Typed wrappers for every endpoint the UI uses. */
export const api = {
  health: () => request<HealthResponse>('/health'),

  me: () => request<MeResponse>('/auth/me'),
  login: (body: LoginRequest) => post<MeResponse>('/auth/login', body),
  logout: () => post<MeResponse>('/auth/logout'),

  meta: () => request<MetaResponse>('/meta'),
  status: () => request<StatusResponse>('/status'),
  players: () => request<PlayersResponse>('/players'),
  bases: (refresh = false) => request<BasesResponse>(`/bases${refresh ? '?refresh=true' : ''}`),
  settings: () => request<SettingsResponse>('/settings'),
  history: (selection: HistorySelection) => {
    const search = new URLSearchParams();
    if (selection.kind === 'window') {
      search.set('window', selection.window);
    } else {
      // The server validates these as whole Unix seconds, so no ISO formatting round-trip here.
      search.set('from', String(selection.from));
      search.set('to', String(selection.to));
    }
    return request<HistoryResponse>(`/history?${search.toString()}`);
  },

  bans: () => request<BansResponse>('/bans'),
  deleteBan: (id: number) => request<void>(`/bans/${id}`, { method: 'DELETE' }),

  audit: (query: AuditQuery = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const suffix = search.toString();
    return request<AuditResponse>(`/audit${suffix === '' ? '' : `?${suffix}`}`);
  },

  announce: (body: AnnounceRequest) => post<ActionResponse>('/actions/announce', body),
  save: () => post<ActionResponse>('/actions/save'),
  kick: (body: KickRequest) => post<ActionResponse>('/actions/kick', body),
  ban: (body: BanRequest) => post<ActionResponse>('/actions/ban', body),
  unban: (body: UnbanRequest) => post<ActionResponse>('/actions/unban', body),
  shutdown: (body: ShutdownRequest) => post<ActionResponse>('/actions/shutdown', body),
  stop: () => post<ActionResponse>('/actions/stop'),

  restart: (body: RestartRequest = {}) => post<RestartStatusResponse>('/restart', body),
  restartStatus: () => request<RestartStatusResponse>('/restart/status'),
};

/** Human-readable message from any thrown value, for toasts. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.fields !== undefined) {
      // Field errors carry the useful detail; the top-level message is generic.
      const details = Object.values(error.fields).join(' ');
      if (details !== '') return details;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
