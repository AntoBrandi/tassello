// The behavior trees' XML files (BT.CPP's format, 3 and 4), for the behavior
// tree inspector widgets: the tree the robot runs, as BT.CPP instantiates it,
// its nodes in the order of their UIDs: depth first, from the first child of
// the main BehaviorTree, each SubTree followed by its tree's nodes.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXPLICIT, guessKind } from '../shared/bt_nodes.ts';
import type { BehaviorTreeInfo, BtNode, BtNodeKind } from '../shared/protocol.ts';
import { parseXml, type XmlElement } from '../shared/xml.ts';
import { isUploadName } from './files.ts';
import { errorMessage, packageShareDirectory, type Logger } from './util.ts';

export interface BehaviorTreeFile {
  treeId: string;
  nodes: BtNode[];
  warnings: string[];
  // The files read, the tree's and its includes': it is read again when they change
  files: string[];
}

// Beyond this, a file (or a recursion of subtrees missed) is not a tree to show
const MAX_NODES = 5000;
const PACKAGE_URL = /^package:\/\/([^/]+)\/(.+)$/;

// The XML file a widget names: a robot path (/…, ~/…), package://… or
// uploads/<name>. Throws for anything else: only XML files are read.
export function resolveTreeFile(source: string, uploadsDir: string, home = os.homedir()): string {
  const value = source.trim();
  let file: string;
  if (value.startsWith('uploads/')) {
    const name = value.slice('uploads/'.length);
    if (!isUploadName(name)) {
      throw new Error(`No upload "${name}"`);
    }
    file = path.join(uploadsDir, name);
  } else if (PACKAGE_URL.test(value)) {
    const [, name, relative] = PACKAGE_URL.exec(value)!;
    const share = packageShareDirectory(name);
    if (!share) {
      throw new Error(`No package "${name}": is its workspace sourced?`);
    }
    file = path.resolve(share, relative);
    if (!file.startsWith(share + path.sep)) {
      throw new Error(`"${value}" is not in its package`);
    }
  } else {
    const expanded = value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value;
    if (!path.isAbsolute(expanded)) {
      throw new Error(`Not a path: "${source}" (/…, ~/…, package://…)`);
    }
    file = path.resolve(expanded);
  }
  if (path.extname(file).toLowerCase() !== '.xml') {
    throw new Error(`Not an XML file: "${source}"`);
  }
  return file;
}

function modelKinds(root: XmlElement, kinds: Map<string, BtNodeKind>): void {
  for (const model of root.children.filter((child) => child.name === 'TreeNodesModel')) {
    for (const node of model.children) {
      const kind = EXPLICIT[node.name];
      if (kind && node.attributes.ID) {
        kinds.set(node.attributes.ID, kind);
      }
    }
  }
}

// Nav2's node models, when installed: what its nodes are
let nav2Kinds: Promise<Map<string, BtNodeKind>> | null = null;

function loadNav2Kinds(): Promise<Map<string, BtNodeKind>> {
  nav2Kinds ??= (async () => {
    const kinds = new Map<string, BtNodeKind>();
    const share = packageShareDirectory('nav2_behavior_tree');
    if (share) {
      try {
        modelKinds(parseXml(await fs.readFile(path.join(share, 'nav2_tree_nodes.xml'), 'utf8')), kinds);
      } catch {
        // Not there, or not readable: the known nodes and the guesses will do
      }
    }
    return kinds;
  })();
  return nav2Kinds;
}

// The tree's nodes, from the main BehaviorTree; subtrees not defined, and
// recursions, are reported and left unexpanded
export function instantiate(
  trees: Map<string, XmlElement>,
  mainId: string,
  kinds: Map<string, BtNodeKind>,
  warnings: string[],
): BtNode[] {
  const nodes: BtNode[] = [];
  const visit = (element: XmlElement, parent: number, expanding: string[]) => {
    if (nodes.length >= MAX_NODES) {
      throw new Error(`The tree has more than ${MAX_NODES} nodes`);
    }
    const explicit = EXPLICIT[element.name];
    const { name, ...ports } = element.attributes;
    let type = element.name;
    if (explicit === 'subtree') {
      type = 'SubTree';
    } else if (explicit && ports.ID) {
      type = ports.ID;
      delete ports.ID;
    }
    const subtreeId = explicit === 'subtree' ? (ports.ID ?? '') : '';
    const index = nodes.length;
    nodes.push({
      name: name ?? (subtreeId || type),
      type,
      kind: explicit ?? kinds.get(type) ?? guessKind(type, element.children.length),
      parent,
      ports,
    });
    if (explicit !== 'subtree') {
      for (const child of element.children) {
        visit(child, index, expanding);
      }
      return;
    }
    const definition = trees.get(subtreeId);
    if (!subtreeId) {
      warnings.push(`A SubTree without ID, line ${element.line}`);
    } else if (expanding.includes(subtreeId)) {
      warnings.push(`The subtree ${subtreeId} includes itself, line ${element.line}`);
    } else if (!definition) {
      warnings.push(`No BehaviorTree ${subtreeId}, for the SubTree of line ${element.line}`);
    } else if (definition.children[0]) {
      visit(definition.children[0], index, [...expanding, subtreeId]);
    }
  };
  const main = trees.get(mainId)?.children[0];
  if (!main) {
    throw new Error(`The BehaviorTree ${mainId} is empty`);
  }
  visit(main, -1, [mainId]);
  return nodes;
}

// The tree of the file, its includes followed (relative to it, or to their
// ros_pkg's share directory). The main tree is the one main_tree_to_execute
// names, else the first of the file that no other uses as a subtree.
export async function loadBehaviorTree(file: string): Promise<BehaviorTreeFile> {
  const trees = new Map<string, XmlElement>();
  // The trees of the file itself, in order
  const own: string[] = [];
  const kinds = new Map(await loadNav2Kinds());
  const warnings: string[] = [];
  const files: string[] = [];
  let mainId = '';

  const read = async (current: string, top: boolean) => {
    files.push(current);
    let root: XmlElement;
    try {
      root = parseXml(await fs.readFile(current, 'utf8'));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new Error(`Cannot read ${current}: ${code ?? errorMessage(e)}`);
    }
    if (root.name !== 'root') {
      throw new Error(`${current} is not a behavior tree: its root element is <${root.name}>, not <root>`);
    }
    if (top) {
      mainId = root.attributes.main_tree_to_execute ?? '';
    }
    modelKinds(root, kinds);
    for (const child of root.children) {
      if (child.name === 'include') {
        const { ros_pkg: rosPackage, path: relative = '' } = child.attributes;
        const share = rosPackage ? packageShareDirectory(rosPackage) : path.dirname(current);
        if (!share) {
          warnings.push(`Not included: ${relative}, of the package ${rosPackage}, not found`);
          continue;
        }
        const included = path.resolve(share, relative);
        if (files.includes(included)) {
          continue;
        }
        try {
          await read(included, false);
        } catch (e) {
          warnings.push(`Not included: ${errorMessage(e)}`);
        }
      } else if (child.name === 'BehaviorTree') {
        const id = child.attributes.ID ?? (trees.size === 0 ? 'MainTree' : `BehaviorTree ${trees.size + 1}`);
        if (trees.has(id)) {
          warnings.push(`BehaviorTree ${id} defined twice: the first one is shown`);
          continue;
        }
        trees.set(id, child);
        if (top) {
          own.push(id);
        }
      }
    }
  };

  await read(file, true);
  if (trees.size === 0) {
    throw new Error(`${file} has no BehaviorTree`);
  }
  if (mainId && !trees.has(mainId)) {
    warnings.push(`No BehaviorTree ${mainId}, the main_tree_to_execute`);
    mainId = '';
  }
  if (!mainId) {
    const used = new Set<string>();
    const collect = (element: XmlElement) => {
      if (EXPLICIT[element.name] === 'subtree' && element.attributes.ID) {
        used.add(element.attributes.ID);
      }
      element.children.forEach(collect);
    };
    trees.forEach(collect);
    const candidates = [...own, ...trees.keys()];
    mainId = candidates.find((id) => !used.has(id)) ?? candidates[0];
  }
  return { treeId: mainId, nodes: instantiate(trees, mainId, kinds, warnings), warnings, files };
}

export type TreeInfo = Omit<BehaviorTreeInfo, 'type' | 'id'>;

// The tree a widget names (empty: none), or why it could not be read; and
// the files read, to read it again when they change
export async function readTree(source: string, uploadsDir: string, logger: Logger): Promise<{ tree: TreeInfo; files: string[] }> {
  const tree: TreeInfo = { treeId: '', nodes: [], error: null, warnings: [] };
  if (!source) {
    return { tree, files: [] };
  }
  let files: string[] = [];
  try {
    const file = resolveTreeFile(source, uploadsDir);
    files = [file];
    const loaded = await loadBehaviorTree(file);
    return { tree: { treeId: loaded.treeId, nodes: loaded.nodes, error: null, warnings: loaded.warnings }, files: loaded.files };
  } catch (e) {
    logger.warn(`Behavior tree ${source}: ${errorMessage(e)}`);
    return { tree: { ...tree, error: errorMessage(e) }, files };
  }
}
