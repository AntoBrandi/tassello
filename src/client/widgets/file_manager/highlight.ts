// The editor's syntax highlighting, for the files of a robot: YAML (params,
// rviz), XML (URDF, xacro, launch, SDF), Python, C++, CMake, JSON, shell,
// INI (systemd units, TOML), Markdown, ROS interfaces (.msg, .srv, .action),
// JavaScript. A line at a time, from the state the line before ended in:
// block comments, multi-line strings, XML tags over several lines.

export type Token =
  | 'comment'
  | 'string'
  | 'number'
  | 'atom'
  | 'keyword'
  | 'type'
  | 'function'
  | 'variable'
  | 'tag'
  | 'attribute'
  | 'key'
  | 'meta'
  | 'heading'
  | 'emphasis'
  | 'link'
  | 'punctuation';

// Of a line: its parts in order, their length and token ('' plain)
export type Span = [length: number, token: Token | ''];

export type Language =
  | 'plain'
  | 'cpp'
  | 'cmake'
  | 'ini'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'python'
  | 'ros'
  | 'shell'
  | 'xml'
  | 'yaml';

interface Rule {
  // Sticky (y), tried where the line is
  re: RegExp;
  token?: Token | '' | ((match: string) => Token | '');
  // A token for each group instead, which make the match
  groups?: (Token | '')[];
  // Only first on the line, after the indentation (and what keeps it first)
  start?: boolean;
  // Leaves what follows first on the line: YAML's and Markdown's list marks
  keepStart?: boolean;
  next?: number;
}

interface State {
  rules: Rule[];
  // Inside a construct of several lines: when no rule matches, the rest of
  // the line is of this token
  fill?: Token | '';
}

interface Spec {
  label: string;
  // What comments a line out, for Ctrl+/
  comment: string | null;
  // State 0 is that of a line's start, outside of any construct
  states: State[];
}

const SPACE: Rule = { re: /\s+/y, keepStart: true };
const DOUBLE = /"(?:[^"\\]|\\.)*"?/y;
const SINGLE = /'(?:[^'\\]|\\.)*'?/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;

function words(list: string): Set<string> {
  return new Set(list.split(' '));
}

// Identifiers, as keywords, types, atoms or nothing
function identifiers(keywords: Set<string>, types: Set<string>, atoms: Set<string>, re = /[A-Za-z_$][\w$]*/y): Rule {
  return {
    re,
    token: (word) => (keywords.has(word) ? 'keyword' : types.has(word) ? 'type' : atoms.has(word) ? 'atom' : ''),
  };
}

// Inside a construct, until its end: the line's rest otherwise
function until(re: RegExp, token: Token | '', next = 0): State {
  return { fill: token, rules: [{ re, token, next }] };
}

const PYTHON_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield',
);
const PYTHON_TYPES = words('bool bytes dict float int list object set str tuple type self cls super print len range open isinstance');
const PYTHON_ATOMS = words('True False None NotImplemented Ellipsis __name__ __file__');

const CPP_KEYWORDS = words(
  'alignas alignof asm break case catch class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if inline mutable namespace new noexcept operator override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while',
);
const CPP_TYPES = words(
  'auto bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t ssize_t std string vector map unordered_map set array optional shared_ptr unique_ptr weak_ptr function',
);
const CPP_ATOMS = words('true false nullptr NULL');

const JS_KEYWORDS = words(
  'as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of private protected public readonly return set static super switch this throw try type typeof var void while with yield',
);
const JS_TYPES = words('any boolean never number object string symbol unknown bigint Array Map Set Promise Record');
const JS_ATOMS = words('true false null undefined NaN Infinity');

const SHELL_KEYWORDS = words(
  'if then else elif fi for in do done while until case esac function return select time export local readonly declare source alias unset shift exit break continue trap set',
);
const SHELL_TYPES = words('echo printf cd ls cat grep sed awk test read eval exec ros2 colcon sudo apt source');
const NONE = new Set<string>();

const SPECS: Record<Exclude<Language, 'plain'>, Spec> = {
  python: {
    label: 'Python',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /#.*/y, token: 'comment' },
          { re: /[rRbBuUfF]{0,2}"""/y, token: 'string', next: 1 },
          { re: /[rRbBuUfF]{0,2}'''/y, token: 'string', next: 2 },
          { re: /[rRbBuUfF]{0,2}"(?:[^"\\]|\\.)*"?/y, token: 'string' },
          { re: /[rRbBuUfF]{0,2}'(?:[^'\\]|\\.)*'?/y, token: 'string' },
          { re: /@[\w.]+/y, token: 'meta', start: true },
          { re: /(def|class)(\s+)([A-Za-z_]\w*)/y, groups: ['keyword', '', 'function'] },
          { re: NUMBER, token: 'number' },
          identifiers(PYTHON_KEYWORDS, PYTHON_TYPES, PYTHON_ATOMS),
        ],
      },
      until(/(?:[^"\\]|\\.|"(?!""))*"""/y, 'string'),
      until(/(?:[^'\\]|\\.|'(?!''))*'''/y, 'string'),
    ],
  },
  cpp: {
    label: 'C, C++',
    comment: '//',
    states: [
      {
        rules: [
          SPACE,
          { re: /\/\/.*/y, token: 'comment' },
          { re: /\/\*/y, token: 'comment', next: 1 },
          { re: /(#\s*include)(\s*)(<[^>]*>?)/y, groups: ['meta', '', 'string'], start: true },
          { re: /#\s*\w+/y, token: 'meta', start: true },
          { re: /(?:u8|[uUL])?"(?:[^"\\]|\\.)*"?/y, token: 'string' },
          { re: /(?:u8|[uUL])?'(?:[^'\\]|\\.)*'?/y, token: 'string' },
          { re: NUMBER, token: 'number' },
          { re: /[A-Za-z_]\w*_t\b/y, token: 'type' },
          identifiers(CPP_KEYWORDS, CPP_TYPES, CPP_ATOMS, /[A-Za-z_]\w*/y),
        ],
      },
      until(/.*?\*\//y, 'comment'),
    ],
  },
  javascript: {
    label: 'JavaScript, TypeScript',
    comment: '//',
    states: [
      {
        rules: [
          SPACE,
          { re: /\/\/.*/y, token: 'comment' },
          { re: /\/\*/y, token: 'comment', next: 1 },
          { re: DOUBLE, token: 'string' },
          { re: SINGLE, token: 'string' },
          { re: /`(?:[^`\\]|\\.)*`?/y, token: 'string' },
          { re: NUMBER, token: 'number' },
          { re: /(function)(\s+)([A-Za-z_$][\w$]*)/y, groups: ['keyword', '', 'function'] },
          identifiers(JS_KEYWORDS, JS_TYPES, JS_ATOMS),
        ],
      },
      until(/.*?\*\//y, 'comment'),
    ],
  },
  json: {
    label: 'JSON',
    comment: null,
    states: [
      {
        rules: [
          SPACE,
          { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, token: 'key' },
          { re: DOUBLE, token: 'string' },
          { re: /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y, token: 'number' },
          { re: /(?:true|false|null)\b/y, token: 'atom' },
          { re: /[{}[\],:]/y, token: 'punctuation' },
          // JSON with comments: tsconfig, VS Code's
          { re: /\/\/.*/y, token: 'comment' },
        ],
      },
    ],
  },
  yaml: {
    label: 'YAML',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /#.*/y, token: 'comment' },
          { re: /(?:---|\.\.\.)(?=\s|$)/y, token: 'meta', start: true },
          { re: /-(?=\s|$)/y, token: 'punctuation', keepStart: true },
          {
            re: /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`][^#]*?)\s*:(?=\s|$)/y,
            token: 'key',
            start: true,
          },
          { re: /[&*][^\s,[\]{}]+/y, token: 'meta' },
          { re: /![^\s]*/y, token: 'meta' },
          { re: DOUBLE, token: 'string' },
          { re: /'(?:[^']|'')*'?/y, token: 'string' },
          { re: /[|>][-+]?\d*(?=\s*(?:#|$))/y, token: 'meta' },
          {
            re: /(?:true|false|yes|no|on|off|null|True|False|TRUE|FALSE|Yes|No|Null|NULL|~)(?=\s*(?:#|$|,|\]|\}))/y,
            token: 'atom',
          },
          {
            re: /[-+]?(?:0x[\da-fA-F]+|0o[0-7]+|\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\.inf|\.nan)(?=\s*(?:#|$|,|\]|\}))/y,
            token: 'number',
          },
          { re: /[{}[\],:]/y, token: 'punctuation' },
          { re: /[^\s#,[\]{}]+/y },
        ],
      },
    ],
  },
  xml: {
    label: 'XML: URDF, launch',
    comment: null,
    states: [
      {
        rules: [
          SPACE,
          { re: /<!--/y, token: 'comment', next: 1 },
          { re: /<!\[CDATA\[/y, token: 'meta', next: 2 },
          { re: /<[?!][\w:-]*/y, token: 'meta', next: 3 },
          { re: /(<\/?)([\w:.-]+)/y, groups: ['punctuation', 'tag'], next: 3 },
          { re: /&(?:#\d+|#x[\da-fA-F]+|\w+);/y, token: 'atom' },
          // Launch files' and xacro's substitutions
          { re: /\$[({][^)}]*[)}]?/y, token: 'variable' },
          { re: /[^<&$\s]+/y },
        ],
      },
      until(/.*?-->/y, 'comment'),
      { fill: '', rules: [{ re: /(.*?)(\]\]>)/y, groups: ['', 'meta'], next: 0 }] },
      // In a tag, over lines maybe
      {
        rules: [
          SPACE,
          { re: /\/?>|\?>/y, token: 'punctuation', next: 0 },
          { re: /[\w:.-]+/y, token: 'attribute' },
          { re: /=/y, token: 'punctuation' },
          { re: /"[^"]*"/y, token: 'string' },
          { re: /'[^']*'/y, token: 'string' },
          { re: /"[^"]*/y, token: 'string', next: 4 },
          { re: /'[^']*/y, token: 'string', next: 5 },
        ],
      },
      until(/[^"]*"/y, 'string', 3),
      until(/[^']*'/y, 'string', 3),
    ],
  },
  shell: {
    label: 'Shell',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /#!.*/y, token: 'meta', start: true },
          { re: /#.*/y, token: 'comment' },
          { re: DOUBLE, token: 'string' },
          { re: /'[^']*'?/y, token: 'string' },
          { re: /\$\{[^}]*\}?|\$\(|\$[\w@#?$!*-]+/y, token: 'variable' },
          { re: /([A-Za-z_]\w*)(\+?=)/y, groups: ['variable', 'punctuation'] },
          { re: /\d+(?=\s|$|[;&|)])/y, token: 'number' },
          identifiers(SHELL_KEYWORDS, SHELL_TYPES, NONE, /[A-Za-z_][\w.-]*/y),
          { re: /[^\s"'$#\w]+/y },
        ],
      },
    ],
  },
  cmake: {
    label: 'CMake',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /#\[\[/y, token: 'comment', next: 1 },
          { re: /#.*/y, token: 'comment' },
          { re: DOUBLE, token: 'string' },
          { re: /\$(?:ENV)?\{[^}]*\}?/y, token: 'variable' },
          { re: /([A-Za-z_]\w*)(\s*)(?=\()/y, groups: ['function', ''] },
          { re: /[A-Z][A-Z0-9_]+\b/y, token: 'atom' },
          { re: /[\w.-]+/y },
        ],
      },
      until(/.*?\]\]/y, 'comment'),
    ],
  },
  ini: {
    label: 'INI, TOML, systemd',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /[#;].*/y, token: 'comment', start: true },
          { re: /#.*/y, token: 'comment' },
          { re: /\[[^\]]*\]?/y, token: 'tag', start: true },
          { re: /[^=\s[#;][^=]*?(?=\s*=)/y, token: 'key', start: true },
          { re: /=/y, token: 'punctuation' },
          { re: DOUBLE, token: 'string' },
          { re: SINGLE, token: 'string' },
          { re: /(?:true|false|yes|no|on|off)\b/iy, token: 'atom' },
          { re: /[-+]?\d[\d_.]*\b/y, token: 'number' },
          { re: /[^\s"'=#;]+/y },
        ],
      },
    ],
  },
  markdown: {
    label: 'Markdown',
    comment: null,
    states: [
      {
        rules: [
          { re: /#{1,6}(?:\s.*|$)/y, token: 'heading', start: true },
          { re: /```.*/y, token: 'meta', start: true, next: 1 },
          { re: />.*/y, token: 'comment', start: true },
          { re: /(?:[-*+]|\d+[.)])(?=\s)/y, token: 'punctuation', start: true, keepStart: true },
          SPACE,
          { re: /`[^`]*`?/y, token: 'string' },
          { re: /\*\*[^*]+\*\*|__[^_]+__/y, token: 'emphasis' },
          { re: /!?\[[^\]]*\]\([^)]*\)/y, token: 'link' },
          { re: /<https?:[^>]*>|https?:\/\/[^\s)>]+/y, token: 'link' },
          { re: /[^\s`*_[!<h]+/y },
        ],
      },
      { fill: 'string', rules: [{ re: /```\s*$/y, token: 'meta', start: true, next: 0 }] },
    ],
  },
  ros: {
    label: 'ROS interface',
    comment: '#',
    states: [
      {
        rules: [
          SPACE,
          { re: /#.*/y, token: 'comment' },
          { re: /---\s*$/y, token: 'meta', start: true },
          { re: /[A-Za-z_][\w/]*(?:<=\d+)?(?:\[[^\]]*\])?/y, token: 'type', start: true },
          { re: /[A-Z][A-Z0-9_]*(?=\s*=)/y, token: 'atom' },
          { re: /=/y, token: 'punctuation' },
          { re: DOUBLE, token: 'string' },
          { re: SINGLE, token: 'string' },
          { re: /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y, token: 'number' },
          { re: /[A-Za-z_]\w*/y },
        ],
      },
    ],
  },
};

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'plain', label: 'Plain text' },
  ...(Object.entries(SPECS) as [Exclude<Language, 'plain'>, Spec][])
    .map(([id, spec]) => ({ id, label: spec.label }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

const BY_EXTENSION: Record<string, Language> = {
  yaml: 'yaml',
  yml: 'yaml',
  rviz: 'yaml',
  repos: 'yaml',
  rosinstall: 'yaml',
  json: 'json',
  jsonc: 'json',
  xml: 'xml',
  urdf: 'xml',
  xacro: 'xml',
  sdf: 'xml',
  srdf: 'xml',
  launch: 'xml',
  world: 'xml',
  dae: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  svg: 'xml',
  html: 'xml',
  htm: 'xml',
  py: 'python',
  pyi: 'python',
  pyx: 'python',
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  ipp: 'cpp',
  tpp: 'cpp',
  ino: 'cpp',
  cu: 'cpp',
  proto: 'cpp',
  idl: 'cpp',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  cmake: 'cmake',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  env: 'shell',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  toml: 'ini',
  properties: 'ini',
  service: 'ini',
  timer: 'ini',
  socket: 'ini',
  mount: 'ini',
  target: 'ini',
  path: 'ini',
  desktop: 'ini',
  rules: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  msg: 'ros',
  srv: 'ros',
  action: 'ros',
};
const BY_NAME: Record<string, Language> = {
  'cmakelists.txt': 'cmake',
  dockerfile: 'shell',
  makefile: 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.gitmodules': 'ini',
  'colcon.meta': 'json',
};

export function languageOf(name: string, firstLine = ''): Language {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) {
    return BY_NAME[lower];
  }
  const dot = lower.lastIndexOf('.');
  const language = dot > 0 ? BY_EXTENSION[lower.slice(dot + 1)] : undefined;
  if (language) {
    return language;
  }
  // Scripts, by their first line
  if (/^#!.*\b(?:ba|z|da)?sh\b/.test(firstLine)) {
    return 'shell';
  }
  if (/^#!.*\bpython/.test(firstLine)) {
    return 'python';
  }
  if (/^<\?xml\b/.test(firstLine)) {
    return 'xml';
  }
  return 'plain';
}

export function commentOf(language: Language): string | null {
  return language === 'plain' ? null : SPECS[language].comment;
}

// Past this, a line's rest is plain: minified files have lines of megabytes
const MAX_TOKENIZED = 4000;

// The spans of a line, and the state of the next
export function tokenizeLine(language: Language, line: string, state: number): { spans: Span[]; state: number } {
  if (language === 'plain' || line.length === 0) {
    return { spans: line.length > 0 ? [[line.length, '']] : [], state };
  }
  const { states } = SPECS[language];
  const spans: Span[] = [];
  const push = (length: number, token: Token | '') => {
    if (length <= 0) {
      return;
    }
    const last = spans[spans.length - 1];
    if (last && last[1] === token) {
      last[0] += length;
    } else {
      spans.push([length, token]);
    }
  };
  const limit = Math.min(line.length, MAX_TOKENIZED);
  let position = 0;
  let start = true;
  while (position < limit) {
    const current = states[state] ?? states[0];
    let matched = false;
    for (const rule of current.rules) {
      if (rule.start && !start) {
        continue;
      }
      rule.re.lastIndex = position;
      const match = rule.re.exec(line);
      if (!match || match[0].length === 0) {
        continue;
      }
      if (rule.groups) {
        rule.groups.forEach((token, index) => push(match[index + 1]?.length ?? 0, token));
      } else {
        push(match[0].length, typeof rule.token === 'function' ? rule.token(match[0]) : (rule.token ?? ''));
      }
      position += match[0].length;
      if (rule.next !== undefined) {
        state = rule.next;
      }
      start &&= rule.keepStart === true;
      matched = true;
      break;
    }
    if (!matched) {
      if (current.fill !== undefined) {
        // The construct goes on past the line
        push(limit - position, current.fill);
        position = limit;
      } else {
        push(1, '');
        start &&= /\s/.test(line[position]);
        position++;
      }
    }
  }
  push(line.length - limit, '');
  return { spans, state };
}
