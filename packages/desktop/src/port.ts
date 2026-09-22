import { createServer } from 'node:net';

/** First port we try, and the start of the range we scan when it is taken. */
export const PREFERRED_PORT = 43_100;
const RANGE_END = 43_199;

/** `true` when nothing is listening on `port` on the loopback interface. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();

    probe.once('error', () => {
      resolve(false);
    });

    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });

    // Loopback only: the app never listens on a public interface.
    probe.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

/**
 * Choose the port the embedded server will listen on.
 *
 * A stable origin matters more than it looks: the SPA keys its theme, polling cadence and map
 * calibration off `localStorage`, which is scoped per origin. So the port we used last time is
 * reused whenever it is still free, and only a genuine conflict moves us on.
 *
 * Falls back to `0` — “ask the operating system” — if the whole range is busy, which cannot happen
 * in practice but costs nothing to handle.
 */
export async function choosePort(saved: number | null): Promise<number> {
  if (saved !== null && saved >= 1024 && saved <= 65_535 && (await isPortFree(saved))) {
    return saved;
  }

  for (let port = PREFERRED_PORT; port <= RANGE_END; port++) {
    if (await isPortFree(port)) return port;
  }

  return 0;
}
