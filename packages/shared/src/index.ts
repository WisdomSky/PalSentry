export * from './palworld.js';
export * from './contract.js';
export * from './settings.js';
export * from './map.js';
export * from './chart.js';
export * from './player-sort.js';

/** Polling cadence the dashboard defaults to, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Selectable polling cadences. `0` means "manual refresh only". */
export const POLL_INTERVAL_OPTIONS: readonly number[] = [2_000, 5_000, 15_000, 0];

export const APP_NAME = 'PalSentry';
