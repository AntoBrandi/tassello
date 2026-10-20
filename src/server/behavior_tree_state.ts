// What a behavior tree's nodes are doing, from the transitions of its log:
// which node each transition is of, then the node's status, last result and
// counts, and the latest transitions.
//
// The log names the nodes, and since Nav2 Jazzy gives their UIDs too, which
// BT.CPP numbers in the order of the tree's nodes (see behavior_tree_file.ts):
// the offset between the two is found from the first transitions, after which
// each UID is its node. Without UIDs, or when they do not fit the tree, nodes
// are found by name; between nodes of the same name (a RecoveryNode named
// after its action, the many Sequences), by what the transition says of the
// node's status and what is known of its parent's: BT.CPP only ticks, halts
// and resets the children of a running node.

import type { BtNode, BtNodeState, BtTransition } from '../shared/protocol.ts';
import type { LogTransition } from './behavior_tree_log.ts';

export interface Changes {
  added: BtNode[];
  states: BtNodeState[];
  transitions: BtTransition[];
  mismatch: string | null;
}

// Kept for the pages to come, and between two updates
const MAX_TRANSITIONS = 300;
// Of the log not in the tree: beyond them, the log is not worth listing
const MAX_ADDED = 1000;
// UIDs that do not fit in a row: the robot runs another tree, look again
const UID_MISSES = 3;

interface NodeState extends BtNodeState {
  // When it last changed, in the order of the transitions
  seq: number;
}

export class BehaviorTreeState {
  readonly nodes: BtNode[];
  private readonly treeSize: number;
  private readonly states: NodeState[] = [];
  private readonly depths: number[] = [];
  private readonly byName = new Map<string, number[]>();
  // The nodes added, by UID and name, or name
  private readonly added = new Map<string, number>();
  private uidOffset: number | null = null;
  // The offsets the transitions so far allow, until one is left, and how
  // many transitions agreed on them
  private uidOffsets: Set<number> | null = null;
  private uidSamples = 0;
  private uidMisses = 0;
  private uidUnfit = false;
  private seq = 0;
  private readonly recent: BtTransition[] = [];
  // Since the last takeChanges
  private readonly dirty = new Set<number>();
  private pending: BtTransition[] = [];
  private addedSince: number;
  private mismatchSent: string | null = null;

  constructor(tree: BtNode[]) {
    this.nodes = [...tree];
    this.treeSize = tree.length;
    this.addedSince = tree.length;
    tree.forEach((node, index) => {
      this.states.push(this.blank(index));
      this.depths.push(node.parent < 0 ? 0 : this.depths[node.parent] + 1);
      const same = this.byName.get(node.name);
      if (same) {
        same.push(index);
      } else {
        this.byName.set(node.name, [index]);
      }
    });
  }

  apply(transition: LogTransition, now: number): void {
    const index = this.resolve(transition);
    if (index === null) {
      return;
    }
    const { from, to } = transition;
    const state = this.states[index];
    state.status = to;
    state.since = now;
    state.changes++;
    state.seq = ++this.seq;
    if (to === 'SUCCESS' || to === 'FAILURE') {
      state.result = to;
      state[to === 'SUCCESS' ? 'successes' : 'failures']++;
    }
    this.dirty.add(index);
    // Ticked, or running: so are its ancestors, whose start came before
    if ((to !== 'IDLE' && to !== 'SKIPPED') || from === 'RUNNING') {
      for (let p = this.nodes[index].parent; p >= 0 && this.states[p].status === null; p = this.nodes[p].parent) {
        this.states[p].status = 'RUNNING';
        this.dirty.add(p);
      }
    }
    const entry = { time: transition.time, node: index, from, to };
    this.recent.push(entry);
    if (this.recent.length > MAX_TRANSITIONS) {
      this.recent.shift();
    }
    this.pending.push(entry);
    if (this.pending.length > MAX_TRANSITIONS) {
      this.pending.shift();
    }
  }

  // What changed since the last call, null if nothing
  takeChanges(): Changes | null {
    const mismatch = this.mismatch();
    if (this.dirty.size === 0 && this.pending.length === 0 && mismatch === this.mismatchSent) {
      return null;
    }
    const changes = {
      added: this.nodes.slice(this.addedSince),
      states: [...this.dirty].map((index) => this.stateOf(index)),
      transitions: this.pending,
      mismatch,
    };
    this.dirty.clear();
    this.pending = [];
    this.addedSince = this.nodes.length;
    this.mismatchSent = mismatch;
    return changes;
  }

  // Everything known, for a page that comes; what changed so far is sent
  // with it, not again
  snapshot(): Changes {
    this.takeChanges();
    return {
      added: this.nodes.slice(this.treeSize),
      states: this.states.flatMap((state, index) => (state.status === null ? [] : [this.stateOf(index)])),
      transitions: [...this.recent],
      mismatch: this.mismatchSent,
    };
  }

  private blank(node: number): NodeState {
    return { node, status: null, result: null, since: 0, changes: 0, successes: 0, failures: 0, seq: 0 };
  }

  private stateOf(index: number): BtNodeState {
    const { seq: _, ...state } = this.states[index];
    return state;
  }

  private resolve(transition: LogTransition): number | null {
    if (this.treeSize > 0 && this.byName.has(transition.name)) {
      return (transition.uid === null ? null : this.byUid(transition.uid, transition.name)) ?? this.byStatus(transition);
    }
    return this.add(transition);
  }

  private byUid(uid: number, name: string): number | null {
    if (this.uidOffset !== null) {
      const index = uid - this.uidOffset;
      if (index >= 0 && index < this.treeSize && this.nodes[index].name === name) {
        this.uidMisses = 0;
        return index;
      }
      if (++this.uidMisses >= UID_MISSES) {
        this.uidOffset = null;
        this.uidMisses = 0;
        this.uidUnfit = true;
      }
      return null;
    }
    const offsets = new Set(this.byName.get(name)!.map((index) => uid - index));
    this.uidOffsets = this.uidOffsets ? new Set([...this.uidOffsets].filter((o) => offsets.has(o))) : offsets;
    this.uidSamples++;
    if (this.uidOffsets.size === 1 && this.uidSamples >= 2) {
      this.uidOffset = [...this.uidOffsets][0];
      this.uidOffsets = null;
      this.uidSamples = 0;
      this.uidUnfit = false;
      return uid - this.uidOffset;
    }
    if (this.uidOffsets.size === 0) {
      // Not the file's order: by name, and again from the next transitions
      this.uidOffsets = null;
      this.uidSamples = 0;
      this.uidUnfit = true;
    }
    return null;
  }

  // The node of that name the transition fits best: in the status it leaves,
  // under a running parent (or one not known yet, which may be). Ties go to
  // the node whose parent changed last; then parents start before their
  // children, which finish and are reset first.
  private byStatus({ name, from, to }: LogTransition): number {
    const candidates = this.byName.get(name)!;
    if (candidates.length === 1) {
      return candidates[0];
    }
    const starting = from === 'IDLE';
    let best = candidates[0];
    let bestKey: number[] = [];
    for (const index of candidates) {
      const status = this.states[index].status;
      const parent = this.nodes[index].parent;
      const parentStatus = parent < 0 ? 'RUNNING' : this.states[parent].status;
      const key = [
        (status === from ? 4 : status === null ? 2 : 0) + (parentStatus === 'RUNNING' || parentStatus === null ? 2 : 0),
        parent < 0 ? 0 : this.states[parent].seq,
        starting ? -this.depths[index] : this.depths[index],
      ];
      const better = key.findIndex((value, i) => value !== bestKey[i]);
      if (bestKey.length === 0 || (better !== -1 && key[better] > bestKey[better])) {
        best = index;
        bestKey = key;
      }
    }
    return best;
  }

  // A node not in the tree: listed after the others
  private add({ uid, name }: LogTransition): number | null {
    const key = uid === null ? name : `${uid} ${name}`;
    let index = this.added.get(key);
    if (index === undefined) {
      if (this.added.size >= MAX_ADDED) {
        return null;
      }
      index = this.nodes.length;
      this.nodes.push({ name, type: name, kind: null, parent: -1, ports: {} });
      this.states.push(this.blank(index));
      this.depths.push(0);
      this.added.set(key, index);
    }
    return index;
  }

  private mismatch(): string | null {
    const missing = this.nodes.length - this.treeSize;
    if (this.treeSize === 0) {
      return null;
    }
    if (missing > 0) {
      const names = this.nodes.slice(this.treeSize, this.treeSize + 3).map((node) => node.name).join(', ');
      return `${missing === 1 ? 'A node' : `${missing} nodes`} of the log not in the tree file (${names}${missing > 3 ? ', …' : ''}): is it the tree the robot runs?`;
    }
    return this.uidUnfit ? 'UIDs of the log that do not fit the tree file: its nodes are found by name' : null;
  }
}
