// Where the nodes of a behavior tree go on its graph: each parent above its
// children (or left of them), which keep their order, and each subtree as
// close to its neighbours as their outlines allow: a tidy tree, after
// Reingold and Tilford, for nodes of any size. Linear in the nodes times the
// depth.

export type Direction = 'vertical' | 'horizontal';

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  // Top left corner
  x: number;
  y: number;
}

export interface Link {
  parent: number;
  child: number;
  // SVG path data: down from the parent, along to above the child, down to it
  d: string;
}

export interface TreeLayout {
  // Of the nodes laid out
  boxes: Map<number, Box>;
  links: Link[];
  width: number;
  height: number;
}

export interface Gaps {
  // Between neighbours: siblings, and the subtrees beside each other
  siblings: number;
  // Between a parent's level and its children's
  levels: number;
}

// A subtree's extent across the levels, per level from its root's, relative
// to its root's centre
interface Contour {
  left: number[];
  right: number[];
}

// The contours side by side, each as close to the previous ones as gap
// allows: their offsets, and the outline of them all
function pack(contours: Contour[], gap: number): { offsets: number[]; outline: Contour } {
  const offsets = [0];
  const outline = { left: [...contours[0].left], right: [...contours[0].right] };
  for (let i = 1; i < contours.length; i++) {
    const { left, right } = contours[i];
    let offset = -Infinity;
    for (let level = 0; level < Math.min(outline.right.length, left.length); level++) {
      offset = Math.max(offset, outline.right[level] - left[level] + gap);
    }
    offsets.push(offset);
    for (let level = 0; level < left.length; level++) {
      if (level < outline.left.length) {
        outline.left[level] = Math.min(outline.left[level], left[level] + offset);
        outline.right[level] = Math.max(outline.right[level], right[level] + offset);
      } else {
        outline.left.push(left[level] + offset);
        outline.right.push(right[level] + offset);
      }
    }
  }
  return { offsets, outline };
}

const round = (value: number) => Math.round(value * 10) / 10;

// An elbow from (x1, y1) to (x2, y2) turning at y = turn, its corners rounded;
// vertical: across is x, else y
function elbow(x1: number, y1: number, x2: number, y2: number, turn: number, vertical: boolean): string {
  const point = (along: number, across: number) => (vertical ? `${round(across)},${round(along)}` : `${round(along)},${round(across)}`);
  if (Math.abs(x2 - x1) < 0.5) {
    return `M${point(y1, x1)}L${point(y2, x2)}`;
  }
  const r = Math.min(6, Math.abs(x2 - x1) / 2, turn - y1, y2 - turn);
  const side = Math.sign(x2 - x1);
  return (
    `M${point(y1, x1)}L${point(turn - r, x1)}Q${point(turn, x1)} ${point(turn, x1 + side * r)}` +
    `L${point(turn, x2 - side * r)}Q${point(turn, x2)} ${point(turn + r, x2)}L${point(y2, x2)}`
  );
}

export function layoutTree(
  roots: readonly number[],
  children: (node: number) => readonly number[],
  size: (node: number) => Size,
  direction: Direction,
  gaps: Gaps,
): TreeLayout {
  const vertical = direction === 'vertical';
  // Across the levels, and along them
  const across = (node: number) => (vertical ? size(node).width : size(node).height);
  const along = (node: number) => (vertical ? size(node).height : size(node).width);
  // Each node's centre from its parent's (the roots': from the first root's)
  const offsets = new Map<number, number>();
  const levels = new Map<number, number>();
  const levelSizes: number[] = [];

  const place = (node: number, level: number): Contour => {
    levels.set(node, level);
    levelSizes[level] = Math.max(levelSizes[level] ?? 0, along(node));
    const half = across(node) / 2;
    const kids = children(node);
    if (kids.length === 0) {
      return { left: [-half], right: [half] };
    }
    const packed = pack(
      kids.map((kid) => place(kid, level + 1)),
      gaps.siblings,
    );
    // Over its first and last children
    const centre = (packed.offsets[0] + packed.offsets[packed.offsets.length - 1]) / 2;
    kids.forEach((kid, i) => offsets.set(kid, packed.offsets[i] - centre));
    return {
      left: [-half, ...packed.outline.left.map((value) => value - centre)],
      right: [half, ...packed.outline.right.map((value) => value - centre)],
    };
  };

  if (roots.length === 0) {
    return { boxes: new Map(), links: [], width: 0, height: 0 };
  }
  const forest = pack(
    roots.map((root) => place(root, 0)),
    gaps.siblings * 2,
  );
  roots.forEach((root, i) => offsets.set(root, forest.offsets[i]));
  const start = Math.min(...forest.outline.left);
  const extent = Math.max(...forest.outline.right) - start;

  const levelStarts: number[] = [];
  let depth = 0;
  for (const levelSize of levelSizes) {
    levelStarts.push(depth);
    depth += levelSize + gaps.levels;
  }
  depth -= gaps.levels;

  const boxes = new Map<number, Box>();
  const links: Link[] = [];
  const visit = (node: number, parentCentre: number) => {
    const centre = parentCentre + offsets.get(node)!;
    const level = levels.get(node)!;
    const { width, height } = size(node);
    const position = centre - start;
    const box = vertical
      ? { x: position - width / 2, y: levelStarts[level], width, height }
      : { x: levelStarts[level], y: position - height / 2, width, height };
    boxes.set(node, box);
    const kids = children(node);
    if (kids.length === 0) {
      return;
    }
    const turn = levelStarts[level + 1] - gaps.levels / 2;
    for (const kid of kids) {
      visit(kid, centre);
      const child = boxes.get(kid)!;
      links.push({
        parent: node,
        child: kid,
        d: vertical
          ? elbow(position, box.y + height, child.x + child.width / 2, child.y, turn, true)
          : elbow(position, box.x + width, child.y + child.height / 2, child.x, turn, false),
      });
    }
  };
  roots.forEach((root) => visit(root, 0));
  return { boxes, links, width: vertical ? extent : depth, height: vertical ? depth : extent };
}
