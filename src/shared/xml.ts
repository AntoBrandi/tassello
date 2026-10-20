// A small XML reader, for the behavior trees' files. BT.CPP's XML is made of
// elements and attributes, which is what parseXml gives: the server reads
// the trees with it. parseXmlSource also keeps the comments and text, and
// where each node is in the text: the behavior tree editor writes a file
// back as it was, but for what it changed. No DOM: the server has none.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  // Of its start tag, from 1: for the error messages
  line: number;
}

// An element as written, from start to end in the text
export interface SourceElement {
  type: 'element';
  name: string;
  attributes: Record<string, string>;
  children: SourceNode[];
  line: number;
  start: number;
  // Where its start tag ends: its '>' or '/>'
  openEnd: number;
  end: number;
}

// The rest, as written: comments (and the rare processing instructions and
// doctypes) and text (and CDATA sections), trimmed of whitespace
export interface SourceMarkup {
  type: 'comment' | 'text';
  start: number;
  end: number;
}

export type SourceNode = SourceElement | SourceMarkup;

const START_TAG = /<([A-Za-z_:][-\w:.]*)((?:\s+[A-Za-z_:][-\w:.]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_:][-\w:.]*)\s*>/y;
const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9A-Fa-f]+));/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(ENTITY, (entity, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (name) {
      return NAMED[name];
    }
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// The document's root element, as written; throws, naming the line, if it
// is not XML
export function parseXmlSource(text: string): SourceElement {
  const newlines: number[] = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    newlines.push(i);
  }
  const lineAt = (index: number) => {
    let [low, high] = [0, newlines.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle] < index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low + 1;
  };
  const fail = (index: number, message: string): never => {
    throw new Error(`Line ${lineAt(index)}: ${message}`);
  };
  // Skips to after the terminator, which must come
  const skip = (index: number, terminator: string, what: string) => {
    const end = text.indexOf(terminator, index);
    return end === -1 ? fail(index, `${what} not closed`) : end + terminator.length;
  };

  let root: SourceElement | null = null;
  const open: SourceElement[] = [];
  // Of the element open, if any
  const add = (type: SourceMarkup['type'], start: number, end: number) => open.at(-1)?.children.push({ type, start, end });
  let i = 0;
  while (i < text.length) {
    const tag = text.indexOf('<', i);
    // Text up to it, without its whitespace
    const until = tag === -1 ? text.length : tag;
    const textStart = text.slice(i, until).search(/\S/);
    if (textStart !== -1) {
      add('text', i + textStart, i + text.slice(i, until).trimEnd().length);
    }
    if (tag === -1) {
      break;
    }
    i = tag;
    if (text.startsWith('<!--', i)) {
      i = skip(i + 4, '-->', 'Comment');
      add('comment', tag, i);
    } else if (text.startsWith('<![CDATA[', i)) {
      i = skip(i + 9, ']]>', 'CDATA section');
      add('text', tag, i);
    } else if (text.startsWith('<?', i)) {
      i = skip(i + 2, '?>', 'Processing instruction');
      add('comment', tag, i);
    } else if (text.startsWith('<!', i)) {
      // A doctype, maybe with an internal subset in brackets
      let depth = 0;
      let j = i + 2;
      for (; j < text.length && (text[j] !== '>' || depth > 0); j++) {
        depth += text[j] === '[' ? 1 : text[j] === ']' ? -1 : 0;
      }
      i = j < text.length ? j + 1 : fail(i, 'Doctype not closed');
      add('comment', tag, i);
    } else if (text[i + 1] === '/') {
      END_TAG.lastIndex = i;
      const end = END_TAG.exec(text) ?? fail(i, 'Malformed end tag');
      const element = open.pop();
      if (element?.name !== end[1]) {
        fail(i, element ? `</${end[1]}> closes <${element.name}> of line ${element.line}` : `</${end[1]}> closes nothing`);
      }
      i = END_TAG.lastIndex;
      element!.end = i;
    } else {
      START_TAG.lastIndex = i;
      const start = START_TAG.exec(text) ?? fail(i, 'Malformed tag');
      const attributes: Record<string, string> = {};
      for (const match of start[2].matchAll(ATTRIBUTE)) {
        attributes[match[1]] = decode(match[2] ?? match[3]);
      }
      const selfClosing = start[3] === '/';
      const element: SourceElement = {
        type: 'element',
        name: start[1],
        attributes,
        children: [],
        line: lineAt(i),
        start: i,
        openEnd: START_TAG.lastIndex - (selfClosing ? 2 : 1),
        end: START_TAG.lastIndex,
      };
      const parent = open.at(-1);
      if (parent) {
        parent.children.push(element);
      } else if (root) {
        fail(i, `<${element.name}> after the root element`);
      } else {
        root = element;
      }
      if (!selfClosing) {
        open.push(element);
      }
      i = START_TAG.lastIndex;
    }
  }
  if (open.length > 0) {
    const element = open.at(-1)!;
    throw new Error(`Line ${element.line}: <${element.name}> not closed`);
  }
  if (!root) {
    throw new Error('No XML element');
  }
  return root;
}

// The text of an element's text children, its entities decoded
export function sourceText(text: string, element: SourceElement): string {
  return element.children
    .flatMap((child) => {
      if (child.type !== 'text') {
        return [];
      }
      const raw = text.slice(child.start, child.end);
      return [raw.startsWith('<![CDATA[') ? raw.slice(9, -3) : decode(raw)];
    })
    .join(' ');
}

function elements(element: SourceElement): XmlElement {
  return {
    name: element.name,
    attributes: element.attributes,
    children: element.children.flatMap((child) => (child.type === 'element' ? [elements(child)] : [])),
    line: element.line,
  };
}

// The document's root element: its elements and attributes, the rest
// skipped; throws, naming the line, if it is not XML
export function parseXml(text: string): XmlElement {
  return elements(parseXmlSource(text));
}
