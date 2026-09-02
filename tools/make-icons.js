/* Generates the PWA icon set as real PNG files, pure Node (zlib only, no
   canvas dependency). Draws the brand chip from the splash screen — a
   rounded (or full-bleed, for maskable) tile in Vision 360 blue with a
   pixel-drawn "V3" monogram — at every size the manifest needs. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'dist', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- tiny bitmap font: just V and 3, on an 8x10 grid ---------- */
const GLYPH = {
  V: [
    '1000001',
    '1000001',
    '1000001',
    '0100010',
    '0100010',
    '0010100',
    '0010100',
    '0001000'
  ],
  '3': [
    '0111100',
    '1000010',
    '0000010',
    '0001100',
    '0000010',
    '0000010',
    '1000010',
    '0111100'
  ]
};

/* ---------- minimal PNG encoder (8-bit RGBA, no filtering) ---------- */
function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- drawing ---------- */
function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lerp(a, b, t) { return a + (b - a) * t; }

function draw(size, { rounded, pad }) {
  const rgba = Buffer.alloc(size * size * 4);
  const top = hex('#5A7FB5'), bot = hex('#3A5A8A');
  const radius = rounded ? size * 0.22 : 0;

  function inRoundedRect(x, y) {
    if (!rounded) return true;
    const rx = Math.max(0, radius - Math.min(x, size - 1 - x, y, size - 1 - y, radius));
    if (x >= radius && x <= size - 1 - radius) return true;
    if (y >= radius && y <= size - 1 - radius) return true;
    const cx = x < radius ? radius : size - 1 - radius;
    const cy = y < radius ? radius : size - 1 - radius;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  // background gradient + sheen
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const base = [lerp(top[0], bot[0], t), lerp(top[1], bot[1], t), lerp(top[2], bot[2], t)];
    const sheen = Math.max(0, 1 - y / (size * 0.55)) * 0.16;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = inRoundedRect(x, y);
      rgba[i] = Math.min(255, base[0] + 255 * sheen);
      rgba[i + 1] = Math.min(255, base[1] + 255 * sheen);
      rgba[i + 2] = Math.min(255, base[2] + 255 * sheen);
      rgba[i + 3] = on ? 255 : 0;
    }
  }

  // "V3" monogram, pixel font upscaled and centered in the safe area
  const glyphs = ['V', '3'];
  const gw = 7, gh = 8, gap = 1.4;
  const totalCols = gw * 2 + gap;
  const safe = size - pad * 2;
  const cell = safe / (totalCols + 2); // small breathing margin
  const scaledW = totalCols * cell, scaledH = gh * cell;
  const ox = (size - scaledW) / 2, oy = (size - scaledH) / 2 + size * 0.01;

  glyphs.forEach((g, gi) => {
    const rows = GLYPH[g];
    const gx0 = ox + gi * (gw + gap) * cell;
    for (let ry = 0; ry < gh; ry++) {
      for (let rx = 0; rx < gw; rx++) {
        if (rows[ry][rx] !== '1') continue;
        const px0 = gx0 + rx * cell, py0 = oy + ry * cell;
        const x0 = Math.round(px0), y0 = Math.round(py0);
        const x1 = Math.round(px0 + cell), y1 = Math.round(py0 + cell);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const i = (y * size + x) * 4;
            if (rgba[i + 3] === 0) continue;
            rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255;
          }
        }
      }
    }
  });

  return encodePNG(size, size, rgba);
}

const SIZES = [16, 32, 48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512];
for (const s of SIZES) {
  fs.writeFileSync(path.join(OUT, `icon-${s}.png`), draw(s, { rounded: true, pad: s * 0.16 }));
}
// maskable: full-bleed square, content kept inside Android's safe circle (~66% of the tile)
fs.writeFileSync(path.join(OUT, 'icon-512-maskable.png'), draw(512, { rounded: false, pad: 512 * 0.30 }));
fs.writeFileSync(path.join(OUT, 'icon-192-maskable.png'), draw(192, { rounded: false, pad: 192 * 0.30 }));

// apple-touch-icon: iOS applies its own rounding, ship square art
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), draw(180, { rounded: false, pad: 180 * 0.16 }));

// favicon (32px is plenty for a PNG favicon)
fs.copyFileSync(path.join(OUT, 'icon-32.png'), path.join(OUT, 'favicon.png'));

console.log('wrote', SIZES.length + 4, 'PNGs to', path.relative(process.cwd(), OUT));
