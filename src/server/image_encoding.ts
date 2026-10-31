// Conversion of ROS images into files a browser can show: raw images
// (sensor_msgs/msg/Image) into pixels that sharp compresses to JPEG,
// compressed ones (sensor_msgs/msg/CompressedImage) passed through.

export interface RawImage {
  width: number;
  height: number;
  encoding: string;
  is_bigendian: number | boolean;
  step: number;
  data: Uint8Array;
}

// Tightly packed 8 bit pixels, channels in RGB(A) order
export interface Pixels {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

// An image file, with the size of the ROS image it came from (0 if unknown)
export interface EncodedImage {
  data: Buffer;
  // Index into IMAGE_FORMATS (src/shared/protocol.ts): 0 JPEG, 1 PNG, 2 points
  format: 0 | 1 | 2;
  width: number;
  height: number;
}

export class UnsupportedImageError extends Error {}

export function rawToPixels(image: RawImage): Pixels {
  switch (image.encoding.toLowerCase()) {
    case 'rgb8':
      return pack(image, 3, false);
    // OpenCV's 8UC3 and 8UC4 are BGR(A)
    case 'bgr8':
    case '8uc3':
      return pack(image, 3, true);
    case 'rgba8':
      return pack(image, 4, false);
    case 'bgra8':
    case '8uc4':
      return pack(image, 4, true);
    case 'mono8':
    case '8uc1':
      return pack(image, 1, false);
    case 'mono16':
      return from16Bit(image, false);
    // Usually a depth image in millimeters, so scaled to its farthest point
    case '16uc1':
      return from16Bit(image, true);
    case '32fc1':
      return fromFloat(image);
    // Byte offsets of Y0, U, Y1 and V in each 4 byte pair of pixels
    case 'yuv422':
    case 'uyvy':
      return fromYuv422(image, 1, 0, 3, 2);
    case 'yuv422_yuy2':
    case 'yuyv':
      return fromYuv422(image, 0, 1, 2, 3);
  }
  throw new UnsupportedImageError(`Unsupported image encoding "${image.encoding}"`);
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
// compressed_depth_image_transport puts its depth quantization parameters
// before the PNG
const COMPRESSED_DEPTH_HEADER_BYTES = 12;

function startsWith(data: Uint8Array, magic: number[], offset = 0): boolean {
  return data.length >= offset + magic.length && magic.every((b, i) => data[offset + i] === b);
}

// The file of a CompressedImage, recognized by its content: its format field
// varies between publishers ("jpeg", "rgb8; jpeg compressed bgr8", ...)
export function compressedToImage(format: string, data: Uint8Array): EncodedImage {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (startsWith(buffer, JPEG_MAGIC)) {
    return { data: buffer, format: 0, width: 0, height: 0 };
  }
  if (startsWith(buffer, PNG_MAGIC)) {
    return { data: buffer, format: 1, width: 0, height: 0 };
  }
  if (startsWith(buffer, PNG_MAGIC, COMPRESSED_DEPTH_HEADER_BYTES)) {
    return {
      data: buffer.subarray(COMPRESSED_DEPTH_HEADER_BYTES),
      format: 1,
      width: 0,
      height: 0,
    };
  }
  throw new UnsupportedImageError(`Unsupported compressed image format "${format}"`);
}

function checkSize(image: RawImage, rowBytes: number): void {
  const { width, height, step, data } = image;
  if (width <= 0 || height <= 0) {
    throw new UnsupportedImageError('Empty image');
  }
  if (step < rowBytes || data.length < step * (height - 1) + rowBytes) {
    throw new UnsupportedImageError(
      `Malformed ${image.encoding} image: ${data.length} bytes for ${width}x${height}, step ${step}`,
    );
  }
}

// Drops the padding at the end of the rows, and swaps blue and red if asked
function pack(image: RawImage, channels: 1 | 3 | 4, swapRedBlue: boolean): Pixels {
  const { width, height, step } = image;
  const src = image.data;
  const rowBytes = width * channels;
  checkSize(image, rowBytes);
  if (!swapRedBlue && step === rowBytes) {
    return {
      data: Buffer.from(src.buffer, src.byteOffset, rowBytes * height),
      width,
      height,
      channels,
    };
  }
  const out = Buffer.allocUnsafe(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const s = y * step;
    const d = y * rowBytes;
    if (!swapRedBlue) {
      out.set(src.subarray(s, s + rowBytes), d);
      continue;
    }
    for (let i = 0; i < rowBytes; i += channels) {
      out[d + i] = src[s + i + 2];
      out[d + i + 1] = src[s + i + 1];
      out[d + i + 2] = src[s + i];
      if (channels === 4) {
        out[d + i + 3] = src[s + i + 3];
      }
    }
  }
  return { data: out, width, height, channels };
}

// To 8 bits: the high byte, or scaled to the image's largest value
function from16Bit(image: RawImage, scaleToMax: boolean): Pixels {
  const { width, height, step } = image;
  checkSize(image, width * 2);
  const src = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const littleEndian = !image.is_bigendian;
  let scale = 1 / 256;
  if (scaleToMax) {
    let max = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        max = Math.max(max, src.getUint16(y * step + x * 2, littleEndian));
      }
    }
    scale = max > 0 ? 255 / max : 0;
  }
  const out = Buffer.allocUnsafe(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = Math.min(255, Math.round(src.getUint16(y * step + x * 2, littleEndian) * scale));
    }
  }
  return { data: out, width, height, channels: 1 };
}

// Depth in meters: scaled to the farthest point, invalid values black
function fromFloat(image: RawImage): Pixels {
  const { width, height, step } = image;
  checkSize(image, width * 4);
  const src = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const littleEndian = !image.is_bigendian;
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = src.getFloat32(y * step + x * 4, littleEndian);
      if (Number.isFinite(v) && v > max) {
        max = v;
      }
    }
  }
  const out = Buffer.alloc(width * height);
  if (max > 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = src.getFloat32(y * step + x * 4, littleEndian);
        if (Number.isFinite(v) && v > 0) {
          out[y * width + x] = Math.round((v / max) * 255);
        }
      }
    }
  }
  return { data: out, width, height, channels: 1 };
}

// BT.601 limited range, as webcams deliver it. Each 4 bytes hold two pixels
// sharing their U and V.
function fromYuv422(image: RawImage, y0: number, u: number, y1: number, v: number): Pixels {
  const { width, height, step } = image;
  const src = image.data;
  checkSize(image, width * 2);
  const out = Buffer.allocUnsafe(width * height * 3);
  // Clamps the values written to 0-255
  const rgb = new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
  let d = 0;
  for (let row = 0; row < height; row++) {
    let s = row * step;
    for (let x = 0; x < width; x += 2, s += 4) {
      const cu = src[s + u] - 128;
      const cv = src[s + v] - 128;
      const r = 409 * cv + 128;
      const g = -100 * cu - 208 * cv + 128;
      const b = 516 * cu + 128;
      let c = 298 * (src[s + y0] - 16);
      rgb[d++] = (c + r) >> 8;
      rgb[d++] = (c + g) >> 8;
      rgb[d++] = (c + b) >> 8;
      if (x + 1 < width) {
        c = 298 * (src[s + y1] - 16);
        rgb[d++] = (c + r) >> 8;
        rgb[d++] = (c + g) >> 8;
        rgb[d++] = (c + b) >> 8;
      }
    }
  }
  return { data: out, width, height, channels: 3 };
}
