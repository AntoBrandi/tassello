import assert from 'node:assert/strict';
import { test } from 'node:test';

import { qrCode, wifiQrText } from './qr.ts';

function rows(matrix: boolean[][] | null): string[] {
  return (matrix ?? []).map((row) => row.map((dark) => (dark ? '#' : '.')).join(''));
}

// As other encoders make them, at level M: zxing-cpp's, with the mask it
// chose
test('the modules are those of other encoders', () => {
  assert.deepEqual(rows(qrCode('b', 4)), [
    '#######.#.#...#######',
    '#.....#.....#.#.....#',
    '#.###.#..#....#.###.#',
    '#.###.#.#..##.#.###.#',
    '#.###.#.#...#.#.###.#',
    '#.....#.#.##..#.....#',
    '#######.#.#.#.#######',
    '........#..##........',
    '#...#.######.#####..#',
    '##..#...#..##..#.#.##',
    '..##.###...#..#####..',
    '##..#..####..##.#.#.#',
    '##....##..#.###...###',
    '........#...###...##.',
    '#######.#...##.....#.',
    '#.....#...###..#.#.#.',
    '#.###.#.####..#######',
    '#.###.#....##..#.#.##',
    '#.###.#..#.#..#####..',
    '#.....#......##.#.#..',
    '#######.##..###...#.#',
  ]);
  // Filling version 3 exactly, so without padding: segno's, in byte mode
  assert.deepEqual(rows(qrCode('WIFI:T:WPA;S:Robot-AP;P:secret-123456789;;', 6)), [
    '#######.#....#..##.#..#######',
    '#.....#.#..#....#.##..#.....#',
    '#.###.#.#.##.#.#..#...#.###.#',
    '#.###.#..#...##..###..#.###.#',
    '#.###.#.#.##.......##.#.###.#',
    '#.....#...##.##.#.#...#.....#',
    '#######.#.#.#.#.#.#.#.#######',
    '.........#.#.#..#.###........',
    '#..#######..#..#.#.###..#.###',
    '.##.....#.#.##.##....#..#...#',
    '.##.#.##.#.#..###.#..##..##..',
    '.##.##.....#...###.....##....',
    '#..#..###..##.##...##.#.#...#',
    '..#.....#.##...#..##.#.###...',
    '#########..#.#.##..#####.##.#',
    '.......#..##...##........####',
    '##.########..####..##....####',
    '#.#.##..#..#########...###..#',
    '##....#.#.###.##..###...###.#',
    '###.##..###.##.....#.##.#####',
    '##.#####...#...#.#.######.#.#',
    '........##...#.##..##...#..##',
    '#######.#.##.####.###.#.#....',
    '#.....#.#.#.#.#..####...##...',
    '#.###.#.###..##.#..######.##.',
    '#.###.#.###...##..#..#..#.#.#',
    '#.###.#..#.###.##...##.##.###',
    '#.....#.......#.......#.###.#',
    '#######.##...####..########..',
  ]);
});

test('the smallest version that holds the text, up to 13', () => {
  const size = (bytes: number) => qrCode('x'.repeat(bytes))?.length ?? null;
  // Version 1 holds 14 bytes at level M, 2 26, 10 213, 11 251
  assert.equal(size(14), 21);
  assert.equal(size(15), 25);
  assert.equal(size(26), 25);
  assert.equal(size(213), 57);
  assert.equal(size(214), 61);
  assert.equal(size(251), 61);
  assert.equal(size(252), 65);
  assert.equal(qrCode('x'.repeat(400)), null);
  // In bytes: é is two
  assert.equal(qrCode('é'.repeat(7))?.length, 21);
  assert.equal(qrCode('é'.repeat(8))?.length, 25);
});

test('what phones read to join a network', () => {
  assert.equal(wifiQrText('Robot', 'secret123', 'WPA', false), 'WIFI:T:WPA;S:Robot;P:secret123;;');
  assert.equal(wifiQrText('Lab: 2nd', 'a;b,c"d\\e', 'WPA', true), 'WIFI:T:WPA;S:Lab\\: 2nd;P:a\\;b\\,c\\"d\\\\e;H:true;;');
  assert.equal(wifiQrText('Guest', 'ignored', 'nopass', false), 'WIFI:T:nopass;S:Guest;;');
});
