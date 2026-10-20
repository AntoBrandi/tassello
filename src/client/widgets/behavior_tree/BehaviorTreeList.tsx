// The tree as a list: a node per row, under its parent, with its status in
// words and its counts. For narrow widgets and phones, and for the trees
// known only by their log.

import { memo, useEffect, useMemo, useRef } from 'react';

import type { BtNode, BtNodeState } from '../../../shared/protocol.ts';
import { activeNodes, duration, statusLabel, toneOf, type Model } from './model.ts';
import { KindIcon, kindLabel } from './parts.tsx';

interface RowProps {
  index: number;
  node: BtNode;
  depth: number;
  state: BtNodeState | undefined;
  selected: boolean;
  // Its children: -1 none, 0 shown, else folded away, how many nodes they are
  folded: number;
  // For the running ones' durations; 0 for the others, which do not tick
  now: number;
  onSelect: (node: number) => void;
  onFold: (node: number) => void;
}

const Row = memo(function Row({ index, node, depth, state, selected, folded, now, onSelect, onFold }: RowProps) {
  const tone = toneOf(state?.status);
  const result = tone === 'idle' && state?.result ? toneOf(state.result) : null;
  let text = '';
  if (state?.status) {
    text = statusLabel(state.status);
    if (tone === 'running' && state.since && now) {
      text += ` · ${duration(now - state.since)}`;
    } else if (result) {
      text += ` · was ${state.result!.toLowerCase()}`;
    }
  }
  return (
    <li className={`bt-row ${tone}${result ? ` was-${result}` : ''}${selected ? ' selected' : ''}`} data-row={index}>
      <span className="bt-row-indent" style={{ width: depth * 14 }} />
      {folded >= 0 ? (
        <button
          type="button"
          className="bt-row-fold"
          aria-expanded={folded === 0}
          aria-label={folded === 0 ? `Fold ${node.name}` : `Unfold ${node.name}`}
          title={folded === 0 ? undefined : `${folded} nodes folded away`}
          onClick={() => onFold(index)}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <span className="bt-row-fold" />
      )}
      <button type="button" className="bt-row-main" title={`${kindLabel(node)}: ${node.type}`} onClick={() => onSelect(index)}>
        <span className="bt-dot" aria-hidden="true" />
        <KindIcon node={node} />
        <span className="bt-row-labels">
          <span className="bt-row-type">{node.type}</span>
          {node.name !== node.type && <span className="bt-row-name">{node.name}</span>}
        </span>
        <span className="bt-row-status">
          {text}
          {state && state.successes + state.failures > 0 && (
            <span className="bt-row-counts">
              <span className="success">✓{state.successes}</span> <span className="failure">✗{state.failures}</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
});

export interface ListProps {
  model: Model;
  folded: ReadonlySet<number>;
  selected: number | null;
  follow: boolean;
  now: number;
  onSelect: (node: number) => void;
  onFold: (node: number) => void;
}

export function BehaviorTreeList({ model, folded, selected, follow, now, onSelect, onFold }: ListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const { nodes, treeSize, children, depths, states } = model;

  // The rows shown: the nodes in order, those under a folded one left out
  const rows = useMemo(() => {
    const sizes = new Array<number>(nodes.length).fill(1);
    for (let index = treeSize - 1; index > 0; index--) {
      const parent = nodes[index].parent;
      if (parent >= 0) {
        sizes[parent] += sizes[index];
      }
    }
    const shown: { index: number; folded: number }[] = [];
    for (let index = 0; index < nodes.length; ) {
      const hidden = folded.has(index) ? sizes[index] - 1 : 0;
      shown.push({ index, folded: children[index].length === 0 ? -1 : hidden });
      index += hidden + 1;
    }
    return shown;
  }, [nodes, treeSize, children, folded]);

  // The running node at the end of the branch, scrolled to
  const shownAs = (node: number) => {
    let shown = node;
    for (let parent = nodes[node].parent; parent >= 0; parent = nodes[parent].parent) {
      if (folded.has(parent)) {
        shown = parent;
      }
    }
    return shown;
  };
  const activeKey = activeNodes(model, shownAs).join(',');
  // The list only: scrollIntoView would scroll the board to the widget too
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${activeKey.split(',')[0]}"]`);
    if (!follow || !list || !row) {
      return;
    }
    if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  }, [follow, activeKey]);

  const render = ({ index, folded: hidden }: { index: number; folded: number }) => (
    <Row
      key={index}
      index={index}
      node={nodes[index]}
      depth={depths[index]}
      state={states[index]}
      selected={selected === index}
      folded={hidden}
      now={states[index]?.status === 'RUNNING' ? now : 0}
      onSelect={onSelect}
      onFold={onFold}
    />
  );
  const tree = rows.filter((row) => row.index < treeSize);
  const others = rows.filter((row) => row.index >= treeSize);
  return (
    <div ref={listRef} className="bt-list">
      {tree.length > 0 && <ul>{tree.map(render)}</ul>}
      {others.length > 0 && (
        <>
          {treeSize > 0 && <h3 className="bt-list-heading">Not in the tree file</h3>}
          <ul>{others.map(render)}</ul>
        </>
      )}
    </div>
  );
}
