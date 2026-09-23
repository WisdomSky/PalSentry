// Default import, not `{ pino }`: pino's types are `export = pino` with a merged namespace, and
// the named form loses the namespace half — so `pino.destination` would not typecheck.
import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

export type { Logger };

export interface LoggerSetup {
  level: string;
  pretty: boolean;
  /**
   * Append JSON lines to this file instead of stdout.
   *
   * Used by the desktop app, where there is no terminal to read: the shell points this at
   * `<userData>/logs/palsentry.log`. The directory is created if it is missing, and pretty output
   * is skipped (a transport would replace the destination and defeat the file).
   */
  destination?: string;
}

/**
 * Build the application logger.
 *
 * Pretty output is a development convenience only: it pulls in `pino-pretty`, which is a
 * devDependency and therefore absent from the production image. If the transport cannot be
 * loaded we fall back to plain JSON rather than crashing at startup.
 */
export function createLogger({ level, pretty, destination }: LoggerSetup): Logger {
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

  // A transport and a destination are mutually exclusive in pino, and a file that receives JSON
  // lines is the point of a destination, so pretty output is dropped in that case.
  if (pretty && destination === undefined) {
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

  return pino(options, destination === undefined ? undefined : fileDestination(destination));
}

/** Open an append-only JSON log file, creating its directory when needed. */
function fileDestination(destination: string) {
  try {
    // Synchronous writes on purpose: the desktop app is quit from a tray menu and exits without
    // unwinding, so a buffered final line ("Goodbye") would be lost. Log volume is a handful of
    // lines a minute, where the cost of `fs.writeSync` is irrelevant.
    return pino.destination({ dest: destination, mkdir: true, sync: true });
  } catch {
    // A destination that cannot be opened (read-only data dir, say) must not stop the app from
    // starting: fall back to stdout, which the desktop shell redirects to its own log file.
    return undefined;
  }
}
