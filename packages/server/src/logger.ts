import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';

export type { Logger };

export interface LoggerSetup {
  level: string;
  pretty: boolean;
}

/**
 * Build the application logger.
 *
 * Pretty output is a development convenience only: it pulls in `pino-pretty`, which is a
 * devDependency and therefore absent from the production image. If the transport cannot be
 * loaded we fall back to plain JSON rather than crashing at startup.
 */
export function createLogger({ level, pretty }: LoggerSetup): Logger {
  const options: LoggerOptions = {
    level,
    // Never let a credential reach the log, even if a config object is logged by accident.
    redact: {
      paths: [
        'password',
        '*.password',
        'config.palworld.password',
        'config.auth.password',
        'config.auth.passwordHash',
        'config.auth.sessionSecret',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
    base: undefined,
  };

  if (pretty) {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch {
      // pino-pretty unavailable (production image) — JSON logs are fine.
    }
  }

  return pino(options);
}
