import assert from 'node:assert/strict';
import { test } from 'node:test';

import { octomapToVoxels, TREE_DEPTH, type OctomapMessage } from './octomap_encoding.ts';

// A tree as octomap keeps it, to serialize as octomap does
interface Leaf {
  occupied: boolean;
  color: [number, number, number];
}
interface Inner {
  children: (Node | null)[];
}
type Node = Leaf | Inner;

const isLeaf = (node: Node): node is Leaf => 'occupied' in node;

// A leaf at depth, its cube's index along each axis at that depth
interface Voxel {
  depth: number;
  key: [number, number, number];
  occupied?: boolean;
  color?: [number, number, number];
}

function tree(voxels: Voxel[]): Inner {
  const root: Inner = { children: Array(8).fill(null) };
  for (const { depth, key, occupied = true, color = [0, 0, 0] as [number, number, number] } of voxels) {
    let node = root;
    for (let d = 0; d < depth; d++) {
      const bit = depth - 1 - d;
      const i = ((key[0] >> bit) & 1) | (((key[1] >> bit) & 1) << 1) | (((key[2] >> bit) & 1) << 2);
      if (d === depth - 1) {
        node.children[i] = { occupied, color };
      } else {
        node.children[i] ??= { children: Array(8).fill(null) };
        node = node.children[i] as Inner;
      }
    }
  }
  return root;
}

function binary(root: Inner): number[] {
  const out: number[] = [];
  const write = (node: Inner) => {
    let status = 0;
    node.children.forEach((child, i) => {
      if (child) {
        status |= (isLeaf(child) ? (child.occupied ? 0b10 : 0b01) : 0b11) << (2 * i);
      }
    });
    out.push(status & 0xff, status >> 8);
    for (const child of node.children) {
      if (child && !isLeaf(child)) {
        write(child);
      }
    }
  };
  write(root);
  return out;
}

const LOG_ODDS = { occupied: 2, free: -2 };

// A ColorOcTree's (colours) or an OcTree's full map
function full(root: Inner, colors: boolean): number[] {
  const out: number[] = [];
  // Its log-odds and colour, as octomap's inner nodes have them
  const summary = (node: Node): { logOdds: number; color: [number, number, number] } => {
    if (isLeaf(node)) {
      return { logOdds: node.occupied ? LOG_ODDS.occupied : LOG_ODDS.free, color: node.color };
    }
    const children = node.children.filter((c): c is Node => c !== null).map(summary);
    const average = (k: number) => Math.round(children.reduce((s, c) => s + c.color[k], 0) / children.length);
    return { logOdds: Math.max(...children.map((c) => c.logOdds)), color: [average(0), average(1), average(2)] };
  };
  const write = (node: Node) => {
    const { logOdds, color } = summary(node);
    const value = new Uint8Array(new Float32Array([logOdds]).buffer);
    out.push(...value);
    if (colors) {
      out.push(...color);
    }
    let children = 0;
    if (!isLeaf(node)) {
      node.children.forEach((child, i) => {
        if (child) {
          children |= 1 << i;
        }
      });
    }
    out.push(children);
    if (!isLeaf(node)) {
      node.children.forEach((child) => child && write(child));
    }
  };
  write(root);
  return out;
}

function message(data: number[], binary: boolean, id = 'OcTree', resolution = 0.1): OctomapMessage {
  return { header: { frame_id: 'map' }, binary, id, resolution, data: Int8Array.from(data, (b) => (b << 24) >> 24) };
}

// The centre of a voxel at depth: from its key
function centre(depth: number, key: [number, number, number], resolution = 0.1): number[] {
  const size = resolution * 2 ** (TREE_DEPTH - depth);
  return key.map((k) => (k - 2 ** (depth - 1) + 0.5) * size);
}

// The voxels' centres, rounded, of each level, sorted: the order within a
// level is the tree's
function levels(voxels: ReturnType<typeof octomapToVoxels>) {
  let start = 0;
  return voxels.levels.map(({ size, count }) => {
    const centres: number[][] = [];
    for (let i = start; i < start + count; i++) {
      centres.push([...voxels.positions.slice(i * 3, i * 3 + 3)].map((v) => Math.round(v * 1000) / 1000));
    }
    start += count;
    return { size: Math.round(size * 1000) / 1000, centres: centres.sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
  });
}

const round = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000);

// Two of the finest voxels, a pruned one 4 times as large, a free one
const VOXELS: Voxel[] = [
  { depth: 16, key: [32768, 32768, 32768], color: [200, 0, 0] },
  { depth: 16, key: [32767, 32770, 32768], color: [0, 200, 0] },
  { depth: 14, key: [8195, 8192, 8191], color: [0, 0, 200] },
  { depth: 16, key: [32770, 32768, 32768], occupied: false, color: [255, 255, 255] },
];

test('a binary octomap gives its occupied voxels, the largest first, centred in their cubes', () => {
  const voxels = octomapToVoxels(message(binary(tree(VOXELS)), true), 16, 1000);
  assert.equal(voxels.count, 3);
  assert.equal(voxels.source, 3);
  assert.equal(voxels.colors, null);
  assert.deepEqual(levels(voxels), [
    { size: 0.4, centres: [round(centre(14, [8195, 8192, 8191]))] },
    { size: 0.1, centres: [round(centre(16, [32767, 32770, 32768])), round(centre(16, [32768, 32768, 32768]))] },
  ]);
  assert.deepEqual(round(centre(16, [32768, 32768, 32768])), [0.05, 0.05, 0.05]);
  assert.deepEqual(round(centre(14, [8195, 8192, 8191])), [1.4, 0.2, -0.2]);
});

test('below the depth asked for, voxels are drawn as their parent at that depth', () => {
  const voxels = octomapToVoxels(message(binary(tree(VOXELS)), true), 15, 1000);
  assert.deepEqual(levels(voxels), [
    { size: 0.4, centres: [[1.4, 0.2, -0.2]] },
    { size: 0.2, centres: [[-0.1, 0.3, 0.1], [0.1, 0.1, 0.1]] },
  ]);
  // A parent of free voxels only is not drawn
  const free = octomapToVoxels(message(binary(tree([{ depth: 16, key: [5, 5, 5], occupied: false }])), true), 12, 1000);
  assert.equal(free.count, 0);
});

test('a full ColorOcTree gives its voxels with their colours, its inner nodes their average', () => {
  const voxels = octomapToVoxels(message(full(tree(VOXELS), true), false, 'ColorOcTree'), 16, 1000);
  assert.equal(voxels.count, 3);
  const colorAt = (x: number, y: number) => {
    for (let i = 0; i < voxels.count; i++) {
      if (Math.abs(voxels.positions[i * 3] - x) < 1e-6 && Math.abs(voxels.positions[i * 3 + 1] - y) < 1e-6) {
        return [...voxels.colors!.slice(i * 3, i * 3 + 3)];
      }
    }
    return null;
  };
  assert.deepEqual(colorAt(0.05, 0.05), [200, 0, 0]);
  assert.deepEqual(colorAt(-0.05, 0.25), [0, 200, 0]);
  assert.deepEqual(colorAt(1.4, 0.2), [0, 0, 200]);

  // At depth 15, the parent of an occupied and a free voxel is occupied, with
  // their average colour
  const pair = tree([
    { depth: 16, key: [32768, 32768, 32768], color: [200, 0, 0] },
    { depth: 16, key: [32769, 32768, 32768], occupied: false, color: [0, 0, 100] },
  ]);
  const parent = octomapToVoxels(message(full(pair, true), false, 'ColorOcTree'), 15, 1000);
  assert.deepEqual(levels(parent), [{ size: 0.2, centres: [[0.1, 0.1, 0.1]] }]);
  assert.deepEqual([...parent.colors!], [100, 0, 50]);
});

test('a full OcTree reads as the binary map', () => {
  const fromFull = octomapToVoxels(message(full(tree(VOXELS), false), false, 'OcTree'), 16, 1000);
  const fromBinary = octomapToVoxels(message(binary(tree(VOXELS)), true), 16, 1000);
  assert.deepEqual(levels(fromFull), levels(fromBinary));
  assert.equal(fromFull.colors, null);
});

test('large maps are thinned evenly, their levels counted after', () => {
  const many: Voxel[] = [];
  for (let i = 0; i < 1000; i++) {
    many.push({ depth: 16, key: [32768 + (i % 10), 32768 + Math.floor(i / 10), 32768] });
  }
  many.push({ depth: 13, key: [4100, 4100, 4100] });
  const voxels = octomapToVoxels(message(binary(tree(many)), true), 16, 100);
  assert.equal(voxels.source, 1001);
  assert.ok(voxels.count <= 100, `${voxels.count} voxels`);
  assert.equal(
    voxels.levels.reduce((sum, level) => sum + level.count, 0),
    voxels.count,
  );
});

test('maps that cannot be read say why', () => {
  const data = binary(tree(VOXELS));
  assert.throws(() => octomapToVoxels(message(data.slice(0, 5), true), 16, 1000), /ends after 5 bytes/);
  assert.throws(() => octomapToVoxels(message([...data, 0, 0], true), 16, 1000), /2 bytes after the map's nodes/);
  assert.throws(() => octomapToVoxels(message(full(tree(VOXELS), false), false, 'CountingOcTree'), 16, 1000), /CountingOcTree/);
  assert.throws(() => octomapToVoxels(message(data, true, 'OcTree', 0), 16, 1000), /resolution is 0/);
  // A full ColorOcTree read as an OcTree: its nodes are 3 bytes longer
  assert.throws(() => octomapToVoxels(message(full(tree(VOXELS), true), false, 'OcTree'), 16, 1000));
  assert.equal(octomapToVoxels(message([], true), 16, 1000).count, 0);
});
