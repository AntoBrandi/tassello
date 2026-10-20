// The file manager's text editor, as gedit edits: line numbers, the line of
// the cursor lit, syntax highlighting, search and replace with every match
// marked, new lines indented as the one they break, Tab and Shift+Tab
// indenting the lines selected, Ctrl+/ commenting them out, undo and redo of
// its own (see text_edit.ts). A textarea, whose transparent text is drawn
// over by the highlighting, line by line, only the lines in sight: it keeps
// the caret, the selection and the keyboard (input methods, phones'
// keyboards). Wrapping long lines, the textarea shows its text itself, plain.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { ArrowDownToLineIcon, CloseIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { commentOf, tokenizeLine, type Language } from './highlight.ts';
import type { FileManagerAction, TextTab } from './session.ts';
import {
  diffText,
  findMatches,
  indentLines,
  indentText,
  lineAt,
  lineStarts,
  newLine,
  replaceAll,
  replacementAt,
  toggleComment,
  type EditKind,
  type SearchOptions,
  type Selection,
} from './text_edit.ts';

// As the stylesheet has them (.fm-text)
const LINE_PX = 20;
const PAD_Y = 6;
const PAD_X = 10;
const TAB_SIZE = 4;
// Lines drawn beyond those in sight, above and below
const OVERSCAN = 30;
// Files longer than this are not highlighted: every change would read them
// again from the line changed
const MAX_HIGHLIGHTED_LINES = 50_000;

export interface TextEditorHandle {
  focus: () => void;
  // Line from 1
  goToLine: (line: number) => void;
  find: (replace: boolean) => void;
}

interface Find {
  open: boolean;
  replace: boolean;
  query: string;
  replacement: string;
  options: SearchOptions;
}

// Kept across the files and their tabs: what was searched last
let lastFind: Find = {
  open: false,
  replace: false,
  query: '',
  replacement: '',
  options: { caseSensitive: false, regex: false, wholeWord: false },
};

// The states of the lines' starts, computed up to where they were needed,
// again from the first line changed
interface Highlighting {
  language: Language;
  lines: string[];
  states: number[];
}

function statesUpTo(cache: Highlighting, language: Language, lines: string[], last: number): number[] {
  if (language === 'plain') {
    // No construct over lines
    cache.language = language;
    return [];
  }
  if (cache.language !== language) {
    cache.language = language;
    cache.states = [0];
  } else if (cache.lines !== lines) {
    const known = Math.min(cache.lines.length, lines.length, cache.states.length - 1);
    let same = 0;
    while (same < known && cache.lines[same] === lines[same]) {
      same++;
    }
    cache.states.length = same + 1;
  }
  cache.lines = lines;
  for (let index = cache.states.length - 1; index < Math.min(last, lines.length); index++) {
    cache.states.push(tokenizeLine(language, lines[index], cache.states[index]).state);
  }
  return cache.states;
}

// The column of an offset into a line, tabs expanded
function visualColumn(line: string, offset: number): number {
  let column = 0;
  for (let index = 0; index < offset && index < line.length; index++) {
    column = line[index] === '\t' ? (Math.floor(column / TAB_SIZE) + 1) * TAB_SIZE : column + 1;
  }
  return column;
}

// A line, its tokens' colours and the matches marked
function renderLine(
  line: string,
  start: number,
  spans: [number, string][],
  matches: [number, number][],
  current: number,
  firstMatch: number,
): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  let match = firstMatch;
  for (const [length, token] of spans) {
    const end = at + length;
    // Cut where the matches start and end
    while (at < end) {
      while (match < matches.length && matches[match][1] - start <= at) {
        match++;
      }
      const marked = match < matches.length && matches[match][0] - start <= at;
      const until = marked
        ? Math.min(end, matches[match][1] - start)
        : Math.min(end, match < matches.length ? Math.max(at + 1, matches[match][0] - start) : end);
      const className = `${token ? `fm-t-${token}` : ''}${marked ? ` fm-match${match === current ? ' current' : ''}` : ''}`;
      const text = line.slice(at, until);
      parts.push(className ? (
        <span key={at} className={className}>
          {text}
        </span>
      ) : (
        text
      ));
      at = until;
    }
  }
  return parts;
}

function FindBar({
  find,
  count,
  current,
  capped,
  error,
  readOnly,
  inputRef,
  onChange,
  onStep,
  onReplace,
  onReplaceAll,
  onClose,
}: {
  find: Find;
  count: number;
  current: number;
  capped: boolean;
  error: string | null;
  readOnly: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (find: Find) => void;
  onStep: (step: 1 | -1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) {
  const option = (key: keyof SearchOptions, label: string, title: string) => (
    <button
      type="button"
      className="overlay-button fm-find-option"
      aria-pressed={find.options[key]}
      title={title}
      aria-label={title}
      onClick={() => onChange({ ...find, options: { ...find.options, [key]: !find.options[key] } })}
    >
      {label}
    </button>
  );
  const keys = (event: KeyboardEvent<HTMLInputElement>, replacing: boolean) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (replacing) {
        if (event.ctrlKey || event.metaKey) {
          onReplaceAll();
        } else {
          onReplace();
        }
      } else {
        onStep(event.shiftKey ? -1 : 1);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  const status = error
    ? 'Invalid'
    : !find.query
      ? ''
      : count === 0
        ? 'Not found'
        : `${current >= 0 ? `${(current + 1).toLocaleString()} of ` : ''}${count.toLocaleString()}${capped ? '+' : ''}`;
  return (
    <div className="fm-find" role="search">
      <div className="fm-find-row">
        <label className={`fm-search fm-find-input${error ? ' invalid' : ''}`} title={error ?? undefined}>
          <input
            ref={inputRef}
            type="text"
            value={find.query}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            onChange={(e) => onChange({ ...find, query: e.target.value })}
            onKeyDown={(e) => keys(e, false)}
          />
          <span className="fm-find-count">{status}</span>
        </label>
        {option('caseSensitive', 'Aa', 'Match case')}
        {option('wholeWord', 'W', 'Whole words')}
        {option('regex', '.*', 'Regular expression')}
        <button type="button" className="overlay-button" title="Previous (Shift+Enter)" aria-label="Previous" disabled={count === 0} onClick={() => onStep(-1)}>
          <ArrowDownToLineIcon width={16} height={16} style={{ transform: 'scaleY(-1)' }} />
        </button>
        <button type="button" className="overlay-button" title="Next (Enter)" aria-label="Next" disabled={count === 0} onClick={() => onStep(1)}>
          <ArrowDownToLineIcon width={16} height={16} />
        </button>
        {!readOnly && (
          <button
            type="button"
            className="overlay-button fm-find-option"
            aria-pressed={find.replace}
            title="Replace (Ctrl+H)"
            aria-label="Replace"
            onClick={() => onChange({ ...find, replace: !find.replace })}
          >
            ⇄
          </button>
        )}
        <button type="button" className="overlay-button" title="Close (Esc)" aria-label="Close the search" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </div>
      {find.replace && !readOnly && (
        <div className="fm-find-row">
          <label className="fm-search fm-find-input">
            <input
              type="text"
              value={find.replacement}
              placeholder={find.options.regex ? 'Replace with ($1: a group)' : 'Replace with'}
              aria-label="Replace with"
              spellCheck={false}
              onChange={(e) => onChange({ ...find, replacement: e.target.value })}
              onKeyDown={(e) => keys(e, true)}
            />
          </label>
          <button type="button" className="button fm-find-button" disabled={count === 0} onClick={onReplace} title="Replace this one (Enter)">
            Replace
          </button>
          <button type="button" className="button fm-find-button" disabled={count === 0} onClick={onReplaceAll} title="Replace them all (Ctrl+Enter)">
            All
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  tab: TextTab & { text: string };
  wrap: boolean;
  readOnly: boolean;
  dispatch: (action: FileManagerAction) => void;
  onSave: () => void;
  onGoToLine: () => void;
}

export const TextEditor = forwardRef<TextEditorHandle, Props>(function TextEditor(
  { tab, wrap, readOnly, dispatch, onSave, onGoToLine },
  ref,
) {
  const { id, text, language, indent } = tab;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  // The text as the textarea made it, typed: any other is set by program,
  // which sets the selection too
  const typed = useRef<string | null>(null);
  // Before an input, its selection
  const before = useRef<Selection>(tab.selection);
  const scroll = useRef(tab.scroll);
  const selection = useRef(tab.selection);
  const charWidth = useRef(7.8);
  const highlighting = useRef<Highlighting>({ language, lines: [], states: [0] });
  const frame = useRef(0);
  const [range, setRange] = useState({ first: 0, last: 60 });
  const [find, setFind] = useState<Find>({ ...lastFind, open: false });
  const [current, setCurrent] = useState(-1);

  const lines = useMemo(() => text.split('\n'), [text]);
  const starts = useMemo(() => lineStarts(text), [text]);
  const search = useMemo(
    () => (find.open && find.query ? findMatches(text, find.query, find.options) : { matches: [], error: null, capped: false }),
    [find.open, find.query, find.options, text],
  );
  const { matches } = search;

  useEffect(() => {
    lastFind = find;
  }, [find]);

  // Where the view is: the overlay and the gutter follow the textarea, and
  // the lines drawn are those in sight
  const sync = () => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    const { scrollTop: top, scrollLeft: left, clientHeight: height } = area;
    scroll.current = { top, left };
    if (overlayRef.current) {
      overlayRef.current.style.transform = `translate(${-left}px, ${-top}px)`;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = `translateY(${-top}px)`;
    }
    const first = Math.floor((top - PAD_Y) / LINE_PX);
    const last = Math.ceil((top + height) / LINE_PX);
    setRange((known) =>
      first >= known.first && last <= known.last && known.last - known.first <= last - first + 4 * OVERSCAN
        ? known
        : { first: Math.max(0, first - OVERSCAN), last: last + OVERSCAN },
    );
  };

  // The offset in sight, scrolling the editor only
  const reveal = (offset: number) => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    if (wrap) {
      area.scrollTop = Math.max(0, (offset / Math.max(1, text.length)) * area.scrollHeight - area.clientHeight / 2);
    } else {
      const line = lineAt(starts, offset);
      const top = PAD_Y + line * LINE_PX;
      if (top < area.scrollTop + PAD_Y) {
        area.scrollTop = top - PAD_Y;
      } else if (top + LINE_PX > area.scrollTop + area.clientHeight - PAD_Y) {
        area.scrollTop = top + LINE_PX - area.clientHeight + PAD_Y * 2;
      }
      const x = PAD_X + visualColumn(lines[line] ?? '', offset - starts[line]) * charWidth.current;
      if (x < area.scrollLeft + PAD_X) {
        area.scrollLeft = Math.max(0, x - PAD_X - 4 * charWidth.current);
      } else if (x > area.scrollLeft + area.clientWidth - 4 * charWidth.current) {
        area.scrollLeft = x - area.clientWidth + 8 * charWidth.current;
      }
    }
    sync();
  };

  // A text set by program (the textarea is not React's to set: its text,
  // megabytes, would be read and written again at every key): its
  // selection, and the view on it. First, the view as it was left.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || text === typed.current) {
      return;
    }
    typed.current = text;
    area.value = text;
    const { start, end } = tab.selection;
    area.setSelectionRange(start, end);
    selection.current = tab.selection;
    if (!mounted.current) {
      mounted.current = true;
      area.scrollTop = tab.scroll.top;
      area.scrollLeft = tab.scroll.left;
      sync();
    } else {
      reveal(end);
    }
  });

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      context.font = getComputedStyle(area).font;
      charWidth.current = context.measureText('0000000000').width / 10 || charWidth.current;
    }
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    // Undo and redo from the browser's menus: ours
    const onBeforeInput = (event: InputEvent) => {
      before.current = { start: area.selectionStart, end: area.selectionEnd };
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        dispatch({ type: event.inputType === 'historyUndo' ? 'undo' : 'redo', id });
      }
    };
    area.addEventListener('beforeinput', onBeforeInput);
    return () => {
      observer.disconnect();
      area.removeEventListener('beforeinput', onBeforeInput);
      cancelAnimationFrame(frame.current);
      // Kept for the tab shown again
      dispatch({ type: 'view', id, selection: selection.current, scroll: scroll.current });
    };
  }, [id]);

  useLayoutEffect(sync, [wrap]);

  useImperativeHandle(ref, () => ({
    focus: () => areaRef.current?.focus({ preventScroll: true }),
    goToLine: (line) => {
      const index = Math.min(lines.length, Math.max(1, line)) - 1;
      programSelect({ start: starts[index], end: starts[index] });
      areaRef.current?.focus({ preventScroll: true });
    },
    find: (replace) => openFind(replace),
  }));

  // The selection set by program, shown
  const programSelect = (next: Selection) => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    area.setSelectionRange(next.start, next.end);
    selection.current = next;
    dispatch({ type: 'view', id, selection: next });
    reveal(next.end);
  };

  // An edit made by program: one step to undo
  const edit = (next: string, after: Selection, kind: EditKind = 'other') => {
    const change = diffText(text, next);
    if (!change || readOnly) {
      return;
    }
    const area = areaRef.current;
    const was = area ? { start: area.selectionStart, end: area.selectionEnd } : tab.selection;
    dispatch({ type: 'edit', id, text: next, step: { change, before: was, after }, kind, time: Date.now() });
  };

  const insert = (inserted: string, kind: EditKind = 'other') => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    const { selectionStart: start, selectionEnd: end } = area;
    const at = start + inserted.length;
    edit(text.slice(0, start) + inserted + text.slice(end), { start: at, end: at }, kind);
  };

  const openFind = (replace: boolean) => {
    const area = areaRef.current;
    const chosen = area ? text.slice(area.selectionStart, area.selectionEnd) : '';
    const query = chosen && !chosen.includes('\n') ? (find.options.regex ? chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : chosen) : find.query;
    setFind({ ...find, open: true, replace: replace || (find.open && find.replace), query });
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };

  const closeFind = () => {
    setFind({ ...find, open: false });
    setCurrent(-1);
    areaRef.current?.focus({ preventScroll: true });
  };

  // The match after (or before) the caret, selected
  const step = (direction: 1 | -1) => {
    if (matches.length === 0) {
      return;
    }
    const caret = direction > 0 ? selection.current.end : selection.current.start;
    let index: number;
    if (current >= 0 && matches[current][0] === selection.current.start && matches[current][1] === selection.current.end) {
      index = (current + direction + matches.length) % matches.length;
    } else if (direction > 0) {
      index = matches.findIndex(([start]) => start >= caret);
      index = index < 0 ? 0 : index;
    } else {
      index = matches.findLastIndex(([, end]) => end <= caret);
      index = index < 0 ? matches.length - 1 : index;
    }
    setCurrent(index);
    programSelect({ start: matches[index][0], end: matches[index][1] });
  };

  // The query typed: the first match from the caret
  useEffect(() => {
    if (!find.open || matches.length === 0) {
      setCurrent(-1);
      return;
    }
    const index = matches.findIndex(([start]) => start >= selection.current.start);
    const chosen = index < 0 ? 0 : index;
    setCurrent(chosen);
    reveal(matches[chosen][0]);
  }, [find.query, find.options, find.open]);

  const replaceOne = () => {
    const match = matches[current];
    if (!match || readOnly) {
      step(1);
      return;
    }
    const replacement = replacementAt(text, match[0], find.query, find.replacement, find.options);
    if (replacement === null) {
      return;
    }
    const at = match[0] + replacement.length;
    edit(text.slice(0, match[0]) + replacement + text.slice(match[1]), { start: at, end: at });
  };

  const replaceEvery = () => {
    if (readOnly) {
      return;
    }
    try {
      const result = replaceAll(text, find.query, find.replacement, find.options);
      if (result.count > 0) {
        const at = Math.min(selection.current.start, result.text.length);
        edit(result.text, { start: at, end: at });
        notify(`Replaced ${result.count.toLocaleString()} ${result.count === 1 ? 'match' : 'matches'}`);
      }
    } catch (e) {
      notify(`Not replaced: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const run = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (mod && key === 's') {
      run(onSave);
    } else if (mod && key === 'z') {
      run(() => dispatch({ type: event.shiftKey ? 'redo' : 'undo', id }));
    } else if (mod && key === 'y') {
      run(() => dispatch({ type: 'redo', id }));
    } else if (mod && key === 'f') {
      run(() => openFind(false));
    } else if (mod && key === 'h') {
      run(() => openFind(true));
    } else if ((mod && key === 'g') || event.key === 'F3') {
      run(() => (find.open && find.query ? step(event.shiftKey ? -1 : 1) : openFind(false)));
    } else if (mod && key === 'i') {
      run(onGoToLine);
    } else if (event.key === 'Escape' && find.open) {
      run(closeFind);
    } else if (readOnly) {
      return;
    } else if (mod && (key === '/' || event.code === 'Slash')) {
      const token = commentOf(language);
      if (token) {
        run(() => {
          const done = toggleComment(text, selection.current, token);
          edit(done.text, done.selection);
        });
      }
    } else if (event.key === 'Tab' && !mod && !event.altKey) {
      run(() => {
        const area = areaRef.current!;
        const chosen = { start: area.selectionStart, end: area.selectionEnd };
        if (event.shiftKey || text.slice(chosen.start, chosen.end).includes('\n')) {
          const done = indentLines(text, chosen, indent, event.shiftKey);
          edit(done.text, done.selection);
        } else {
          insert(indentText(indent), 'type');
        }
      });
    } else if (event.key === 'Enter' && !mod && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      run(() => insert(newLine(text, areaRef.current!.selectionStart)));
    }
  };

  const onInput = () => {
    const area = areaRef.current;
    if (!area || readOnly) {
      return;
    }
    const next = area.value;
    const was = before.current;
    const change = diffText(text, next, Math.min(was.start, area.selectionStart));
    if (!change) {
      return;
    }
    typed.current = next;
    const after = { start: area.selectionStart, end: area.selectionEnd };
    selection.current = after;
    // What kind of input: typing and deleting are undone a word at a time
    const kind: EditKind =
      change.removed === '' && change.inserted.length <= 2 && !change.inserted.includes('\n')
        ? 'type'
        : change.inserted === '' && change.removed.length <= 2
          ? 'delete'
          : 'other';
    dispatch({ type: 'edit', id, text: next, step: { change, before: was, after }, kind, time: Date.now() });
    before.current = after;
  };

  // The caret moved: for the status line, a frame at a time
  const onSelect = () => {
    const area = areaRef.current;
    if (!area) {
      return;
    }
    selection.current = { start: area.selectionStart, end: area.selectionEnd };
    before.current = selection.current;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => dispatch({ type: 'view', id, selection: selection.current }));
  };

  const highlighted = lines.length <= MAX_HIGHLIGHTED_LINES ? language : 'plain';
  const caretLine = lineAt(starts, tab.selection.end);
  const first = Math.min(range.first, lines.length);
  const last = Math.min(range.last, lines.length);
  const states = wrap ? [] : statesUpTo(highlighting.current, highlighted, lines, last);
  const lineViews: ReactNode[] = [];
  const numbers: ReactNode[] = [];
  if (!wrap) {
    // The first match that may be on the first line drawn
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (matches[middle][1] <= starts[first]) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    let match = low;
    for (let index = first; index < last; index++) {
      const line = lines[index];
      const start = starts[index];
      while (match < matches.length && matches[match][1] <= start) {
        match++;
      }
      const { spans } = tokenizeLine(highlighted, line, states[index] ?? 0);
      lineViews.push(
        <div key={index} className="fm-line" style={{ top: PAD_Y + index * LINE_PX }}>
          {renderLine(line, start, spans, matches, current, match)}
        </div>,
      );
      numbers.push(
        <div
          key={index}
          className={`fm-number${index === caretLine ? ' current' : ''}`}
          style={{ top: PAD_Y + index * LINE_PX }}
          onPointerDown={(event) => {
            // The line selected
            event.preventDefault();
            const end = index + 1 < starts.length ? starts[index + 1] : text.length;
            programSelect({ start, end });
            areaRef.current?.focus({ preventScroll: true });
          }}
        >
          {index + 1}
        </div>,
      );
    }
  }

  return (
    <div className="fm-editor">
      {find.open && (
        <FindBar
          find={find}
          count={matches.length}
          current={current}
          capped={search.capped}
          error={search.error}
          readOnly={readOnly}
          inputRef={findRef}
          onChange={setFind}
          onStep={step}
          onReplace={replaceOne}
          onReplaceAll={replaceEvery}
          onClose={closeFind}
        />
      )}
      <div
        className={`fm-text${wrap ? ' wrap' : ''}`}
        style={{ '--fm-gutter': `${String(lines.length).length + 2}ch`, '--fm-tab': TAB_SIZE } as CSSProperties}
      >
        {!wrap && (
          <div className="fm-gutter" aria-hidden="true">
            <div ref={gutterRef} className="fm-gutter-lines" style={{ height: PAD_Y * 2 + lines.length * LINE_PX }}>
              {numbers}
            </div>
          </div>
        )}
        <div className="fm-code">
          {!wrap && (
            <div className="fm-overlay" aria-hidden="true">
              <div ref={overlayRef} className="fm-overlay-lines">
                <div className="fm-caret-line" style={{ top: PAD_Y + caretLine * LINE_PX }} />
                {lineViews}
              </div>
            </div>
          )}
          <textarea
            ref={areaRef}
            className="fm-area"
            wrap={wrap ? 'soft' : 'off'}
            readOnly={readOnly}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-label={`The text of ${tab.path}`}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onSelect={onSelect}
            onScroll={sync}
          />
        </div>
      </div>
    </div>
  );
});
