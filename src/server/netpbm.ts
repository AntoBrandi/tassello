// Netpbm images, PGM and PPM, which browsers do not show: the maps of
// nav2_map_server and map_server are PGM. Decoded into pixels for sharp to
// make PNGs of, for the file manager's previews.

import type { Pixels } from './image_encoding.ts';

export const NETPBM_EXTENSIONS = new Set(['.pgm', '.ppm', '.pnm']);
// 10,000 × 10,000: a map of a km² at 10 cm
const MAX_PIXELS = 100_000_000;

// P2 and P5 gray, P3 and P6 colour; text (P2, P3) or binary (P5, P6), 8 or
// 16 bit (big endian), scaled to 8 bit
export function decodeNetpbm(data: Buffer): Pixels {
  const magic = data.subarray(0, 2).toString('latin1');
  if (!['P2', 'P3', 'P5', 'P6'].includes(magic)) {
    throw new Error(`Not a PGM nor PPM image (${JSON.stringify(magic)})`);
  }
  const channels = magic === 'P3' || magic === 'P6' ? 3 : 1;
  const binary = magic === 'P5' || magic === 'P6';
  // The header's numbers, after comments (# to the end of the line)
  let offset = 2;
  const number = (): number => {
    for (;;) {
      // Tab, line feed, vertical tab, form feed, carriage return, space
      while (offset < data.length && (data[offset] === 0x20 || (data[offset] >= 0x09 && data[offset] <= 0x0d))) {
        offset++;
      }
      if (data[offset] !== 0x23) {
        break;
      }
      while (offset < data.length && data[offset] !== 0x0a) {
        offset++;
      }
    }
    const start = offset;
    while (offset < data.length && data[offset] >= 0x30 && data[offset] <= 0x39) {
      offset++;
    }
    if (offset === start) {
      throw new Error('Malformed PGM or PPM header');
    }
    return Number(data.subarray(start, offset).toString('latin1'));
  };
  const width = number();
  const height = number();
  const max = number();
  if (width < 1 || height < 1 || max < 1 || max > 65535) {
    throw new Error(`Malformed PGM or PPM header: ${width}×${height}, max ${max}`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`Too large to preview: ${width}×${height}`);
  }
  const count = width * height * channels;
  const pixels = Buffer.alloc(count);
  const scale = (value: number) => (max === 255 ? value : Math.round((Math.min(value, max) * 255) / max));
  if (binary) {
    // One whitespace after the header
    offset++;
    const bytes = max > 255 ? 2 : 1;
    if (data.length - offset < count * bytes) {
      throw new Error('Truncated PGM or PPM image');
    }
    for (let i = 0; i < count; i++) {
      pixels[i] = scale(bytes === 2 ? data.readUInt16BE(offset + i * 2) : data[offset + i]);
    }
  } else {
    for (let i = 0; i < count; i++) {
      pixels[i] = scale(number());
    }
  }
  return { data: pixels, width, height, channels };
}
