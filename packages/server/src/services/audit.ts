import type { AuditEntry, AuditQuery, AuditResponse } from '@palsentry/shared';
import type { Db } from '../db/index.js';

/**
 * Append-only audit trail.
 *
 * Every action PalSentry performs against the Palworld API is recorded, successful or not —
 * the failures are often the interesting ones ("I pressed restart and nothing happened").
 * Rows are never updated or deleted, so the trail cannot be quietly rewritten from the UI.
 */

export interface AuditInput {
  actorName: string | null;
  actorIp: string | null;
  /** Action name, e.g. `kick`. Free-form so non-action events can be recorded too. */
  action: string;
  /** Player id, or null for server-wide actions. */
  target: string | null;
  /** Request body that was sent upstream, for debugging. */
  payload: unknown;
  /** Upstream HTTP status when there was one. */
  httpStatus: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
}

interface AuditRow {
  id: number;
  ts: string;
  actor_name: string | null;
  actor_ip: string | null;
  action: string;
  target: string | null;
  payload_json: string | null;
  http_status: number | null;
  ok: number;
  error: string | null;
  duration_ms: number | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function toEntry(row: AuditRow): AuditEntry {
  let payload: unknown = null;
  if (row.payload_json !== null) {
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      // A payload we cannot parse is still worth surfacing verbatim.
      payload = row.payload_json;
    }
  }

  return {
    id: row.id,
    ts: row.ts,
    actorName: row.actor_name,
    actorIp: row.actor_ip,
    action: row.action,
    target: row.target,
    payload,
    httpStatus: row.http_status,
    ok: row.ok === 1,
    error: row.error,
    durationMs: row.duration_ms,
  };
}

export class AuditService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Write one entry.
   *
   * Deliberately swallows storage errors: an audit write failing must never turn a successful
   * kick or a completed world save into an error for the operator.
   */
  record(input: AuditInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO audit
             (ts, actor_name, actor_ip, action, target, payload_json, http_status, ok, error, duration_ms)
           VALUES
             (@ts, @actor_name, @actor_ip, @action, @target, @payload_json, @http_status, @ok, @error, @duration_ms)`,
        )
        .run({
          ts: new Date().toISOString(),
          actor_name: input.actorName,
          actor_ip: input.actorIp,
          action: input.action,
          target: input.target,
          payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
          http_status: input.httpStatus,
          ok: input.ok ? 1 : 0,
          error: input.error,
          duration_ms: input.durationMs,
        });
    } catch {
      // Intentionally ignored — see the note above.
    }
  }

  /** Query the trail, newest first. */
  list(query: AuditQuery = {}): AuditResponse {
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, query.offset ?? 0);

    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit, offset };

    if (query.action !== undefined && query.action !== '') {
      conditions.push('action = @action');
      params.action = query.action;
    }
    if (query.actor !== undefined && query.actor !== '') {
      // Matches either the session username or the source IP, so "who did this" works whether
      // the operator is behind a proxy or not.
      conditions.push('(actor_name LIKE @actor OR actor_ip LIKE @actor)');
      params.actor = `%${query.actor}%`;
    }
    if (query.target !== undefined && query.target !== '') {
      conditions.push('target LIKE @target');
      params.target = `%${query.target}%`;
    }
    if (query.ok !== undefined) {
      conditions.push('ok = @ok');
      params.ok = query.ok ? 1 : 0;
    }
    if (query.from !== undefined && query.from !== '') {
      conditions.push('ts >= @from');
      params.from = query.from;
    }
    if (query.to !== undefined && query.to !== '') {
      conditions.push('ts <= @to');
      params.to = query.to;
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const rows = this.db
      .prepare(`SELECT * FROM audit ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all(params) as AuditRow[];

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM audit ${where}`).get(params) as {
      n: number;
    };

    return { entries: rows.map(toEntry), total: total.n, limit, offset };
  }

  /** Distinct action names present in the trail, for the UI filter dropdown. */
  distinctActions(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT action FROM audit ORDER BY action').all() as {
      action: string;
    }[];
    return rows.map((row) => row.action);
  }
}
