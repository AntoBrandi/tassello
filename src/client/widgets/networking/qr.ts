// QR codes (ISO/IEC 18004), as phones' cameras read them to join a Wi-Fi
// network: byte mode, error correction level M (15% of the code restored),
// versions 1 to 13 (331 bytes), the mask of the lowest penalty. After
// Project Nayuki's QR Code generator (MIT).

// Of each version, at level M: the error correction codewords of each block,
// and the data codewords of the blocks
const BLOCKS: [number, number[]][] = [
  [10, [16]],
  [16, [28]],
  [26, [44]],
  [18, [32, 32]],
  [24, [43, 43]],
  [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]],
  [22, [36, 36, 36, 37, 37]],
  [26, [43, 43, 43, 43, 44]],
  [30, [50, 51, 51, 51, 51]],
  [22, [36, 36, 36, 36, 36, 36, 37, 37]],
  [22, [37, 37, 37, 37, 37, 37, 37, 37, 38]],
];

// The centres of the alignment patterns, on both axes
const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
];

// Format information of level M: its two bits are 00
const LEVEL_M = 0;

// In GF(2^8), modulo x^8 + x^4 + x^3 + x^2 + 1
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// The Reed-Solomon generator polynomial of the degree, leading 1 left out
function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: number[], generator: number[]): number[] {
  const result = generator.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    generator.forEach((coefficient, i) => {
      result[i] ^= multiply(coefficient, factor);
    });
  }
  return result;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The codewords of the text: its bytes with their mode and length, padded,
// then the error correction of each block, interleaved
function codewords(bytes: Uint8Array, version: number): number[] {
  const [ecLength, blocks] = BLOCKS[version - 1];
  const capacity = blocks.reduce((sum, length) => sum + length, 0) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  append(0b0100, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((byte) => append(byte, 8));
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    append(pad, 8);
  }
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  const generator = divisor(ecLength);
  const split: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const length of blocks) {
    const block = data.slice(offset, offset + length);
    split.push({ data: block, ec: remainder(block, generator) });
    offset += length;
  }
  const result: number[] = [];
  for (let i = 0; i < Math.max(...blocks); i++) {
    split.forEach((block) => i < block.data.length && result.push(block.data[i]));
  }
  for (let i = 0; i < ecLength; i++) {
    split.forEach((block) => result.push(block.ec[i]));
  }
  return result;
}

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  // Finder, timing, alignment, format and version modules: not data
  readonly fixed: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }
}

function drawPatterns(matrix: Matrix, version: number): void {
  const { size } = matrix;
  for (let i = 0; i < size; i++) {
    matrix.set(6, i, i % 2 === 0);
    matrix.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          matrix.set(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }
  const centres = ALIGNMENT[version - 1];
  const last = centres.length - 1;
  centres.forEach((cx, i) =>
    centres.forEach((cy, j) => {
      // Not over the finders
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        return;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          matrix.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }),
  );
  // Reserved for now
  drawFormat(matrix, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      matrix.set(a, b, dark);
      matrix.set(b, a, dark);
    }
  }
}

function drawFormat(matrix: Matrix, mask: number): void {
  const { size } = matrix;
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) {
    matrix.set(8, i, bit(i));
  }
  matrix.set(8, 7, bit(6));
  matrix.set(8, 8, bit(7));
  matrix.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) {
    matrix.set(14 - i, 8, bit(i));
  }
  for (let i = 0; i < 8; i++) {
    matrix.set(size - 1 - i, 8, bit(i));
  }
  for (let i = 8; i < 15; i++) {
    matrix.set(8, size - 15 + i, bit(i));
  }
  matrix.set(8, size - 8, true);
}

// Up and down two columns at a time, from the bottom right, around the
// fixed modules
function drawData(matrix: Matrix, data: number[]): void {
  const { size } = matrix;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!matrix.fixed[y][x] && i < data.length * 8) {
          matrix.dark[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  const test = MASKS[mask];
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.fixed[y][x] && test(x, y)) {
        matrix.dark[y][x] = !matrix.dark[y][x];
      }
    }
  }
}

// The standard's: runs of five or more, 2x2 blocks, finder-like patterns,
// and the balance of dark and light
function penalty(dark: boolean[][]): number {
  const size = dark.length;
  let score = 0;
  const lines = [
    ...dark,
    ...Array.from({ length: size }, (_, x) => dark.map((row) => row[x])),
  ];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
        continue;
      }
      if (run >= 5) {
        score += 3 + (run - 5);
      }
      run = 1;
    }
    // 1:1:3:1:1 with four light modules on a side, beyond the edges light
    const at = (i: number) => i >= 0 && i < size && line[i];
    for (let i = 0; i + 7 <= size; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) {
        continue;
      }
      const lightBefore = [1, 2, 3, 4].every((k) => !at(i - k));
      const lightAfter = [7, 8, 9, 10].every((k) => !at(i + k));
      if (lightBefore || lightAfter) {
        score += 40;
      }
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) {
        score += 3;
      }
    }
  }
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The modules of the text's QR code, dark true, by row; null if longer than
// version 13 holds (331 bytes). mask: forced, for the tests.
export function qrCode(text: string, mask?: number): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  // The smallest that holds it: its mode, its length and its bytes
  let version = 0;
  for (let v = 1; v <= BLOCKS.length && version === 0; v++) {
    const capacity = BLOCKS[v - 1][1].reduce((sum, length) => sum + length, 0) * 8;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= capacity) {
      version = v;
    }
  }
  if (version === 0) {
    return null;
  }
  const data = codewords(bytes, version);
  let best: { score: number; dark: boolean[][] } | null = null;
  for (const candidate of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const matrix = new Matrix(17 + 4 * version);
    drawPatterns(matrix, version);
    drawData(matrix, data);
    applyMask(matrix, candidate);
    drawFormat(matrix, candidate);
    const score = penalty(matrix.dark);
    if (!best || score < best.score) {
      best = { score, dark: matrix.dark };
    }
  }
  return best!.dark;
}

// What a phone's camera reads to join the network
// (WIFI:T:WPA;S:Lab;P:secret;;), its special characters escaped
export function wifiQrText(ssid: string, password: string, type: 'WPA' | 'WEP' | 'nopass', hidden: boolean): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
  const secret = type === 'nopass' ? '' : `P:${escape(password)};`;
  return `WIFI:T:${type};S:${escape(ssid)};${secret}${hidden ? 'H:true;' : ''};`;
}
