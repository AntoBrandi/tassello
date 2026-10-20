// What the behavior tree editor makes of a file (xml_document.ts): its
// BehaviorTrees, their nodes as the graph shows them (kinds, ports, what is
// wrong with them), the nodes it can add (their models: BT.CPP's, Nav2's,
// the libraries' and the file's own), and where a node may go.

import { builtinModels, EXPLICIT, guessKind, readModels, type BtNodeModel, type ModelElement } from '../../../shared/bt_nodes.ts';
import type { BtNodeKind, BtNodeLibrary } from '../../../shared/protocol.ts';
import type { Box } from './layout.ts';
import {
  createNode,
  insertNode,
  isNode,
  removeNode,
  setAttribute,
  updateNodes,
  type XmlDocument,
  type XmlNode,
} from './xml_document.ts';

export interface TreeEntry {
  key: number;
  // '' if it has none
  id: string;
  node: XmlNode;
}

// The file's BehaviorTrees, in order
export function behaviorTrees(document: XmlDocument): TreeEntry[] {
  return document.root.children.flatMap((child) =>
    isNode(child) && child.name === 'BehaviorTree' ? [{ key: child.key, id: child.attributes.ID ?? '', node: child }] : [],
  );
}

// 4 when the file says BTCPP_format="4" (ROS 2 Jazzy's BT.CPP on), else 3
export function treeFormat(document: XmlDocument): 3 | 4 {
  return document.root.attributes.BTCPP_format?.trim() === '4' ? 4 : 3;
}

function subtreeIds(node: XmlNode, ids: Set<string>): Set<string> {
  if (EXPLICIT[node.name] === 'subtree' && node.attributes.ID) {
    ids.add(node.attributes.ID);
  }
  for (const child of node.children) {
    if (isNode(child)) {
      subtreeIds(child, ids);
    }
  }
  return ids;
}

// The tree BT.CPP runs: the one main_tree_to_execute names, else the first
// that no other uses as a subtree (as src/server/behavior_tree_file.ts)
export function mainTree(document: XmlDocument): TreeEntry | undefined {
  const trees = behaviorTrees(document);
  const named = document.root.attributes.main_tree_to_execute;
  const main = named ? trees.find((tree) => tree.id === named) : undefined;
  if (main) {
    return main;
  }
  const used = subtreeIds(document.root, new Set());
  return trees.find((tree) => !used.has(tree.id)) ?? trees[0];
}

// What a node is, as BT.CPP reads it: <Action ID="Spin"/> is a Spin
export function nodeType(node: XmlNode): string {
  const explicit = EXPLICIT[node.name];
  if (explicit === 'subtree') {
    return 'SubTree';
  }
  return explicit && node.attributes.ID ? node.attributes.ID : node.name;
}

// Its ports: its attributes but its name, and the ID that gives its type
export function nodePorts(node: XmlNode): Record<string, string> {
  const ports: Record<string, string> = { ...node.attributes };
  delete ports.name;
  const explicit = EXPLICIT[node.name];
  if (explicit && explicit !== 'subtree') {
    delete ports.ID;
  }
  return ports;
}

// The models of the file's own TreeNodesModel
export function documentModels(document: XmlDocument): BtNodeModel[] {
  const convert = (node: XmlNode): ModelElement => ({
    name: node.name,
    attributes: node.attributes,
    children: node.children.filter(isNode).map(convert),
    text: node.children.flatMap((child) => (!isNode(child) && child.kind === 'text' ? [child.raw] : [])).join(' '),
  });
  return readModels(convert(document.root));
}

export interface CatalogEntry {
  model: BtNodeModel;
  // Where it comes from: BT.CPP, Nav2, a library's file name, This file
  library: string;
}

export interface Catalog {
  byId: Map<string, CatalogEntry>;
  // The trees a SubTree may name: the file's, then its includes'
  trees: string[];
  // The includes' trees: their files
  treeFiles: Map<string, string>;
}

// The nodes known: BT.CPP's, then the libraries' (Nav2's first), then the
// file's own, each overriding the ones before
export function buildCatalog(document: XmlDocument, libraries: BtNodeLibrary[], includedTrees: { id: string; file: string }[]): Catalog {
  const byId = new Map<string, CatalogEntry>();
  for (const model of builtinModels(treeFormat(document))) {
    byId.set(model.id, { model, library: 'BT.CPP' });
  }
  for (const library of libraries) {
    for (const model of library.models) {
      byId.set(model.id, { model, library: library.name });
    }
  }
  for (const model of documentModels(document)) {
    byId.set(model.id, { model, library: 'This file' });
  }
  const own = behaviorTrees(document).flatMap((tree) => (tree.id ? [tree.id] : []));
  const treeFiles = new Map(includedTrees.filter((tree) => !own.includes(tree.id)).map((tree) => [tree.id, tree.file]));
  return { byId, trees: [...own, ...treeFiles.keys()], treeFiles };
}

export interface GraphNode {
  key: number;
  // BehaviorTree for the tree itself, the graph's first node
  type: string;
  name: string;
  // null for the tree itself
  kind: BtNodeKind | null;
  parent: number;
  ports: Record<string, string>;
  model: CatalogEntry | null;
  // How many children it takes
  capacity: number;
  // What is wrong with it
  problems: string[];
}

export interface EditorGraph {
  nodes: GraphNode[];
  children: number[][];
  // Of all the nodes
  problems: number;
}

const KIND_NAMES: Record<BtNodeKind, string> = {
  action: 'An action',
  condition: 'A condition',
  control: 'A control node',
  decorator: 'A decorator',
  subtree: 'A subtree',
};

// The tree's nodes, depth first from the tree itself
export function treeGraph(tree: XmlNode, catalog: Catalog): EditorGraph {
  const nodes: GraphNode[] = [];
  const children: number[][] = [];
  let problems = 0;
  const visit = (node: XmlNode, parent: number) => {
    const index = nodes.length;
    const kids = node.children.filter(isNode);
    const graphNode: GraphNode = {
      key: node.key,
      type: 'BehaviorTree',
      name: node.attributes.ID ?? '',
      kind: null,
      parent,
      ports: {},
      model: null,
      capacity: 1,
      problems: [],
    };
    if (parent >= 0) {
      const type = nodeType(node);
      const model = catalog.byId.get(type) ?? null;
      const explicit = EXPLICIT[node.name];
      const kind = explicit === 'subtree' ? 'subtree' : (model?.model.kind ?? explicit ?? guessKind(type, kids.length));
      Object.assign(graphNode, {
        type,
        name: node.attributes.name ?? (kind === 'subtree' ? (node.attributes.ID ?? type) : type),
        kind,
        ports: nodePorts(node),
        model,
        // What it is not known: as many as it has, if any
        capacity: !model && !explicit && kids.length > 0 ? Infinity : kind === 'control' ? Infinity : kind === 'decorator' ? 1 : 0,
      });
      if (kind === 'subtree') {
        const id = node.attributes.ID;
        if (!id) {
          graphNode.problems.push('No subtree: set its ID');
        } else if (!catalog.trees.includes(id)) {
          graphNode.problems.push(`No tree ${id}, in the file nor its includes`);
        }
      }
    }
    if (graphNode.capacity === 0 && kids.length > 0) {
      graphNode.problems.push(`${KIND_NAMES[graphNode.kind!]} has no children: it has ${kids.length}`);
    } else if (graphNode.kind === null && kids.length !== 1) {
      graphNode.problems.push(kids.length === 0 ? 'Empty: a tree runs one node, at its root' : `A tree has one node at its root, not ${kids.length}`);
    } else if (graphNode.kind === 'decorator' && kids.length !== 1) {
      graphNode.problems.push(`A decorator has one child, not ${kids.length}`);
    } else if (graphNode.kind === 'control' && kids.length === 0 && graphNode.model) {
      graphNode.problems.push('A control node needs children');
    }
    problems += graphNode.problems.length > 0 ? 1 : 0;
    nodes.push(graphNode);
    children.push([]);
    for (const kid of kids) {
      children[index].push(nodes.length);
      visit(kid, index);
    }
  };
  visit(tree, -1);
  return { nodes, children, problems };
}

// A new node of the model, its ports left to BT.CPP's defaults; of a
// tree's ID, for SubTree: its ports those of the tree's blackboard
export function newNode(model: BtNodeModel, format: 3 | 4): XmlNode {
  if (model.kind === 'subtree') {
    return createNode('SubTree', { ID: model.id, ...(format === 4 ? { _autoremap: 'true' } : { __shared_blackboard: 'true' }) });
  }
  return createNode(model.id);
}

export interface DropTarget {
  // Graph indices: the new parent, and where among its children (as they
  // are now)
  parent: number;
  index: number;
  // Shown at the node: into it, or beside it
  mode: 'into' | 'before' | 'after';
  node: number;
}

// Room for another child: those it has but the one moved
function room(graph: EditorGraph, node: number, moved: number | null): boolean {
  const count = graph.children[node].length - (moved !== null && graph.children[node].includes(moved) ? 1 : 0);
  return graph.nodes[node].capacity > count;
}

function within(graph: EditorGraph, node: number, ancestor: number): boolean {
  for (let current = node; current >= 0; current = graph.nodes[current].parent) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

// Where the node moved (null: a new one) would go, dropped at the point;
// null if nowhere. On a node: into it at its middle, if it takes another
// child, else before or after it, as its side is nearer.
export function dropTarget(
  graph: EditorGraph,
  boxes: Map<number, Box>,
  point: { x: number; y: number },
  moved: number | null,
  vertical: boolean,
  // Around the boxes, still theirs
  slack = 8,
): DropTarget | null {
  let node = -1;
  let box: Box | undefined;
  for (const [index, candidate] of boxes) {
    if (
      point.x >= candidate.x - slack &&
      point.x <= candidate.x + candidate.width + slack &&
      point.y >= candidate.y - slack &&
      point.y <= candidate.y + candidate.height + slack
    ) {
      [node, box] = [index, candidate];
      break;
    }
  }
  if (!box || (moved !== null && within(graph, node, moved))) {
    return null;
  }
  const along = vertical ? (point.x - box.x) / box.width : (point.y - box.y) / box.height;
  const parent = graph.nodes[node].parent;
  const into = room(graph, node, moved);
  const beside = parent >= 0 && room(graph, parent, moved);
  let mode: DropTarget['mode'];
  if (into && (!beside || (along >= 0.3 && along <= 0.7))) {
    mode = 'into';
  } else if (beside) {
    mode = along < 0.5 ? 'before' : 'after';
  } else {
    return null;
  }
  if (mode === 'into') {
    return { parent: node, index: graph.children[node].length, mode, node };
  }
  const index = graph.children[parent].indexOf(node) + (mode === 'after' ? 1 : 0);
  // Where it is already
  if (moved !== null && graph.nodes[moved].parent === parent) {
    const current = graph.children[parent].indexOf(moved);
    if (index === current || index === current + 1) {
      return null;
    }
  }
  return { parent, index, mode, node };
}

// Where a node added with the selection goes: into it if it takes another
// child, else after it; into the tree if empty
export function insertionPoint(graph: EditorGraph, selected: number | null): { parent: number; index: number } | null {
  const target = selected ?? 0;
  if (room(graph, target, null)) {
    return { parent: target, index: graph.children[target].length };
  }
  const parent = graph.nodes[target].parent;
  if (parent >= 0 && room(graph, parent, null)) {
    return { parent, index: graph.children[parent].indexOf(target) + 1 };
  }
  return null;
}

// Whether the node may be replaced by its children: its parent takes them
export function canUnwrap(graph: EditorGraph, node: number): boolean {
  const parent = graph.nodes[node].parent;
  if (parent < 0 || graph.children[node].length === 0) {
    return false;
  }
  return graph.nodes[parent].capacity >= graph.children[parent].length - 1 + graph.children[node].length;
}

// A tree ID not taken: Name, Name2…
export function freeTreeId(document: XmlDocument, base: string): string {
  const taken = new Set(behaviorTrees(document).map((tree) => tree.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) {
    id = `${base}${n}`;
  }
  return id;
}

// A new empty BehaviorTree, after the others
export function addTree(document: XmlDocument, id: string): { document: XmlDocument; key: number } {
  const tree = createNode('BehaviorTree', { ID: id });
  const index = document.root.children.filter(isNode).findLastIndex((node) => node.name === 'BehaviorTree') + 1;
  return { document: insertNode(document, document.root.key, index, tree), key: tree.key };
}

// The tree's ID, and those of the subtrees and the main tree naming it
export function renameTree(document: XmlDocument, key: number, id: string): XmlDocument {
  const old = behaviorTrees(document).find((tree) => tree.key === key)?.id;
  if (old === undefined || old === id) {
    return document;
  }
  let renamed = setAttribute(document, key, 'ID', id);
  if (old) {
    renamed = updateNodes(renamed, (node) =>
      EXPLICIT[node.name] === 'subtree' && node.attributes.ID === old ? { ...node, attributes: { ...node.attributes, ID: id } } : node,
    );
    if (renamed.root.attributes.main_tree_to_execute === old) {
      renamed = setAttribute(renamed, renamed.root.key, 'main_tree_to_execute', id);
    }
  }
  return renamed;
}

export function setMainTree(document: XmlDocument, id: string): XmlDocument {
  return setAttribute(document, document.root.key, 'main_tree_to_execute', id);
}

// Removed, and no longer the main tree
export function removeTree(document: XmlDocument, key: number): XmlDocument {
  const id = behaviorTrees(document).find((tree) => tree.key === key)?.id;
  const removed = removeNode(document, key);
  return id && removed.root.attributes.main_tree_to_execute === id
    ? setAttribute(removed, removed.root.key, 'main_tree_to_execute', null)
    : removed;
}

// The node as one of the model: its children, name and ports kept
export function withType(node: XmlNode, model: BtNodeModel, format: 3 | 4): XmlNode {
  const replacement = newNode(model, format);
  const attributes: Record<string, string> = { ...node.attributes };
  if (EXPLICIT[node.name]) {
    delete attributes.ID;
  }
  return { ...node, name: replacement.name, attributes: { ...attributes, ...replacement.attributes } };
}
