// What the behavior tree inspector knows of the tree: its nodes, as the
// server sends them (src/server/behavior_trees.ts), and their states.

import type {
  BehaviorTreeInfo,
  BehaviorTreeUpdate,
  BtNode,
  BtNodeState,
  BtTransition,
} from '../../../shared/protocol.ts';

// Transitions kept, for the log
const TRANSITIONS = 500;

// Numbered as they come: what the log's rows are known by
export interface LoggedTransition extends BtTransition {
  id: number;
}

export interface Model {
  // The tree's file was read, or failed to be: the server answered
  received: boolean;
  // Of the tree: another for every tree received
  version: number;
  treeId: string;
  // The tree's, then the log's that are not in it
  nodes: BtNode[];
  treeSize: number;
  children: number[][];
  depths: number[];
  // By node; undefined: no state known
  states: (BtNodeState | undefined)[];
  // The latest, oldest first
  transitions: LoggedTransition[];
  nextId: number;
  error: string | null;
  warnings: string[];
  mismatch: string | null;
}

export const EMPTY: Model = {
  received: false,
  version: 0,
  treeId: '',
  nodes: [],
  treeSize: 0,
  children: [],
  depths: [],
  states: [],
  transitions: [],
  nextId: 0,
  error: null,
  warnings: [],
  mismatch: null,
};

export type Action =
  | { type: 'reset' }
  | { type: 'tree'; tree: BehaviorTreeInfo }
  | { type: 'update'; update: BehaviorTreeUpdate };

function sameTree(model: Model, tree: BehaviorTreeInfo): boolean {
  return (
    model.received &&
    model.treeId === tree.treeId &&
    model.treeSize === tree.nodes.length &&
    tree.nodes.every((node, i) => {
      const known = model.nodes[i];
      return (
        known.name === node.name &&
        known.type === node.type &&
        known.parent === node.parent &&
        JSON.stringify(known.ports) === JSON.stringify(node.ports)
      );
    })
  );
}

function withNodes(model: Model, nodes: BtNode[]): Model {
  const children: number[][] = nodes.map(() => []);
  const depths: number[] = [];
  nodes.forEach((node, index) => {
    depths.push(node.parent < 0 ? 0 : depths[node.parent] + 1);
    if (node.parent >= 0) {
      children[node.parent].push(index);
    }
  });
  return { ...model, nodes, children, depths };
}

export function reduce(model: Model, action: Action): Model {
  switch (action.type) {
    case 'reset':
      return { ...EMPTY, version: model.version + 1 };
    case 'tree': {
      const { treeId, nodes, error, warnings } = action.tree;
      if (sameTree(model, action.tree)) {
        // Again, as the connection came back: the reset that follows will do
        return { ...model, error, warnings };
      }
      const tree = { ...EMPTY, received: true, version: model.version + 1, treeId, treeSize: nodes.length, error, warnings };
      return withNodes(tree, nodes);
    }
    case 'update': {
      const { reset, added, states, transitions, mismatch } = action.update;
      let next = model;
      if (reset || added.length > 0) {
        next = withNodes(model, [...model.nodes.slice(0, reset ? model.treeSize : undefined), ...added]);
      }
      const known = reset ? [] : [...model.states];
      for (const state of states) {
        known[state.node] = state;
      }
      const numbered = transitions.map((transition, i) => ({ ...transition, id: model.nextId + i }));
      return {
        ...next,
        states: known,
        transitions: (reset ? numbered : [...model.transitions, ...numbered]).slice(-TRANSITIONS),
        nextId: model.nextId + transitions.length,
        mismatch,
      };
    }
  }
}

export type Tone = 'running' | 'success' | 'failure' | 'skipped' | 'idle';

export function toneOf(status: string | null | undefined): Tone {
  switch (status) {
    case 'RUNNING':
      return 'running';
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'idle';
  }
}

// IDLE -> Idle
export function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// The running nodes none of whose children runs: what the tree is doing.
// visible: the node shown for each, when some are folded away
export function activeNodes(model: Model, visible: (node: number) => number = (node) => node): number[] {
  const active = new Set<number>();
  model.states.forEach((state, node) => {
    if (state?.status === 'RUNNING' && !model.children[node].some((child) => model.states[child]?.status === 'RUNNING')) {
      active.add(visible(node));
    }
  });
  return [...active];
}

// "Type" or "Type · name"
export function nodeLabel(node: BtNode): string {
  return node.name === node.type ? node.type : `${node.type} · ${node.name}`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ${s % 60} s`;
  }
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

// 14:03:27.512, in the page's time zone
export function clockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
