// Draws the home-screen icons with no dependencies: a rounded square in the Midnight
// ground colour with a "Q" (a thick ring and a tail) in the primary gradient, magenta →
// violet → accent along the diagonal. Writes app/icons/icon-180.png and icon-512.png.
//
//   node scripts/icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same values as theme.css (--ground, --magenta, --violet, --accent).
const GROUND = [0x0c, 0x17, 0x30];
const STOPS = [
  [0, [0xe3, 0x5b, 0xd0]],
  [0.5, [0x7b, 0x6c, 0xf6]],
  [1, [0x4d, 0x8e, 0xf7]],
];

// ------------------------------------------------------------------------- PNG encoder

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGBA image (Uint8Array, width*height*4) as PNG bytes: 8-bit RGBA, no filtering. */
export function encodePNG(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------------- drawing
// Shapes are tested in unit coordinates (0…1 across the icon); each pixel is sampled on a
// 4×4 grid for smooth edges.

const SAMPLES = 4;
const CORNER = 0.225; // corner radius, close to iOS's own mask
const RING = { cx: 0.48, cy: 0.46, outer: 0.3, inner: 0.185 };
const TAIL = { x1: 0.56, y1: 0.54, x2: 0.79, y2: 0.77, half: 0.055 };

function inRoundedSquare(x, y) {
  const dx = Math.max(CORNER - x, x - (1 - CORNER), 0);
  const dy = Math.max(CORNER - y, y - (1 - CORNER), 0);
  return dx * dx + dy * dy <= CORNER * CORNER;
}

function inRing(x, y) {
  const d = Math.hypot(x - RING.cx, y - RING.cy);
  return d <= RING.outer && d >= RING.inner;
}

/** A flat-ended bar `half` either side of the segment (x1,y1)→(x2,y2), crossing the ring. */
function inTail(x, y) {
  const { x1, y1, x2, y2, half } = TAIL;
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy);
  if (t < 0 || t > 1) return false;
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) <= half;
}

function gradientAt(x, y) {
  // Diagonal across the Q's own bounds, top-left to bottom-right.
  const start = RING.cx - RING.outer + (RING.cy - RING.outer);
  const end = TAIL.x2 + TAIL.half + (TAIL.y2 + TAIL.half);
  const t = Math.min(Math.max((x + y - start) / (end - start), 0), 1);
  for (let i = 1; i < STOPS.length; i += 1) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, k) => v + (c1[k] - v) * f);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let inside = 0;
      let mark = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedSquare(x, y)) continue;
          inside += 1;
          if (inRing(x, y) || inTail(x, y)) mark += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const i = (py * size + px) * 4;
      if (inside === 0) continue; // transparent corner
      const colour = gradientAt((px + 0.5) / size, (py + 0.5) / size);
      const f = mark / inside;
      for (let k = 0; k < 3; k += 1) rgba[i + k] = Math.round(GROUND[k] + (colour[k] - GROUND[k]) * f);
      rgba[i + 3] = Math.round((inside / total) * 255);
    }
  }
  return rgba;
}

// ------------------------------------------------------------------------- main

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'app', 'icons');
mkdirSync(out, { recursive: true });
for (const size of [180, 512]) {
  const file = join(out, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, size, drawIcon(size)));
  console.log(`wrote ${file}`);
}
