// octomap_msgs/Octomap messages, as the Robot Viewer draws them: the centres
// of their occupied voxels, of each size, as octomap serializes its trees.
//
// The tree is 16 levels deep: its root, at depth 0, is a cube of
// resolution * 2^16 centred on the map's origin, and each node's 8 children
// are its halves along x (child bit 0), y (bit 1) and z (bit 2), at depth 16
// the map's resolution. Leaves above that depth are pruned nodes: their whole
// cube is occupied, or free.
//
// A binary map (octomap's writeBinaryData) gives, depth first from the root,
// 2 bytes per inner node: 2 bits per child, children 0-3 in the first byte,
// lowest bits first: 00 unknown, 10 free leaf (first bit set), 01 occupied
// leaf, 11 inner node, whose own 2 bytes follow, in the order of the children.
//
// A full map (writeData) gives, depth first from the root, each node's data
// (its occupancy's log-odds, a float, and then a ColorOcTree's colour, an
// OcTreeStamped's time), then a byte of the children it has, bit i for child
// i, which follow in that order. An inner node's log-odds are its children's
// highest, its colour their average: what it is drawn with at a depth limit.

export interface OctomapMessage {
  header: { frame_id: string };
  binary: boolean;
  id: string;
  resolution: number;
  data: Int8Array | Uint8Array | number[];
}

export interface Voxels {
  // x, y, z of each voxel's centre, in the map's frame, the largest first
  positions: Float32Array;
  // r, g, b of each, if the map has colours (a ColorOcTree's full map)
  colors: Uint8Array | null;
  count: number;
  // The voxels' sizes, in meters, and how many of each, in their order
  levels: { size: number; count: number }[];
  // Occupied voxels, at the depth asked for, before thinning
  source: number;
}

export const TREE_DEPTH = 16;

// What a full map's nodes carry before their children's byte, by tree type
const FULL_NODES: Record<string, { bytes: number; color: boolean }> = {
  OcTree: { bytes: 4, color: false },
  ColorOcTree: { bytes: 7, color: true },
  OcTreeStamped: { bytes: 8, color: false },
};

// Occupied from octomap's default threshold, a probability of 0.5
const OCCUPIED_LOG_ODDS = 0;

// The occupied voxels found, by depth
class Collector {
  readonly positions: number[][] = Array.from({ length: TREE_DEPTH + 1 }, () => []);
  readonly colors: number[][] = Array.from({ length: TREE_DEPTH + 1 }, () => []);

  add(depth: number, x: number, y: number, z: number, color?: [number, number, number]): void {
    this.positions[depth].push(x, y, z);
    if (color) {
      this.colors[depth].push(...color);
    }
  }
}

function bytesOf(data: OctomapMessage['data']): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof Int8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return Uint8Array.from(data, (b) => b & 0xff);
}

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new Error(`The map ends after ${this.bytes.length} bytes, within a node`);
    }
  }
}

// The half size of a child of a node at depth, in meters: the offset of its
// centre from its parent's
function childOffset(resolution: number, depth: number): number {
  return (resolution * 2 ** (TREE_DEPTH - depth - 1)) / 2;
}

function readBinary(reader: Reader, resolution: number, maxDepth: number, out: Collector): void {
  // Whether the node has occupied leaves; those of a node at maxDepth are
  // drawn as it (collapsed: only read)
  const node = (depth: number, x: number, y: number, z: number, collapsed: boolean): boolean => {
    if (depth >= TREE_DEPTH) {
      throw new Error('The map is deeper than 16 levels: not a binary octomap');
    }
    reader.need(2);
    const status = reader.bytes[reader.offset] | (reader.bytes[reader.offset + 1] << 8);
    reader.offset += 2;
    const offset = childOffset(resolution, depth);
    const childDepth = depth + 1;
    let occupied = false;
    for (let i = 0; i < 8; i++) {
      const child = (status >> (2 * i)) & 3;
      // 0 unknown, 1 free
      if (child < 2) {
        continue;
      }
      const cx = x + (i & 1 ? offset : -offset);
      const cy = y + (i & 2 ? offset : -offset);
      const cz = z + (i & 4 ? offset : -offset);
      if (child === 2) {
        occupied = true;
        if (!collapsed) {
          out.add(childDepth, cx, cy, cz);
        }
      } else if (collapsed || childDepth < maxDepth) {
        occupied = node(childDepth, cx, cy, cz, collapsed) || occupied;
      } else if (node(childDepth, cx, cy, cz, true)) {
        occupied = true;
        out.add(childDepth, cx, cy, cz);
      }
    }
    return occupied;
  };
  if (reader.bytes.length > 0) {
    node(0, 0, 0, 0, false);
  }
}

function readFull(reader: Reader, tree: string, resolution: number, maxDepth: number, out: Collector): void {
  const layout = FULL_NODES[tree];
  if (!layout) {
    throw new Error(`Cannot read a full map of a ${tree}: only of an ${Object.keys(FULL_NODES).join(', ')}`);
  }
  const node = (depth: number, x: number, y: number, z: number, collapsed: boolean): void => {
    reader.need(layout.bytes + 1);
    const at = reader.offset;
    const logOdds = reader.view.getFloat32(at, true);
    const children = reader.bytes[at + layout.bytes];
    reader.offset += layout.bytes + 1;
    if (!collapsed && (children === 0 || depth === maxDepth) && logOdds >= OCCUPIED_LOG_ODDS) {
      const color: [number, number, number] | undefined = layout.color
        ? [reader.bytes[at + 4], reader.bytes[at + 5], reader.bytes[at + 6]]
        : undefined;
      out.add(depth, x, y, z, color);
    }
    if (children === 0) {
      return;
    }
    if (depth >= TREE_DEPTH) {
      throw new Error(`The map is deeper than 16 levels: not a full ${tree}`);
    }
    const offset = childOffset(resolution, depth);
    for (let i = 0; i < 8; i++) {
      if (children & (1 << i)) {
        node(
          depth + 1,
          x + (i & 1 ? offset : -offset),
          y + (i & 2 ? offset : -offset),
          z + (i & 4 ? offset : -offset),
          collapsed || depth === maxDepth,
        );
      }
    }
  };
  if (reader.bytes.length > 0) {
    node(0, 0, 0, 0, false);
  }
}

// maxDepth: 1-16, nodes below it drawn as their parent at that depth;
// maxVoxels: at most these, evenly through the map
export function octomapToVoxels(message: OctomapMessage, maxDepth: number, maxVoxels: number): Voxels {
  const { resolution } = message;
  if (!(resolution > 0) || !Number.isFinite(resolution)) {
    throw new Error(`The map's resolution is ${resolution}`);
  }
  const depth = Math.min(TREE_DEPTH, Math.max(1, Math.round(maxDepth)));
  const reader = new Reader(bytesOf(message.data));
  const out = new Collector();
  const tree = message.id || 'OcTree';
  if (message.binary) {
    readBinary(reader, resolution, depth, out);
  } else {
    readFull(reader, tree, resolution, depth, out);
  }
  if (reader.offset !== reader.bytes.length) {
    throw new Error(
      `${reader.bytes.length - reader.offset} bytes after the map's nodes: not a ${message.binary ? 'binary' : 'full'} ${tree}`,
    );
  }

  const source = out.positions.reduce((sum, level) => sum + level.length / 3, 0);
  const step = Math.max(1, Math.ceil(source / Math.max(1, maxVoxels)));
  const count = Math.ceil(source / step);
  const positions = new Float32Array(count * 3);
  const hasColors = !message.binary && FULL_NODES[tree]?.color === true;
  const colors = hasColors ? new Uint8Array(count * 3) : null;
  const levels: Voxels['levels'] = [];
  // Through the voxels of every level as one list, every step-th kept
  let index = 0;
  let kept = 0;
  for (let d = 0; d <= TREE_DEPTH; d++) {
    const level = out.positions[d];
    let levelCount = 0;
    for (let i = 0; i < level.length / 3; i++, index++) {
      if (index % step !== 0) {
        continue;
      }
      for (let axis = 0; axis < 3; axis++) {
        positions[kept * 3 + axis] = level[i * 3 + axis];
        if (colors) {
          colors[kept * 3 + axis] = out.colors[d][i * 3 + axis];
        }
      }
      kept++;
      levelCount++;
    }
    if (levelCount > 0) {
      levels.push({ size: resolution * 2 ** (TREE_DEPTH - d), count: levelCount });
    }
  }
  return { positions, colors, count: kept, levels, source };
}
