// The tree as a graph: its nodes coloured by what they do now, the links to
// the running ones lit, so that the running branch shows from the root to the
// node at its end. Drag to pan, scroll or pinch to zoom, click a node for its
// details, click under a node to fold its children away.
//
// The view moves the layer of nodes as a whole (a CSS transform set from the
// gestures, not by React): a node renders again only when its state changes.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent } from 'react';

import type { BtNode, BtNodeState } from '../../../shared/protocol.ts';
import { layoutTree, type Box, type Direction, type Link, type Size } from './layout.ts';
import { activeNodes, statusLabel, toneOf, type Model, type Tone } from './model.ts';
import { KindIcon, kindLabel } from './parts.tsx';

// Their CSS's (.bt-node in styles.css)
const NODE_HEIGHT = 40;
const PORT_HEIGHT = 15;
const PORTS_PADDING = 11;
// Around the labels: padding, icon and gap, border
const LABEL_EXTRA = 45;
const MIN_WIDTH = 88;
const MAX_WIDTH = 240;
const MAX_PORTS_WIDTH = 320;
const GAPS = { siblings: 18, levels: 46 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
// The first view zooms out no further, to stay readable: large trees show
// their top, and the running node when followed
const MIN_FIRST_ZOOM = 0.55;
// Kept clear around the tree: the toolbar is at the top
const MARGIN = 16;
const TOP_MARGIN = 54;
// A press moved less than this is a click
const DRAG_PX = 5;
const GRID_PX = 24;
const MOVE_MS = 280;

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: 'press'; start: { x: number; y: number }; target: Element }
  | { kind: 'pan' }
  | { kind: 'pinch'; distance: number; centre: { x: number; y: number } };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

let measuring: CanvasRenderingContext2D | null = null;

function textWidth(text: string, font: string): number {
  measuring ??= document.createElement('canvas').getContext('2d');
  if (!measuring) {
    return text.length * 7;
  }
  measuring.font = font;
  return measuring.measureText(text).width;
}

// Each node's size: its labels, and its ports if shown
function measure(nodes: BtNode[], showPorts: boolean): Size[] {
  const style = getComputedStyle(document.documentElement);
  const font = getComputedStyle(document.body).fontFamily;
  const mono = style.getPropertyValue('--mono').trim() || 'monospace';
  return nodes.map((node) => {
    const label = Math.max(
      textWidth(node.type, `650 12px ${font}`),
      node.name === node.type ? 0 : textWidth(node.name, `11px ${font}`),
    );
    let width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(label + LABEL_EXTRA)));
    let height = NODE_HEIGHT;
    const ports = showPorts ? Object.entries(node.ports) : [];
    if (ports.length > 0) {
      const widest = Math.max(...ports.map(([key, value]) => textWidth(`${key}  ${value}`, `10.5px ${mono}`)));
      width = Math.max(width, Math.min(MAX_PORTS_WIDTH, Math.ceil(widest + 24)));
      height += ports.length * PORT_HEIGHT + PORTS_PADDING;
    }
    return { width, height };
  });
}

// A ring for every change, in the colour of what the node became (those of
// styles.css): the nodes that change all the time ripple all the time
const RING: Record<Tone, string> = {
  running: '240 160 32',
  success: '47 191 113',
  failure: '240 82 82',
  skipped: '139 149 167',
  idle: '139 149 167',
};

interface NodeCardProps {
  index: number;
  node: BtNode;
  box: Box;
  state: BtNodeState | undefined;
  selected: boolean;
  showPorts: boolean;
  vertical: boolean;
  // Its children: -1 none, 0 shown, else folded away, how many nodes they are
  folded: number;
  // Folded away, one of its children runs
  foldedRunning: boolean;
}

const NodeCard = memo(function NodeCard({
  index,
  node,
  box,
  state,
  selected,
  showPorts,
  vertical,
  folded,
  foldedRunning,
}: NodeCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const changes = state?.changes ?? 0;
  const seen = useRef(changes);
  const tone = toneOf(state?.status);
  const result = tone === 'idle' && state?.result ? toneOf(state.result) : null;
  // Even a change undone before the update came: a condition ticked
  useEffect(() => {
    if (changes !== seen.current) {
      seen.current = changes;
      if (!reducedMotion()) {
        const color = RING[result ?? tone];
        ref.current?.animate?.(
          [{ boxShadow: `0 0 0 0 rgb(${color} / 60%)` }, { boxShadow: `0 0 0 8px rgb(${color} / 0%)` }],
          { duration: 500, easing: 'ease-out' },
        );
      }
    }
  }, [changes, tone, result]);
  const ports = showPorts ? Object.entries(node.ports) : [];
  const title = `${kindLabel(node)}: ${node.type}${node.name === node.type ? '' : ` “${node.name}”`}${
    state?.status ? ` · ${statusLabel(state.status)}` : ''
  }`;
  return (
    <div
      ref={ref}
      data-node={index}
      className={`bt-node ${tone}${result ? ` was-${result}` : ''}${selected ? ' selected' : ''}`}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      title={title}
    >
      <div className="bt-node-head">
        <KindIcon node={node} />
        <div className="bt-node-labels">
          <span className="bt-node-type">{node.type}</span>
          {node.name !== node.type && <span className="bt-node-name">{node.name}</span>}
        </div>
      </div>
      {ports.length > 0 && (
        <dl className="bt-node-ports">
          {ports.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className={/^\{.*\}$/.test(value) ? 'entry' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {folded >= 0 && (
        <span
          data-fold={index}
          className={`bt-fold${vertical ? '' : ' side'}${foldedRunning ? ' running' : ''}`}
          title={folded === 0 ? 'Fold its children away' : 'Show its children'}
        >
          {folded === 0 ? '−' : `+${folded}`}
        </span>
      )}
    </div>
  );
});

// The links, those to running nodes last: on top
const Links = memo(function Links({ links, running, width, height }: { links: Link[]; running: string; width: number; height: number }) {
  const lit = new Set(running ? running.split(',').map(Number) : []);
  const ordered = [...links.filter((link) => !lit.has(link.child)), ...links.filter((link) => lit.has(link.child))];
  return (
    <svg className="bt-links" width={width} height={height} aria-hidden="true">
      {ordered.map((link) => (
        <path key={link.child} d={link.d} className={lit.has(link.child) ? 'running' : undefined} />
      ))}
    </svg>
  );
});

export interface GraphProps {
  model: Model;
  direction: Direction;
  showPorts: boolean;
  folded: ReadonlySet<number>;
  selected: number | null;
  follow: boolean;
  // Brings the node into view, whenever seq changes
  focus: { node: number; seq: number } | null;
  // Fits the whole tree, whenever it changes
  fitRequest: number;
  // Of the right side, what the details cover: nodes are brought beside them
  covered: number;
  onSelect: (node: number | null) => void;
  onFold: (node: number) => void;
  // The user moved the view
  onPan: () => void;
}

export function BehaviorTreeGraph({
  model,
  direction,
  showPorts,
  folded,
  selected,
  follow,
  focus,
  fitRequest,
  covered,
  onSelect,
  onFold,
  onPan,
}: GraphProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  // Moved by the user since the last fit: a resize keeps the view then
  const moved = useRef(false);
  const animation = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  // A node folded or unfolded, and where it was on the screen: it stays there
  const anchor = useRef<{ node: number; x: number; y: number } | null>(null);
  const vertical = direction === 'vertical';

  const { nodes, treeSize, children, states } = model;
  const roots = useMemo(() => nodes.slice(0, treeSize).flatMap((node, index) => (node.parent < 0 ? [index] : [])), [nodes, treeSize]);
  const sizes = useMemo(() => measure(nodes.slice(0, treeSize), showPorts), [nodes, treeSize, showPorts]);
  const layout = useMemo(
    () => layoutTree(roots, (node) => (folded.has(node) ? [] : children[node]), (node) => sizes[node], direction, GAPS),
    [roots, children, folded, sizes, direction],
  );
  // Nodes below each, itself included: parents come before their children
  const subtreeSizes = useMemo(() => {
    const counts = new Array<number>(treeSize).fill(1);
    for (let index = treeSize - 1; index > 0; index--) {
      const parent = nodes[index].parent;
      if (parent >= 0) {
        counts[parent] += counts[index];
      }
    }
    return counts;
  }, [nodes, treeSize]);

  // The node shown for each: itself, or the outermost folded one above it
  const shownAs = useCallback(
    (node: number) => {
      let shown = node;
      for (let parent = nodes[node].parent; parent >= 0; parent = nodes[parent].parent) {
        if (folded.has(parent)) {
          shown = parent;
        }
      }
      return shown;
    },
    [nodes, folded],
  );
  const active = activeNodes(model, shownAs).filter((node) => node < treeSize);
  const activeKey = active.join(',');
  const running = states.flatMap((state, node) => (state?.status === 'RUNNING' && node < treeSize ? [node] : [])).join(',');

  const apply = useCallback(() => {
    const current = view.current;
    const layer = layerRef.current;
    const viewport = viewportRef.current;
    if (!current || !layer || !viewport) {
      return;
    }
    layer.style.transform = `translate(${current.x}px, ${current.y}px) scale(${current.k})`;
    let grid = GRID_PX * current.k;
    while (grid < 12) {
      grid *= 2;
    }
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${current.x}px ${current.y}px`;
  }, []);

  const stop = () => {
    cancelAnimationFrame(animation.current);
    animation.current = 0;
  };

  const moveTo = useCallback(
    (target: View) => {
      stop();
      const from = view.current;
      if (!from || reducedMotion()) {
        view.current = target;
        apply();
        return;
      }
      const started = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / MOVE_MS);
        const eased = 1 - (1 - t) ** 3;
        view.current = {
          x: from.x + (target.x - from.x) * eased,
          y: from.y + (target.y - from.y) * eased,
          k: from.k + (target.k - from.k) * eased,
        };
        apply();
        animation.current = t < 1 ? requestAnimationFrame(step) : 0;
      };
      animation.current = requestAnimationFrame(step);
    },
    [apply],
  );

  // The whole tree, or (first) as much of it as stays readable, from the root
  const fit = useCallback(
    (whole: boolean) => {
      const viewport = viewportRef.current;
      if (!viewport || layout.width === 0) {
        return;
      }
      const [width, height] = [viewport.clientWidth, viewport.clientHeight];
      const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((width - 2 * MARGIN) / layout.width, (height - TOP_MARGIN - MARGIN) / layout.height)));
      moved.current = false;
      stop();
      const root = layout.boxes.get(roots[0]);
      if (whole || k >= MIN_FIRST_ZOOM || !root) {
        view.current = {
          k,
          x: (width - layout.width * k) / 2,
          y: TOP_MARGIN + Math.max(0, (height - TOP_MARGIN - MARGIN - layout.height * k) / 2),
        };
      } else {
        const first = MIN_FIRST_ZOOM;
        view.current = vertical
          ? { k: first, x: width / 2 - (root.x + root.width / 2) * first, y: TOP_MARGIN }
          : { k: first, x: MARGIN, y: (TOP_MARGIN + height) / 2 - (root.y + root.height / 2) * first };
      }
      apply();
    },
    [layout, roots, vertical, apply],
  );

  // Brings the nodes into view, unless they are (always: centres them)
  const reveal = useCallback(
    (targets: number[], always: boolean) => {
      const viewport = viewportRef.current;
      const current = view.current;
      const boxes = targets.flatMap((node) => layout.boxes.get(node) ?? []);
      if (!viewport || !current || boxes.length === 0) {
        return;
      }
      const left = Math.min(...boxes.map((b) => b.x));
      const top = Math.min(...boxes.map((b) => b.y));
      const right = Math.max(...boxes.map((b) => b.x + b.width));
      const bottom = Math.max(...boxes.map((b) => b.y + b.height));
      // What the details leave
      const width = viewport.clientWidth - covered;
      const height = viewport.clientHeight;
      const { x, y, k } = current;
      const inside =
        left * k + x >= MARGIN &&
        right * k + x <= width - MARGIN &&
        top * k + y >= TOP_MARGIN &&
        bottom * k + y <= height - MARGIN;
      if (inside && !always) {
        return;
      }
      moveTo({
        k,
        x: width / 2 - ((left + right) / 2) * k,
        y: (TOP_MARGIN + height - MARGIN) / 2 - ((top + bottom) / 2) * k,
      });
    },
    [layout, covered, moveTo],
  );

  // Another tree: a first view again
  useLayoutEffect(() => {
    moved.current = false;
  }, [model.version]);

  // A new layout: the first view, or the folded node kept where it was
  useLayoutEffect(() => {
    const kept = anchor.current;
    anchor.current = null;
    const box = kept && layout.boxes.get(kept.node);
    if (kept && box && view.current) {
      const { k } = view.current;
      view.current = { k, x: kept.x - box.x * k, y: kept.y - box.y * k };
      apply();
    } else if (!view.current || !moved.current) {
      fit(false);
    }
  }, [layout, fit, apply]);

  // Followed, the view is the user's: a new layout keeps it
  useEffect(() => {
    if (follow && activeKey) {
      moved.current = true;
      reveal(activeKey.split(',').map(Number), false);
    }
  }, [follow, activeKey, reveal]);

  // Only when asked, not when the functions change
  useEffect(() => {
    if (focus) {
      moved.current = true;
      reveal([shownAs(focus.node)], true);
    }
  }, [focus]);

  // Selected here, maybe where its details come
  useEffect(() => {
    if (selected !== null && covered > 0) {
      moved.current = true;
      reveal([shownAs(selected)], false);
    }
  }, [selected, covered]);

  useEffect(() => {
    if (fitRequest > 0) {
      fit(true);
    }
  }, [fitRequest]);

  // A resize keeps the view the user chose; else fits again
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const observer = new ResizeObserver(() => (moved.current ? apply() : fit(false)));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, apply]);

  useEffect(() => stop, []);

  const zoomAt = useCallback(
    (point: { x: number; y: number }, factor: number) => {
      const current = view.current;
      if (!current) {
        return;
      }
      stop();
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
      // The point of the tree under the pointer stays under it
      view.current = { k, x: point.x - ((point.x - current.x) * k) / current.k, y: point.y - ((point.y - current.y) * k) / current.k };
      moved.current = true;
      apply();
    },
    [apply],
  );

  // Not React's onWheel, which is passive: the page would scroll
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.0015));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const local = (event: PointerEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pinch = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    stop();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2) {
      gesture.current = { kind: 'pinch', ...pinch() };
    } else if (pointers.current.size === 1) {
      gesture.current = { kind: 'press', start: point, target: event.target as Element };
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    const current = view.current;
    if (!previous || !current) {
      return;
    }
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const g = gesture.current;
    if (g?.kind === 'press' && Math.hypot(point.x - g.start.x, point.y - g.start.y) > DRAG_PX) {
      gesture.current = { kind: 'pan' };
      onPan();
    }
    if (gesture.current?.kind === 'pan') {
      view.current = { ...current, x: current.x + point.x - previous.x, y: current.y + point.y - previous.y };
      moved.current = true;
      apply();
    } else if (g?.kind === 'pinch' && pointers.current.size === 2) {
      const next = pinch();
      view.current = { ...current, x: current.x + next.centre.x - g.centre.x, y: current.y + next.centre.y - g.centre.y };
      zoomAt(next.centre, next.distance / (g.distance || 1));
      gesture.current = { kind: 'pinch', ...next };
      onPan();
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) {
      return;
    }
    const g = gesture.current;
    if (g?.kind === 'press' && event.type === 'pointerup') {
      const toggle = g.target.closest('[data-fold]');
      const card = g.target.closest('[data-node]');
      if (toggle) {
        const node = Number(toggle.getAttribute('data-fold'));
        const box = layout.boxes.get(node);
        const current = view.current;
        if (box && current) {
          anchor.current = { node, x: box.x * current.k + current.x, y: box.y * current.k + current.y };
        }
        onFold(node);
      } else {
        onSelect(card ? Number(card.getAttribute('data-node')) : null);
      }
    }
    if (pointers.current.size === 1) {
      // From a pinch back to a pan with the finger left
      gesture.current = { kind: 'pan' };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  return (
    <div
      ref={viewportRef}
      className="bt-graph"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div ref={layerRef} className="bt-layer" style={{ width: layout.width, height: layout.height }}>
        <Links links={layout.links} running={running} width={layout.width} height={layout.height} />
        {[...layout.boxes].map(([index, box]) => (
          <NodeCard
            key={index}
            index={index}
            node={nodes[index]}
            box={box}
            state={states[index]}
            selected={selected === index}
            showPorts={showPorts}
            vertical={vertical}
            folded={children[index].length === 0 ? -1 : folded.has(index) ? subtreeSizes[index] - 1 : 0}
            foldedRunning={folded.has(index) && children[index].some((child) => states[child]?.status === 'RUNNING')}
          />
        ))}
      </div>
    </div>
  );
}
