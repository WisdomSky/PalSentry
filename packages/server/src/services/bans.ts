import type { BanRecord } from '@palsentry/shared';
import type { Db } from '../db/index.js';

/**
 * The ban registry.
 *
 * The Palworld REST API can ban and unban but has **no endpoint to list existing bans** (the
 * authoritative list lives in `Pal/Saved/SaveGames/banlist.txt` on the server). PalSentry
 * therefore keeps its own record of every ban it issues, which is what the Bans view shows.
 *
 * Consequences worth being explicit about:
 * - Bans issued from the in-game admin console or before PalSentry existed are **not** listed.
 *   Unbanning one of those requires pasting the player id, which the UI supports.
 * - Deleting a row here only forgets the bookkeeping; it does not unban anyone. Unbanning goes
 *   through the Palworld API (see `markUnbanned`, called after a successful upstream `/unban`).
 *
 * A row is a **ban episode**, not a player: ban → unban → ban again yields two rows, preserving
 * history. A partial unique index enforces at most one active episode per user.
 */

interface BanRow {
  id: number;
  userid: string;
  player_name: string | null;
  reason: string | null;
  actor_name: string | null;
  actor_ip: string | null;
  banned_at: string;
  active: number;
  unbanned_at: string | null;
  unbanned_by_ip: string | null;
  raw_response: string | null;
}

function toRecord(row: BanRow): BanRecord {
  return {
    id: row.id,
    userid: row.userid,
    playerName: row.player_name,
    reason: row.reason,
    actorName: row.actor_name,
    actorIp: row.actor_ip,
    bannedAt: row.banned_at,
    active: row.active === 1,
    unbannedAt: row.unbanned_at,
    unbannedByIp: row.unbanned_by_ip,
  };
}

export interface RecordBanInput {
  userid: string;
  playerName: string | null;
  reason: string | null;
  actorName: string | null;
  actorIp: string | null;
  rawResponse: string | null;
}

export class BanService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Record a ban.
   *
   * Re-banning an already-banned player updates the open episode rather than creating a second
   * one, matching the partial unique index. The upsert targets that index explicitly.
   */
  recordBan(input: RecordBanInput): void {
    this.db
      .prepare(
        `INSERT INTO bans (userid, player_name, reason, actor_name, actor_ip, banned_at, active, raw_response)
         VALUES (@userid, @player_name, @reason, @actor_name, @actor_ip, @banned_at, 1, @raw_response)
         ON CONFLICT(userid) WHERE active = 1
         DO UPDATE SET
           player_name  = excluded.player_name,
           reason       = excluded.reason,
           actor_name   = excluded.actor_name,
           actor_ip     = excluded.actor_ip,
           banned_at    = excluded.banned_at,
           raw_response = excluded.raw_response`,
      )
      .run({
        userid: input.userid,
        // Keep the previously known name if this call has none.
        player_name: input.playerName,
        reason: input.reason,
        actor_name: input.actorName,
        actor_ip: input.actorIp,
        banned_at: new Date().toISOString(),
        raw_response: input.rawResponse,
      });
  }

  /**
   * Close the active ban episode for a player.
   *
   * Returns true when a row was updated. A false result is not an error: it means the ban was
   * never issued through PalSentry (for example via the in-game console), which the caller
   * should still report as a successful unban.
   */
  markUnbanned(userid: string, actorIp: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE bans
            SET active = 0, unbanned_at = @unbanned_at, unbanned_by_ip = @actor_ip
          WHERE userid = @userid AND active = 1`,
      )
      .run({ userid, unbanned_at: new Date().toISOString(), actor_ip: actorIp });

    return result.changes > 0;
  }

  /** All ban episodes, newest first, active ones first. */
  list(): BanRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM bans ORDER BY active DESC, banned_at DESC')
      .all() as BanRow[];
    return rows.map(toRecord);
  }

  /** Look up one player's active ban, if any. */
  findActive(userid: string): BanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM bans WHERE userid = ? AND active = 1')
      .get(userid) as BanRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Map of `userid` → active ban, for annotating the online player list in one query instead of
   * one lookup per player.
   */
  activeBanMap(): Map<string, BanRecord> {
    const rows = this.db.prepare('SELECT * FROM bans WHERE active = 1').all() as BanRow[];
    return new Map(rows.map((row) => [row.userid, toRecord(row)]));
  }

  /** Count of currently active bans. */
  activeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM bans WHERE active = 1').get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * Forget a registry row.
   *
   * Bookkeeping only — this does not unban anyone. Exists so an operator can clean up an entry
   * they know is stale without touching the game server.
   */
  deleteById(id: number): boolean {
    const result = this.db.prepare('DELETE FROM bans WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
