// An XML file as the behavior tree editor edits it: its elements, immutable
// (an edit makes new elements from the one changed up to the root, sharing
// the others: the undo history keeps every version for little), written back
// as it was read but for what changed. The elements left as they were are
// written as they were, with their comments and blank lines; those changed
// are written one per line, indented as the file is, keeping their comments.

import { parseXmlSource, type SourceElement } from '../../../shared/xml.ts';

export interface XmlNode {
  // Unique in the page: what the editor knows the elements by
  key: number;
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly XmlItem[];
  // After an empty line
  blank: boolean;
  // As read, if it was
  source: NodeSource | null;
}

interface NodeSource {
  name: string;
  attributes: XmlNode['attributes'];
  children: XmlNode['children'];
  // From its '<' to the end of its end tag
  text: string;
  // Its start tag, without its end ('>' or '/>')
  open: string;
  // Of its line (null if something precedes it on its line), and of its
  // children's (null if none starts a line)
  indent: string | null;
  childIndent: string | null;
}

// Comments and text, as written
export interface XmlMarkup {
  key: number;
  kind: 'comment' | 'text';
  raw: string;
  blank: boolean;
}

export type XmlItem = XmlNode | XmlMarkup;

export interface XmlDocument {
  // Before and after the root element, as written: the XML declaration, comments
  prolog: string;
  root: XmlNode;
  epilog: string;
  // Of a level
  indent: string;
  newline: string;
}

let nextKey = 1;

export function isNode(item: XmlItem): item is XmlNode {
  return 'name' in item;
}

export function createNode(name: string, attributes: Record<string, string> = {}, children: XmlItem[] = []): XmlNode {
  return { key: nextKey++, name, attributes, children, blank: false, source: null };
}

// A copy, with keys of its own: pasted, duplicated
export function cloneNode(node: XmlNode): XmlNode {
  return {
    ...node,
    key: nextKey++,
    blank: false,
    source: null,
    children: node.children.map((child) => (isNode(child) ? cloneNode(child) : { ...child, key: nextKey++ })),
  };
}

// Throws, naming the line, if the text is not XML
export function parseDocument(text: string): XmlDocument {
  const root = parseXmlSource(text);
  // Its line's indentation, if nothing precedes it on its line
  const indentAt = (index: number) => {
    const before = text.slice(text.lastIndexOf('\n', index - 1) + 1, index);
    return /^[ \t]*$/.test(before) ? before : null;
  };
  const units = new Map<string, number>();
  const convert = (element: SourceElement, blank: boolean): XmlNode => {
    const children: XmlItem[] = [];
    let previous = element.openEnd;
    let childIndent: string | null = null;
    for (const child of element.children) {
      const childBlank = /\n[ \t]*\r?\n/.test(text.slice(previous, child.start));
      childIndent ??= indentAt(child.start);
      children.push(
        child.type === 'element'
          ? convert(child, childBlank)
          : { key: nextKey++, kind: child.type, raw: text.slice(child.start, child.end), blank: childBlank },
      );
      previous = child.end;
    }
    const indent = indentAt(element.start);
    if (indent !== null && childIndent !== null && childIndent.length > indent.length && childIndent.startsWith(indent)) {
      const unit = childIndent.slice(indent.length);
      units.set(unit, (units.get(unit) ?? 0) + 1);
    }
    const source: NodeSource = {
      name: element.name,
      attributes: element.attributes,
      children,
      text: text.slice(element.start, element.end),
      open: text.slice(element.start, element.openEnd).trimEnd(),
      indent,
      childIndent,
    };
    return { key: nextKey++, name: element.name, attributes: element.attributes, children, blank, source };
  };
  const node = convert(root, false);
  const unit = [...units].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '  ';
  return {
    prolog: text.slice(0, root.start),
    root: node,
    epilog: text.slice(root.end),
    indent: unit,
    newline: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

// In attribute values: newlines kept, not read back as spaces
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };

function escape(value: string): string {
  return value.replace(/[&<"\n\r\t]/g, (c) => ESCAPES[c]);
}

function startTag(node: XmlNode): string {
  return `<${node.name}${Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join('')}`;
}

export function writeDocument(document: XmlDocument): string {
  const { indent: unit, newline } = document;
  const write = (node: XmlNode, indent: string): string => {
    const { source } = node;
    const sameTag = source !== null && node.name === source.name && node.attributes === source.attributes;
    if (sameTag && node.children === source.children && (indent === source.indent || !source.text.includes('\n'))) {
      return source.text;
    }
    const open = sameTag ? source.open : startTag(node);
    if (node.children.length === 0) {
      return `${open}/>`;
    }
    // Text only, as a port's description: on its line
    if (node.children.every((child) => !isNode(child) && child.kind === 'text')) {
      return `${open}>${node.children.map((child) => (child as XmlMarkup).raw).join(' ')}</${node.name}>`;
    }
    const childIndent = source && indent === source.indent && source.childIndent !== null ? source.childIndent : indent + unit;
    let text = `${open}>`;
    for (const child of node.children) {
      text += `${child.blank ? newline : ''}${newline}${childIndent}${isNode(child) ? write(child, childIndent) : child.raw}`;
    }
    return `${text}${newline}${indent}</${node.name}>`;
  };
  return document.prolog + write(document.root, document.root.source?.indent ?? '') + document.epilog;
}

// The node of the key, and its ancestors from the root; null if none
export function locate(document: XmlDocument, key: number): { node: XmlNode; ancestors: XmlNode[] } | null {
  const ancestors: XmlNode[] = [];
  const find = (node: XmlNode): XmlNode | null => {
    if (node.key === key) {
      return node;
    }
    ancestors.push(node);
    for (const child of node.children) {
      const found = isNode(child) ? find(child) : null;
      if (found) {
        return found;
      }
    }
    ancestors.pop();
    return null;
  };
  const node = find(document.root);
  return node && { node, ancestors };
}

// The document with the node of the key replaced: by what change makes of it
function change(document: XmlDocument, key: number, update: (node: XmlNode) => XmlNode): XmlDocument {
  const visit = (node: XmlNode): XmlNode => {
    if (node.key === key) {
      return update(node);
    }
    let changed = false;
    const children = node.children.map((child) => {
      const next = isNode(child) ? visit(child) : child;
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...node, children } : node;
  };
  const root = visit(document.root);
  return root === document.root ? document : { ...document, root };
}

// Every node as update makes it, children first; those it keeps kept
export function updateNodes(document: XmlDocument, update: (node: XmlNode) => XmlNode): XmlDocument {
  const visit = (node: XmlNode): XmlNode => {
    let changed = false;
    const children = node.children.map((child) => {
      const next = isNode(child) ? visit(child) : child;
      changed ||= next !== child;
      return next;
    });
    return update(changed ? { ...node, children } : node);
  };
  const root = visit(document.root);
  return root === document.root ? document : { ...document, root };
}

export function setAttribute(document: XmlDocument, key: number, name: string, value: string | null): XmlDocument {
  return change(document, key, (node) => {
    if ((node.attributes[name] ?? null) === value) {
      return node;
    }
    if (value === null) {
      const { [name]: _, ...rest } = node.attributes;
      return { ...node, attributes: rest };
    }
    // A name comes first, as BT.CPP's files have it
    const attributes = name === 'name' && !('name' in node.attributes) ? { name: value, ...node.attributes } : { ...node.attributes, [name]: value };
    return { ...node, attributes };
  });
}

// Its value and place kept
export function renameAttribute(document: XmlDocument, key: number, from: string, to: string): XmlDocument {
  return change(document, key, (node) => {
    if (from === to || !(from in node.attributes)) {
      return node;
    }
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(node.attributes)) {
      if (name !== to) {
        attributes[name === from ? to : name] = value;
      }
    }
    return { ...node, attributes };
  });
}

// In its place: its key, comments and blank line kept
export function replaceNode(document: XmlDocument, key: number, node: XmlNode): XmlDocument {
  return change(document, key, (current) => ({ ...node, key: current.key, blank: current.blank }));
}

export function setNodeName(document: XmlDocument, key: number, name: string): XmlDocument {
  return change(document, key, (node) => (node.name === name ? node : { ...node, name }));
}

// The node's children replaced: by what update makes of them
export function setChildren(document: XmlDocument, key: number, update: (children: readonly XmlItem[]) => XmlItem[]): XmlDocument {
  return change(document, key, (node) => ({ ...node, children: update(node.children) }));
}

// Where the node and the comments just before it start, among the items:
// those not separated from it by an empty line, which go with it
function leadingStart(items: readonly XmlItem[], index: number): number {
  let start = index;
  while (start > 0 && !items[start].blank) {
    const previous = items[start - 1];
    if (isNode(previous) || previous.kind !== 'comment') {
      break;
    }
    start--;
  }
  return start;
}

// Where to insert before the node child index (among the node children), or
// at the end
function insertionPoint(items: readonly XmlItem[], index: number): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    if (isNode(items[i]) && count++ === index) {
      return leadingStart(items, i);
    }
  }
  return items.length;
}

// Of the parent's: the node with its comments
function take(items: readonly XmlItem[], key: number): { rest: XmlItem[]; taken: XmlItem[] } | null {
  const index = items.findIndex((item) => item.key === key);
  if (index === -1) {
    return null;
  }
  const start = leadingStart(items, index);
  return { rest: [...items.slice(0, start), ...items.slice(index + 1)], taken: items.slice(start, index + 1) };
}

// Removed with its comments
export function removeNode(document: XmlDocument, key: number): XmlDocument {
  const parent = locate(document, key)?.ancestors.at(-1);
  if (!parent) {
    return document;
  }
  return setChildren(document, parent.key, (children) => take(children, key)?.rest ?? [...children]);
}

// Among the parent's node children, before the one of index (at the end if
// none)
export function insertNode(document: XmlDocument, parentKey: number, index: number, node: XmlNode): XmlDocument {
  return setChildren(document, parentKey, (children) => {
    const at = insertionPoint(children, index);
    return [...children.slice(0, at), node, ...children.slice(at)];
  });
}

// With its comments, to before the node child index of the parent, as it is
// now; null if it would go into itself
export function moveNode(document: XmlDocument, key: number, parentKey: number, index: number): XmlDocument | null {
  const found = locate(document, key);
  const target = locate(document, parentKey);
  const parent = found?.ancestors.at(-1);
  if (!found || !target || !parent || parentKey === key || target.ancestors.some((ancestor) => ancestor.key === key)) {
    return null;
  }
  // Its own place, as it is now, then without it
  let position = index;
  if (parent.key === parentKey) {
    const current = parent.children.filter(isNode).findIndex((child) => child.key === key);
    if (current < index) {
      position--;
    }
  }
  let moved: XmlItem[] = [];
  const without = setChildren(document, parent.key, (children) => {
    const result = take(children, key)!;
    moved = result.taken;
    return result.rest;
  });
  return setChildren(without, parentKey, (children) => {
    const at = insertionPoint(children, position);
    return [...children.slice(0, at), ...moved, ...children.slice(at)];
  });
}

// The node replaced by the wrapper, its parent; its comments before it
export function wrapNode(document: XmlDocument, key: number, wrapper: XmlNode): XmlDocument {
  const parent = locate(document, key)?.ancestors.at(-1);
  if (!parent) {
    return document;
  }
  return setChildren(document, parent.key, (children) =>
    children.map((child) => (child.key === key ? { ...wrapper, blank: child.blank, children: [{ ...child, blank: false }] } : child)),
  );
}

// The node replaced by its children
export function unwrapNode(document: XmlDocument, key: number): XmlDocument {
  const found = locate(document, key);
  const parent = found?.ancestors.at(-1);
  if (!found || !parent) {
    return document;
  }
  const { node } = found;
  // In its place: after its empty line, if any
  const replacement = node.children.map((child, i) => (i === 0 && node.blank ? { ...child, blank: true } : child));
  return setChildren(document, parent.key, (children) => children.flatMap((child) => (child.key === key ? replacement : [child])));
}
