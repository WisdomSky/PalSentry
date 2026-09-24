import {
  DEFAULT_HISTORY_WINDOW,
  type HistorySelection,
  type HistoryWindow,
} from '@palsentry/shared';
import { z } from 'zod';

/**
 * Request body schemas.
 *
 * These are the strict, user-facing validators used by route handlers. They are deliberately
 * separate from the tolerant normalisers in `palworld/normalise.ts`: a malformed request from
 * the browser is a bug worth rejecting loudly, whereas a cosmetic upstream field change should
 * degrade quietly.
 */

/** In-game chat cannot display much more than this, and it keeps the audit payload sane. */
export const MAX_MESSAGE_LENGTH = 200;

const messageField = z
  .string()
  .trim()
  .max(MAX_MESSAGE_LENGTH, `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);

/**
 * An optional message, with the empty string collapsed to `undefined`.
 *
 * An empty message is not the same as no message: sending `message: ""` upstream would show a
 * blank line in game, so it is normalised away here rather than in every route.
 */
const optionalMessageField = messageField
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/** Palworld player ids are opaque strings; only emptiness and length are worth validating. */
const useridField = z
  .string()
  .trim()
  .min(1, 'A player id is required.')
  .max(200, 'That player id is implausibly long.');

const waitTimeField = z
  .number({ error: 'waittime must be a number of seconds.' })
  .int('waittime must be a whole number of seconds.')
  .min(0, 'waittime cannot be negative.')
  .max(3600, 'waittime cannot exceed 3600 seconds (1 hour).');

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required.').max(200),
  password: z.string().min(1, 'Password is required.').max(1024),
});

export const announceSchema = z.object({
  message: messageField.min(1, 'A message is required.'),
});

export const kickSchema = z.object({
  userid: useridField,
  message: optionalMessageField,
});

export const banSchema = z.object({
  userid: useridField,
  message: optionalMessageField,
  /** Stored in the registry so the bans list is readable without an API lookup. */
  playerName: z.string().trim().max(200).optional(),
  /** Why the ban was issued — for the operator's own records. */
  reason: z.string().trim().max(500).optional(),
});

export const unbanSchema = z.object({
  userid: useridField,
});

export const shutdownSchema = z.object({
  waittime: waitTimeField,
  message: optionalMessageField,
});

export const restartSchema = z.object({
  /** Seconds of warning before the server goes down. Defaults to PALSENTRY_RESTART_WAIT_SECONDS. */
  waittime: waitTimeField.optional(),
  message: optionalMessageField,
});

const HISTORY_WINDOW_VALUES = ['1h', '6h', '24h', '7d', '30d'] as const;
const SECONDS_PER_DAY = 24 * 60 * 60;
const unixSecondsField = z.coerce
  .number({ error: 'must be a Unix timestamp in seconds.' })
  .int('must be a whole Unix timestamp in seconds.')
  .positive('must be later than the Unix epoch.')
  .max(Number.MAX_SAFE_INTEGER, 'is too large.');

/**
 * Validate either one rolling preset or one complete, retention-bounded absolute range.
 *
 * `defaultWindow` is the preset used when neither a window nor a range is supplied; the wayback
 * map overrides it because a day of movement is the useful default there, while the metrics
 * charts keep their shorter one.
 */
export function historyQuerySchema(
  retentionDays: number,
  defaultWindow: HistoryWindow = DEFAULT_HISTORY_WINDOW,
) {
  const maximumSpan = Math.max(1, Math.floor(retentionDays)) * SECONDS_PER_DAY;

  return z
    .object({
      window: z.enum(HISTORY_WINDOW_VALUES).optional(),
      from: unixSecondsField.optional(),
      to: unixSecondsField.optional(),
    })
    .superRefine((query, ctx) => {
      const hasWindow = query.window !== undefined;
      const hasFrom = query.from !== undefined;
      const hasTo = query.to !== undefined;

      if (hasWindow && (hasFrom || hasTo)) {
        ctx.addIssue({
          code: 'custom',
          path: ['window'],
          message: 'Choose either a preset window or a custom range, not both.',
        });
        return;
      }

      if (hasFrom !== hasTo) {
        ctx.addIssue({
          code: 'custom',
          path: [hasFrom ? 'to' : 'from'],
          message: 'Both from and to are required for a custom range.',
        });
        return;
      }

      if (query.from !== undefined && query.to !== undefined) {
        if (query.to <= query.from) {
          ctx.addIssue({
            code: 'custom',
            path: ['to'],
            message: 'to must be later than from.',
          });
        } else if (query.to - query.from > maximumSpan) {
          ctx.addIssue({
            code: 'custom',
            path: ['to'],
            message: `The range cannot exceed the configured ${Math.floor(retentionDays)}-day retention period.`,
          });
        }
      }
    })
    .transform((query): HistorySelection => {
      if (query.from !== undefined && query.to !== undefined) {
        return { kind: 'range', from: query.from, to: query.to };
      }
      return { kind: 'window', window: query.window ?? defaultWindow };
    });
}

/**
 * Optional extras a history request can ask for.
 *
 * Separate from {@link historyQuerySchema} because that schema describes *which* range to read and
 * is shared by both history endpoints, while these describe *what else* to put in the response.
 * Only the metrics endpoint acts on them; the wayback map has no use for a roster it already
 * draws.
 */
export const historyOptionsSchema = z
  .object({
    /** Include the names recorded online in each bucket, from the wayback position history. */
    players: z.enum(['true', 'false']).optional(),
  })
  .transform((query) => ({ includePlayers: query.players === 'true' }));

export const auditQuerySchema = z.object({
  action: z.string().trim().max(50).optional(),
  actor: z.string().trim().max(200).optional(),
  target: z.string().trim().max(200).optional(),
  ok: z.enum(['true', 'false']).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Path/query identifiers. */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Desktop connection form.
 *
 * The URL is left as a free string on purpose: it is normalised and probed by the settings
 * service, which produces the actionable message ("REST API port", "RESTAPIEnabled", "rejected the
 * credentials") that a schema-level URL check could not.
 */
export const connectionSchema = z.object({
  restUrl: z.string().trim().min(1, 'Enter the REST URL of your Palworld server.').max(2048),
  adminPassword: z.string().max(512),
  username: z.string().trim().max(200).optional(),
});
