// A minimal TF tree: the latest transform of each frame from its parent, as
// /tf and /tf_static give them, and their composition. No history nor
// interpolation: the dashboard shows where things are now.

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

// The pose of a child frame in its parent
export interface Transform {
  translation: Vector3;
  rotation: Quaternion;
}

export const IDENTITY: Transform = {
  translation: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
};

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function rotate(q: Quaternion, v: Vector3): Vector3 {
  const r = multiply(multiply(q, { ...v, w: 0 }), conjugate(q));
  return { x: r.x, y: r.y, z: r.z };
}

// a then b: the pose in a's parent of a frame whose pose in a is b
export function compose(a: Transform, b: Transform): Transform {
  const t = rotate(a.rotation, b.translation);
  return {
    translation: { x: a.translation.x + t.x, y: a.translation.y + t.y, z: a.translation.z + t.z },
    rotation: multiply(a.rotation, b.rotation),
  };
}

// A point given in a frame, in its parent: t is the frame's pose in it
export function transformPoint(t: Transform, p: Vector3): Vector3 {
  const r = rotate(t.rotation, p);
  return { x: r.x + t.translation.x, y: r.y + t.translation.y, z: r.z + t.translation.z };
}

export function invert(a: Transform): Transform {
  const rotation = conjugate(a.rotation);
  const t = rotate(rotation, a.translation);
  return { translation: { x: -t.x, y: -t.y, z: -t.z }, rotation };
}

// Rotation about z, in radians
export function yawOf(q: Quaternion): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

export function normalizeFrame(frame: string): string {
  return frame.trim().replace(/^\/+/, '');
}

interface Link {
  parent: string;
  transform: Transform;
  // ms since the epoch, null for static transforms
  receivedAt: number | null;
}

// Long chains are surely loops: TF trees are a few levels deep
const MAX_DEPTH = 100;

export class TfTree {
  // By child frame: a frame has one parent
  private readonly links = new Map<string, Link>();

  set(parent: string, child: string, transform: Transform, receivedAt: number | null): void {
    this.links.set(normalizeFrame(child), { parent: normalizeFrame(parent), transform, receivedAt });
  }

  clear(): void {
    this.links.clear();
  }

  // Every frame, with its parent (null for the roots) and, if dynamic, when
  // its transform arrived; by name
  frames(): { name: string; parent: string | null; receivedAt: number | null }[] {
    const frames = new Map<string, { name: string; parent: string | null; receivedAt: number | null }>();
    for (const [name, link] of this.links) {
      frames.set(name, { name, parent: link.parent, receivedAt: link.receivedAt });
    }
    for (const link of this.links.values()) {
      if (!frames.has(link.parent)) {
        frames.set(link.parent, { name: link.parent, parent: null, receivedAt: null });
      }
    }
    return [...frames.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // The pose of source in target, and the age of the oldest dynamic transform
  // it is made of. Throws if they are not connected.
  lookup(target: string, source: string, now: number): { transform: Transform; ageMs: number } {
    target = normalizeFrame(target);
    source = normalizeFrame(source);
    const up = this.toRoot(source);
    const down = this.toRoot(target);
    if (up.root !== down.root) {
      for (const frame of [target, source]) {
        if (!this.exists(frame)) {
          throw new Error(`Frame "${frame}" does not exist`);
        }
      }
      throw new Error(`"${target}" and "${source}" are not connected`);
    }
    // Up to their lowest common ancestor only: above it, the transforms (and
    // their age) do not matter
    while (up.links.length > 0 && up.links.at(-1) === down.links.at(-1)) {
      up.links.pop();
      down.links.pop();
    }
    const ages = [...up.links, ...down.links].map((link) => (link.receivedAt === null ? 0 : now - link.receivedAt));
    return {
      transform: compose(invert(chain(down.links)), chain(up.links)),
      ageMs: Math.max(0, ...ages),
    };
  }

  private exists(frame: string): boolean {
    if (this.links.has(frame)) {
      return true;
    }
    for (const link of this.links.values()) {
      if (link.parent === frame) {
        return true;
      }
    }
    return false;
  }

  // The links from frame up to the root of its tree
  private toRoot(frame: string): { root: string; links: Link[] } {
    const links: Link[] = [];
    let current = frame;
    for (let link = this.links.get(current); link; link = this.links.get(current)) {
      if (links.length === MAX_DEPTH) {
        throw new Error(`The TF tree above "${frame}" loops`);
      }
      links.push(link);
      current = link.parent;
    }
    return { root: current, links };
  }
}

// The pose of the first link's child in the last link's parent
function chain(links: Link[]): Transform {
  return links.reduce((transform, link) => compose(link.transform, transform), IDENTITY);
}
