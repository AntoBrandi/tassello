// A small XML reader, for the behavior trees' files: their elements and
// attributes, which is all BT.CPP's XML is made of. Text, comments,
// processing instructions and doctypes are skipped. No DOM on the server.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  // Of its start tag, from 1: for the error messages
  line: number;
}

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

// The document's root element; throws, naming the line, if it is not XML
export function parseXml(text: string): XmlElement {
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

  let root: XmlElement | null = null;
  const open: XmlElement[] = [];
  let i = 0;
  while (i < text.length) {
    const tag = text.indexOf('<', i);
    if (tag === -1) {
      break;
    }
    i = tag;
    if (text.startsWith('<!--', i)) {
      i = skip(i + 4, '-->', 'Comment');
    } else if (text.startsWith('<![CDATA[', i)) {
      i = skip(i + 9, ']]>', 'CDATA section');
    } else if (text.startsWith('<?', i)) {
      i = skip(i + 2, '?>', 'Processing instruction');
    } else if (text.startsWith('<!', i)) {
      // A doctype, maybe with an internal subset in brackets
      let depth = 0;
      let j = i + 2;
      for (; j < text.length && (text[j] !== '>' || depth > 0); j++) {
        depth += text[j] === '[' ? 1 : text[j] === ']' ? -1 : 0;
      }
      i = j < text.length ? j + 1 : fail(i, 'Doctype not closed');
    } else if (text[i + 1] === '/') {
      END_TAG.lastIndex = i;
      const end = END_TAG.exec(text) ?? fail(i, 'Malformed end tag');
      const element = open.pop();
      if (element?.name !== end[1]) {
        fail(i, element ? `</${end[1]}> closes <${element.name}> of line ${element.line}` : `</${end[1]}> closes nothing`);
      }
      i = END_TAG.lastIndex;
    } else {
      START_TAG.lastIndex = i;
      const start = START_TAG.exec(text) ?? fail(i, 'Malformed tag');
      const attributes: Record<string, string> = {};
      for (const match of start[2].matchAll(ATTRIBUTE)) {
        attributes[match[1]] = decode(match[2] ?? match[3]);
      }
      const element: XmlElement = { name: start[1], attributes, children: [], line: lineAt(i) };
      const parent = open.at(-1);
      if (parent) {
        parent.children.push(element);
      } else if (root) {
        fail(i, `<${element.name}> after the root element`);
      } else {
        root = element;
      }
      if (!start[3]) {
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
