#!/usr/bin/env node
/*
 * Generates the PWA icons.
 *
 * Written by hand against Node's built-in zlib rather than pulling in an
 * image library, so the repo stays dependency-free and the icons are
 * reproducible from source instead of being opaque binaries in git.
 *
 *   node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- Minimal PNG encoder (8-bit RGBA) ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- The mark ----
 * A document with three text lines and a caret, drawn in the app's own
 * palette. Sampled 4x4 per pixel so the rounded corners stay smooth.
 */

const INK = [0x1a, 0x1a, 0x1a];
const PAPER = [0xf7, 0xf7, 0xf8];
const CARET = [0xff, 0xd6, 0x0a];
const SS = 4; // supersampling factor

function roundedRectHit(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Returns [r,g,b,a] at a point in a 0..1 square, or null for transparent.
function sample(u, v, maskable) {
  // Maskable icons get extra padding so the safe zone survives any mask.
  const inset = maskable ? 0.16 : 0.06;
  const s = 1 - inset * 2;

  if (!roundedRectHit(u, v, inset, inset, s, s, s * 0.235)) return null;

  // Text lines inside the tile.
  const lineX = inset + s * 0.2;
  const lineW = s * 0.6;
  const lineH = s * 0.075;
  const gap = s * 0.155;
  const firstY = inset + s * 0.26;

  for (let i = 0; i < 3; i++) {
    const ly = firstY + i * gap;
    // The last line is short, with the caret sitting after it.
    const w = i === 2 ? lineW * 0.45 : lineW;
    if (roundedRectHit(u, v, lineX, ly, w, lineH, lineH / 2)) return PAPER;
    if (i === 2) {
      const caretX = lineX + w + s * 0.05;
      if (roundedRectHit(u, v, caretX, ly - lineH * 0.35, lineH * 0.75, lineH * 1.7, lineH * 0.3)) {
        return CARET;
      }
    }
  }
  return INK;
}

function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v, maskable);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Premultiplied average, un-premultiplied back out for straight alpha.
      rgba[i] = a ? Math.round(r / (a / 255)) : 0;
      rgba[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      rgba[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];

for (const [name, size, maskable] of targets) {
  const buf = render(size, maskable);
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(`${name}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
