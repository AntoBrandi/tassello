// The tree as a graph: its nodes coloured by what they do now, the links to
// the running ones lit, so that the running branch shows from the root to the
// node at its end. Drag to pan, scroll or pinch to zoom (pan_zoom.ts), click
// a node for its details, click under a node to fold its children away.
//
// The view moves the layer of nodes as a whole: a node renders again only
// when its state changes.

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import type { BtNode, BtNodeState } from '../../../shared/protocol.ts';
import { layoutTree, type Box, type Direction, type Link, type Size } from './layout.ts';
import { activeNodes, statusLabel, toneOf, type Model, type Tone } from './model.ts';
import { reducedMotion, usePanZoom } from './pan_zoom.ts';
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
export const GAPS = { siblings: 18, levels: 46 };

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
export function measure(nodes: Pick<BtNode, 'name' | 'type' | 'ports'>[], showPorts: boolean): Size[] {
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
export const Links = memo(function Links({ links, running, width, height }: { links: Link[]; running: string; width: number; height: number }) {
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

  // Tapped: the fold toggle, a node, or nothing
  const keepRef = useRef<(node: number) => void>(() => {});
  const onTap = (target: Element) => {
    const toggle = target.closest('[data-fold]');
    const card = target.closest('[data-node]');
    if (toggle) {
      const node = Number(toggle.getAttribute('data-fold'));
      keepRef.current(node);
      onFold(node);
    } else {
      onSelect(card ? Number(card.getAttribute('data-node')) : null);
    }
  };
  const { viewportRef, layerRef, handlers, fit, reveal, keepInPlace } = usePanZoom({
    layout,
    root: roots[0],
    vertical,
    covered,
    version: model.version,
    onTap,
    onPan,
  });
  keepRef.current = keepInPlace;

  // Followed, the view is the user's: a new layout keeps it
  useEffect(() => {
    if (follow && activeKey) {
      reveal(activeKey.split(',').map(Number), false);
    }
  }, [follow, activeKey, reveal]);

  // Only when asked, not when the functions change
  useEffect(() => {
    if (focus) {
      reveal([shownAs(focus.node)], true);
    }
  }, [focus]);

  // Selected here, maybe where its details come
  useEffect(() => {
    if (selected !== null && covered > 0) {
      reveal([shownAs(selected)], false);
    }
  }, [selected, covered]);

  useEffect(() => {
    if (fitRequest > 0) {
      fit(true);
    }
  }, [fitRequest]);

  return (
    <div ref={viewportRef} className="bt-graph" {...handlers}>
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
