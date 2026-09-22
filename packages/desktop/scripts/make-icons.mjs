/**
 * Rasterise the PalSentry shield icon without any image dependencies.
 *
 * The icon is simple geometry — a rounded shield silhouette with a keyhole cut out — so it is drawn
 * procedurally and encoded as a PNG using only `node:zlib`. That keeps icon generation reproducible
 * on every platform and in CI, with nothing to install.
 *
 * Outputs:
 * - `build/icon.png` — 1024px app icon, which electron-builder derives `.icns`, `.ico` and the
 *   Linux PNG set from, so no platform-specific tooling is needed.
 * - `assets/tray/trayTemplate.png` (+`@2x`) — black with alpha for macOS, where a template image is
 *   tinted by the menu bar to match light and dark modes.
 * - `assets/tray/tray.png` (+`@2x`) — the coloured mark used by Windows and Linux trays.
 *
 * Run with `npm run icons -w @palsentry/desktop`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** PalSentry's accent colour (Tailwind teal-600), used for the app icon and coloured tray mark. */
const TEAL = [13, 148, 136];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode straight (non-premultiplied) RGBA8 pixels as a PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  // 10-12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Shield geometry
// ---------------------------------------------------------------------------

/** Coverage of a rounded rectangle (all values in 0..1 icon space, centred on x=0.5). */
function insideRoundedRect(x, y, { left, right, top, bottom, radius }) {
  if (y < top || y > bottom || x < left || x > right) return false;
  const innerLeft = left + radius;
  const innerRight = right - radius;
  const innerTop = top + radius;
  const innerBottom = bottom - radius;
  if (x >= innerLeft && x <= innerRight) return true;
  if (y >= innerTop && y <= innerBottom) return true;

  const cx = x < innerLeft ? innerLeft : innerRight;
  const cy = y < innerTop ? innerTop : innerBottom;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideEllipse(x, y, { cx, cy, rx, ry }) {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

/**
 * The shield silhouette: a rounded rectangle for the shoulders and the lower half of an ellipse for
 * the taper, sharing the same half-width where they meet so the outline stays smooth.
 */
function insideShield(x, y, scale = 1) {
  const half = 0.4 * scale;
  const top = 0.5 - half;
  const shoulder = 0.5 + half * 0.18;

  const body = insideRoundedRect(x, y, {
    left: 0.5 - half,
    right: 0.5 + half,
    top,
    bottom: shoulder,
    radius: half * 0.36,
  });
  if (body) return true;

  // Only the part below the shoulders: above that the rectangle already covered the shape.
  if (y < shoulder) return false;

  return insideEllipse(x, y, {
    cx: 0.5,
    cy: shoulder,
    rx: half,
    ry: half * 1.05,
  });
}

/** The keyhole plate: a circle plus a tapering slot, cut out of the shield. */
function insideKeyhole(x, y, scale = 1) {
  const hole = insideEllipse(x, y, {
    cx: 0.5,
    cy: 0.42 * scale + 0.5 * (1 - scale),
    rx: 0.115 * scale,
    ry: 0.115 * scale,
  });
  if (hole) return true;

  // Slot: wide at the circle, narrowing towards the bottom of the shield.
  const slotTop = 0.4 * scale + 0.5 * (1 - scale);
  const slotBottom = 0.62 * scale + 0.5 * (1 - scale);
  if (y < slotTop || y > slotBottom) return false;
  const progress = (y - slotTop) / (slotBottom - slotTop);
  const halfWidth = 0.032 * scale * (1 - progress);
  return Math.abs(x - 0.5) <= halfWidth;
}

/**
 * Draw one icon: `fill` for the shield, `hole` for the keyhole, transparent elsewhere.
 *
 * Coverage is supersampled 4x4 per pixel, which is what keeps a 16px tray icon readable.
 */
function drawIcon(size, fill, hole, { shieldScale = 1, padding = 0.04 } = {}) {
  const pixels = new Uint8Array(size * size * 4);
  const samples = 4;
  const step = 1 / (size * samples);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let shieldHits = 0;
      let holeHits = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px * samples + sx + 0.5) * step;
          const y = (py * samples + sy + 0.5) * step;
          // Fit the shape into the canvas minus padding.
          const ix = (x - padding) / (1 - 2 * padding);
          const iy = (y - padding) / (1 - 2 * padding);
          if (insideShield(ix, iy, shieldScale)) {
            shieldHits++;
            if (insideKeyhole(ix, iy, shieldScale)) holeHits++;
          }
        }
      }

      const total = samples * samples;
      const alpha = shieldHits / total;
      const offset = (py * size + px) * 4;
      if (alpha === 0) continue;

      const holeFraction = shieldHits === 0 ? 0 : holeHits / shieldHits;
      const colour = [
        fill[0] * (1 - holeFraction) + hole[0] * holeFraction,
        fill[1] * (1 - holeFraction) + hole[1] * holeFraction,
        fill[2] * (1 - holeFraction) + hole[2] * holeFraction,
      ];

      pixels[offset] = Math.round(colour[0]);
      pixels[offset + 1] = Math.round(colour[1]);
      pixels[offset + 2] = Math.round(colour[2]);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, pixels);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function write(relativePath, buffer) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  console.log(`  ${relativePath} (${buffer.length} bytes)`);
}

console.log('Generating PalSentry icons…');

// App icon: electron-builder derives .icns, .ico and the Linux PNG set from this one file.
write('build/icon.png', drawIcon(1024, TEAL, WHITE, { padding: 0.07 }));

// Windows / Linux tray marks: coloured, so they read on light and dark taskbars alike.
write('assets/tray/tray.png', drawIcon(16, TEAL, WHITE));
write('assets/tray/tray@2x.png', drawIcon(32, TEAL, WHITE));

// macOS template image: pure black with alpha, tinted by the system for the current menu bar.
write('assets/tray/trayTemplate.png', drawIcon(16, BLACK, WHITE));
write('assets/tray/trayTemplate@2x.png', drawIcon(32, BLACK, WHITE));

console.log('Done.');
