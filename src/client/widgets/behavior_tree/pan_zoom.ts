// The view of a behavior tree's graph, for the inspector and the editor:
// drag to pan, scroll or pinch to zoom, fit, bring nodes into view. It moves
// the layer of nodes as a whole (a CSS transform set from the gestures, not
// by React). A press that does not move is a tap; one that moves pans, or
// drags what the graph says it drags (the editor's nodes).

import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react';

import type { Box } from './layout.ts';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2.5;
// The first view zooms out no further, to stay readable: large trees show
// their top, and the running node when followed
const MIN_FIRST_ZOOM = 0.55;
// Kept clear around the tree: the toolbar is at the top
const MARGIN = 16;
const TOP_MARGIN = 54;
// A press moved less than this is a tap
const DRAG_PX = 5;
const GRID_PX = 24;
const MOVE_MS = 280;
// Dragged this close to an edge, the view follows, this fast at most (px a frame)
const EDGE_PX = 36;
const EDGE_SPEED = 14;

export interface Point {
  x: number;
  y: number;
}

interface View {
  x: number;
  y: number;
  k: number;
}

type Gesture =
  | { kind: 'press'; start: Point; target: Element }
  | { kind: 'pan' }
  | { kind: 'drag'; client: Point }
  | { kind: 'pinch'; distance: number; centre: Point };

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export interface PanZoomOptions {
  layout: { boxes: Map<number, Box>; width: number; height: number };
  // The node the first view starts from, if the tree is too large to fit
  root: number | undefined;
  vertical: boolean;
  // Of the right side, what a panel covers: nodes are brought beside it
  covered: number;
  // Another tree: a first view again
  version: unknown;
  onTap: (target: Element) => void;
  // The user moved the view
  onPan: () => void;
  // A press on target moved: whether it drags it (then followed, at points
  // of the layout), else it pans
  onDragStart?: (target: Element) => boolean;
  onDragMove?: (point: Point) => void;
  // Where it was dropped; null: cancelled
  onDragEnd?: (point: Point | null) => void;
}

export function usePanZoom(options: PanZoomOptions) {
  const { layout, root, vertical, covered, version } = options;
  // The latest, for the gestures and the frames under way
  const callbacks = useRef(options);
  callbacks.current = options;
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  // Moved by the user since the last fit: a resize keeps the view then
  const moved = useRef(false);
  const animation = useRef(0);
  const edgeFrame = useRef(0);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  // A node kept where it was on the screen when the layout changes (folded)
  const anchor = useRef<{ node: number; x: number; y: number } | null>(null);

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
      const first = root === undefined ? undefined : layout.boxes.get(root);
      if (whole || k >= MIN_FIRST_ZOOM || !first) {
        view.current = {
          k,
          x: (width - layout.width * k) / 2,
          y: TOP_MARGIN + Math.max(0, (height - TOP_MARGIN - MARGIN - layout.height * k) / 2),
        };
      } else {
        const zoom = MIN_FIRST_ZOOM;
        view.current = vertical
          ? { k: zoom, x: width / 2 - (first.x + first.width / 2) * zoom, y: TOP_MARGIN }
          : { k: zoom, x: MARGIN, y: (TOP_MARGIN + height) / 2 - (first.y + first.height / 2) * zoom };
      }
      apply();
    },
    [layout, root, vertical, apply],
  );

  // Brings the nodes into view, unless they are (always: centres them). The
  // view is the user's then: a new layout keeps it.
  const reveal = useCallback(
    (targets: number[], always: boolean) => {
      const viewport = viewportRef.current;
      const current = view.current;
      const boxes = targets.flatMap((node) => layout.boxes.get(node) ?? []);
      if (!viewport || !current || boxes.length === 0) {
        return;
      }
      moved.current = true;
      const left = Math.min(...boxes.map((b) => b.x));
      const top = Math.min(...boxes.map((b) => b.y));
      const right = Math.max(...boxes.map((b) => b.x + b.width));
      const bottom = Math.max(...boxes.map((b) => b.y + b.height));
      // What the panel leaves
      const width = viewport.clientWidth - covered;
      const height = viewport.clientHeight;
      const { x, y, k } = current;
      const inside =
        left * k + x >= MARGIN && right * k + x <= width - MARGIN && top * k + y >= TOP_MARGIN && bottom * k + y <= height - MARGIN;
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

  // The node stays where it is on the screen through the next layout
  const keepInPlace = useCallback(
    (node: number) => {
      const box = layout.boxes.get(node);
      const current = view.current;
      if (box && current) {
        anchor.current = { node, x: box.x * current.k + current.x, y: box.y * current.k + current.y };
      }
    },
    [layout],
  );

  // Of the layout, under a point of the page; null if outside the view
  const toLayout = useCallback((client: Point): Point | null => {
    const viewport = viewportRef.current;
    const current = view.current;
    if (!viewport || !current) {
      return null;
    }
    const rect = viewport.getBoundingClientRect();
    if (client.x < rect.left || client.x > rect.right || client.y < rect.top || client.y > rect.bottom) {
      return null;
    }
    return { x: (client.x - rect.left - current.x) / current.k, y: (client.y - rect.top - current.y) / current.k };
  }, []);

  // Another tree: a first view again
  useLayoutEffect(() => {
    moved.current = false;
  }, [version]);

  // A new layout: the first view, or the node kept where it was
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

  useEffect(
    () => () => {
      stop();
      cancelAnimationFrame(edgeFrame.current);
    },
    [],
  );

  const zoomAt = useCallback(
    (point: Point, factor: number) => {
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

  // Dragged near an edge, the view follows while it stays there
  const followEdges = () => {
    cancelAnimationFrame(edgeFrame.current);
    const g = gesture.current;
    const viewport = viewportRef.current;
    const current = view.current;
    if (g?.kind !== 'drag' || !viewport || !current) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const speed = (low: number, high: number, at: number) =>
      at < low + EDGE_PX ? (EDGE_SPEED * (low + EDGE_PX - at)) / EDGE_PX : at > high - EDGE_PX ? (-EDGE_SPEED * (at - high + EDGE_PX)) / EDGE_PX : 0;
    const dx = speed(rect.left, rect.right, g.client.x);
    const dy = speed(rect.top, rect.bottom, g.client.y);
    if (dx === 0 && dy === 0) {
      return;
    }
    view.current = { ...current, x: current.x + Math.max(-EDGE_SPEED, Math.min(EDGE_SPEED, dx)), y: current.y + Math.max(-EDGE_SPEED, Math.min(EDGE_SPEED, dy)) };
    moved.current = true;
    apply();
    const point = toLayout(g.client);
    if (point) {
      callbacks.current.onDragMove?.(point);
    }
    edgeFrame.current = requestAnimationFrame(followEdges);
  };

  const local = (event: PointerEvent) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pinch = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const endDrag = (dropped: boolean, event: PointerEvent) => {
    cancelAnimationFrame(edgeFrame.current);
    callbacks.current.onDragEnd?.(dropped ? toLayout({ x: event.clientX, y: event.clientY }) : null);
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
      if (gesture.current?.kind === 'drag') {
        endDrag(false, event);
      }
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
      if (callbacks.current.onDragStart?.(g.target)) {
        gesture.current = { kind: 'drag', client: { x: event.clientX, y: event.clientY } };
      } else {
        gesture.current = { kind: 'pan' };
        callbacks.current.onPan();
      }
    }
    const next = gesture.current;
    if (next?.kind === 'drag') {
      next.client = { x: event.clientX, y: event.clientY };
      const at = toLayout(next.client);
      if (at) {
        callbacks.current.onDragMove?.(at);
      }
      followEdges();
    } else if (next?.kind === 'pan') {
      view.current = { ...current, x: current.x + point.x - previous.x, y: current.y + point.y - previous.y };
      moved.current = true;
      apply();
    } else if (next?.kind === 'pinch' && pointers.current.size === 2) {
      const pinched = pinch();
      view.current = { ...current, x: current.x + pinched.centre.x - next.centre.x, y: current.y + pinched.centre.y - next.centre.y };
      zoomAt(pinched.centre, pinched.distance / (next.distance || 1));
      gesture.current = { kind: 'pinch', ...pinched };
      callbacks.current.onPan();
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) {
      return;
    }
    const g = gesture.current;
    if (g?.kind === 'press' && event.type === 'pointerup') {
      callbacks.current.onTap(g.target);
    } else if (g?.kind === 'drag') {
      endDrag(event.type === 'pointerup', event);
    }
    if (pointers.current.size === 1) {
      // From a pinch back to a pan with the finger left
      gesture.current = { kind: 'pan' };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  // Escape: the drag ends where it started
  const cancelDrag = useCallback(() => {
    if (gesture.current?.kind === 'drag') {
      gesture.current = null;
      cancelAnimationFrame(edgeFrame.current);
      callbacks.current.onDragEnd?.(null);
    }
  }, []);

  return {
    viewportRef,
    layerRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
    fit,
    reveal,
    keepInPlace,
    toLayout,
    cancelDrag,
  };
}
