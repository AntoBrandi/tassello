// The behavior tree editor's graph: a BehaviorTree's nodes under the tree
// itself, what is wrong with them marked. Click a node to edit it, double
// click a subtree to open its tree, drag a node to move it (with its
// children): into a node, or beside one. The palette's nodes are dragged in
// the same way (dragNew). Pan, zoom and pinch as in the inspector.

import { memo, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';

import { TreeIcon } from '../../icons.tsx';
import { GAPS, Links, measure } from './BehaviorTreeGraph.tsx';
import { dropTarget, type DropTarget, type EditorGraph as Graph, type GraphNode } from './editor_model.ts';
import { layoutTree, type Box, type Direction } from './layout.ts';
import { usePanZoom, type Point } from './pan_zoom.ts';
import { KindIcon, kindLabel } from './parts.tsx';

// The empty tree's slot, where its first node goes
const SLOT = -1;
const SLOT_SIZE = { width: 150, height: 40 };
const DOUBLE_TAP_MS = 400;
// The problems' mark, and its gap (.bte-problem)
const PROBLEM_PX = 22;

export interface EditorGraphHandle {
  // Shows where a node of the palette dragged at the point of the page would
  // go, and returns it (null: nowhere); a null point ends the drag
  dragNew: (client: Point | null) => DropTarget | null;
}

interface CardProps {
  index: number;
  node: GraphNode;
  box: Box;
  selected: boolean;
  showPorts: boolean;
  vertical: boolean;
  // Its children: -1 none, 0 shown, else folded away, how many nodes they are
  folded: number;
  dropInto: boolean;
  dragged: boolean;
}

const Card = memo(function Card({ index, node, box, selected, showPorts, vertical, folded, dropInto, dragged }: CardProps) {
  const tree = node.kind === null;
  const ports = showPorts ? Object.entries(node.ports) : [];
  const label = tree ? 'BehaviorTree' : node.type;
  const name = tree ? node.name || 'Unnamed' : node.name !== node.type ? node.name : '';
  const title = [
    tree ? `The tree ${node.name}` : `${kindLabel(node)}: ${node.type}${name ? ` “${name}”` : ''}`,
    !tree && !node.model && 'Not in the node libraries',
    ...node.problems,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      data-node={index}
      className={`bt-node bte-node${tree ? ' tree' : ''}${selected ? ' selected' : ''}${node.problems.length > 0 ? ' problem' : ''}${
        !tree && !node.model ? ' unknown' : ''
      }${dropInto ? ' drop-into' : ''}${dragged ? ' dragged' : ''}`}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      title={title}
    >
      <div className="bt-node-head">
        {tree ? <TreeIcon className="bt-kind" width={14} height={14} /> : <KindIcon node={node} />}
        <div className="bt-node-labels">
          <span className="bt-node-type">{label}</span>
          {name && <span className="bt-node-name">{name}</span>}
        </div>
        {node.problems.length > 0 && (
          <span className="bte-problem" aria-label={node.problems.join('. ')}>
            !
          </span>
        )}
      </div>
      {ports.length > 0 && (
        <dl className="bt-node-ports">
          {ports.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className={/^\{.*\}$/.test(value) ? 'entry' : undefined}>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {folded >= 0 && (
        <span
          data-fold={index}
          className={`bt-fold${vertical ? '' : ' side'}`}
          title={folded === 0 ? 'Fold its children away' : 'Show its children'}
        >
          {folded === 0 ? '−' : `+${folded}`}
        </span>
      )}
    </div>
  );
});

export interface EditorGraphProps {
  graph: Graph;
  // Of the tree shown: another, a first view again
  version: unknown;
  direction: Direction;
  showPorts: boolean;
  // By key
  folded: ReadonlySet<number>;
  selected: number | null;
  readOnly: boolean;
  // Brings the node of the key into view, whenever seq changes
  focus: { key: number; seq: number } | null;
  // Fits the whole tree, whenever it changes
  fitRequest: number;
  // Of the right side, what the properties cover
  covered: number;
  onSelect: (key: number | null) => void;
  // Double clicked
  onOpen: (key: number) => void;
  onFold: (key: number) => void;
  onMove: (key: number, target: DropTarget) => void;
  ref?: Ref<EditorGraphHandle>;
}

export function EditorGraph({
  graph,
  version,
  direction,
  showPorts,
  folded,
  selected,
  readOnly,
  focus,
  fitRequest,
  covered,
  onSelect,
  onOpen,
  onFold,
  onMove,
  ref,
}: EditorGraphProps) {
  const vertical = direction === 'vertical';
  const { nodes, children } = graph;
  const empty = children[0].length === 0;
  // Room for the problems' mark
  const sizes = useMemo(
    () => measure(nodes, showPorts).map((size, index) => (nodes[index].problems.length > 0 ? { ...size, width: size.width + PROBLEM_PX } : size)),
    [nodes, showPorts],
  );
  const layout = useMemo(
    () =>
      layoutTree(
        [0],
        (node) => (node === 0 && empty ? [SLOT] : node >= 0 && folded.has(nodes[node].key) ? [] : (children[node] ?? [])),
        (node) => (node === SLOT ? SLOT_SIZE : sizes[node]),
        direction,
        GAPS,
      ),
    [nodes, children, empty, folded, sizes, direction],
  );
  // The nodes' boxes, without the slot
  const boxes = useMemo(() => new Map([...layout.boxes].filter(([node]) => node !== SLOT)), [layout]);
  const indices = useMemo(() => new Map(nodes.map((node, index) => [node.key, index])), [nodes]);
  const subtreeSizes = useMemo(() => {
    const counts = new Array<number>(nodes.length).fill(1);
    for (let index = nodes.length - 1; index > 0; index--) {
      counts[nodes[index].parent] += counts[index];
    }
    return counts;
  }, [nodes]);

  // What is dragged (the node moved, or -1 a new one), where it would go, and
  // where it is
  const [drag, setDrag] = useState<{ node: number; target: DropTarget | null; at: Point | null } | null>(null);
  const lastTap = useRef<{ node: number; time: number } | null>(null);
  const selectedIndex = selected === null ? null : (indices.get(selected) ?? null);

  // Where a node dragged at the point would go
  const targetAt = (point: Point, moved: number | null): DropTarget | null => {
    const slot = layout.boxes.get(SLOT);
    if (slot && point.x >= slot.x && point.x <= slot.x + slot.width && point.y >= slot.y && point.y <= slot.y + slot.height) {
      return { parent: 0, index: 0, mode: 'into', node: 0 };
    }
    return dropTarget(graph, boxes, point, moved, vertical);
  };

  const keepRef = useRef<(node: number) => void>(() => {});
  const onTap = (target: Element) => {
    const toggle = target.closest('[data-fold]');
    const card = target.closest('[data-node]');
    if (toggle) {
      const node = Number(toggle.getAttribute('data-fold'));
      keepRef.current(node);
      onFold(nodes[node].key);
      return;
    }
    if (!card) {
      lastTap.current = null;
      onSelect(null);
      return;
    }
    const node = Number(card.getAttribute('data-node'));
    const now = performance.now();
    if (lastTap.current?.node === node && now - lastTap.current.time < DOUBLE_TAP_MS) {
      lastTap.current = null;
      onOpen(nodes[node].key);
    } else {
      lastTap.current = { node, time: now };
      onSelect(nodes[node].key);
    }
  };

  const view = usePanZoom({
    layout,
    root: 0,
    vertical,
    covered,
    version,
    onTap,
    onPan: () => {},
    onDragStart: (target) => {
      const card = target.closest('[data-node]');
      const node = card ? Number(card.getAttribute('data-node')) : 0;
      if (readOnly || node <= 0) {
        return false;
      }
      setDrag({ node, target: null, at: null });
      return true;
    },
    onDragMove: (point) => setDrag((current) => current && { ...current, target: targetAt(point, current.node), at: point }),
    onDragEnd: (point) => {
      const moved = drag?.node;
      setDrag(null);
      const target = point && moved !== undefined ? targetAt(point, moved) : null;
      if (moved !== undefined && target) {
        onMove(nodes[moved].key, target);
      }
    },
  });
  keepRef.current = view.keepInPlace;

  useImperativeHandle(
    ref,
    () => ({
      dragNew: (client) => {
        const point = client && view.toLayout(client);
        const target = point ? targetAt(point, null) : null;
        setDrag(client ? { node: -1, target, at: null } : null);
        return target;
      },
    }),
    [view.toLayout, graph, boxes, layout, vertical],
  );

  useEffect(() => {
    if (!drag) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && (view.cancelDrag(), setDrag(null));
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag !== null, view.cancelDrag]);

  // Only when asked, not when the functions change
  useEffect(() => {
    const node = focus && indices.get(focus.key);
    if (node !== undefined && node !== null) {
      view.reveal([shownAs(node)], false);
    }
  }, [focus]);

  useEffect(() => {
    if (selectedIndex !== null && covered > 0) {
      view.reveal([shownAs(selectedIndex)], false);
    }
  }, [selectedIndex, covered]);

  useEffect(() => {
    if (fitRequest > 0) {
      view.fit(true);
    }
  }, [fitRequest]);

  // The node shown for each: itself, or the outermost folded one above it
  function shownAs(node: number): number {
    let shown = node;
    for (let parent = nodes[node].parent; parent >= 0; parent = nodes[parent].parent) {
      if (folded.has(nodes[parent].key)) {
        shown = parent;
      }
    }
    return shown;
  }

  const target = drag?.target ?? null;
  // Beside a node: a bar in the gap
  let bar: Box | null = null;
  if (target && target.mode !== 'into') {
    const box = layout.boxes.get(target.node)!;
    const gap = GAPS.siblings / 2;
    bar = vertical
      ? { x: target.mode === 'before' ? box.x - gap - 2 : box.x + box.width + gap - 2, y: box.y, width: 4, height: box.height }
      : { x: box.x, y: target.mode === 'before' ? box.y - gap - 2 : box.y + box.height + gap - 2, width: box.width, height: 4 };
  }
  const slot = layout.boxes.get(SLOT);
  const ghost = drag && drag.node > 0 && drag.at ? layout.boxes.get(drag.node) : undefined;

  return (
    <div ref={view.viewportRef} className={`bt-graph bte-graph${drag ? ' dragging' : ''}`} {...view.handlers}>
      <div ref={view.layerRef} className="bt-layer" style={{ width: layout.width, height: layout.height }}>
        <Links links={layout.links.filter((link) => link.child !== SLOT)} running="" width={layout.width} height={layout.height} />
        {slot && (
          <div
            className={`bte-slot${target?.node === 0 ? ' drop-into' : ''}`}
            style={{ left: slot.x, top: slot.y, width: slot.width, height: slot.height }}
          >
            {readOnly ? 'Empty' : 'Add a node from the palette'}
          </div>
        )}
        {[...boxes].map(([index, box]) => (
          <Card
            key={nodes[index].key}
            index={index}
            node={nodes[index]}
            box={box}
            selected={selectedIndex === index}
            showPorts={showPorts}
            vertical={vertical}
            folded={children[index].length === 0 || index === 0 ? -1 : folded.has(nodes[index].key) ? subtreeSizes[index] - 1 : 0}
            dropInto={target?.mode === 'into' && target.node === index && index !== 0}
            dragged={drag?.node === index}
          />
        ))}
        {bar && <div className="bte-drop-bar" style={{ left: bar.x, top: bar.y, width: bar.width, height: bar.height }} />}
        {ghost && drag?.at && (
          <div
            className={`bt-node bte-ghost${target ? '' : ' nowhere'}`}
            style={{ left: drag.at.x - ghost.width / 2, top: drag.at.y - ghost.height / 2, width: ghost.width, height: ghost.height }}
          >
            <div className="bt-node-head">
              <KindIcon node={nodes[drag.node]} />
              <div className="bt-node-labels">
                <span className="bt-node-type">{nodes[drag.node].type}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
