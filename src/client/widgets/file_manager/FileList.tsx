// The file manager's list: a folder's entries a row each, as the behavior
// tree inspector lists its nodes, folders unfolded in place under their
// row. Only the rows in sight are drawn: folders of thousands. Rows are
// selected (Ctrl, Shift), opened (double click; a tap on touch screens),
// renamed in place, dragged onto folders, and their menu opened by a right
// click or their ⋯ button.

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import type { FsEntry } from '../../../shared/file_manager.ts';
import { ArchiveIcon, CodeIcon, FileIcon, FileTextIcon, FilmIcon, FolderIcon, ImageIcon, LinkIcon, MoreIcon, TerminalIcon } from '../../icons.tsx';
import { fileType, formatDate, formatSize, typeLabel, type FileType, type Row, type Sort, type SortKey } from './model.ts';

// Of a row, as the stylesheet has it
export const ROW_PX = 28;
const INDENT_PX = 16;
// Drawn beyond those in sight, above and below
const OVERSCAN = 10;

const ICONS: Record<FileType, typeof FileIcon> = {
  folder: FolderIcon,
  bag: FilmIcon,
  text: FileTextIcon,
  image: ImageIcon,
  archive: ArchiveIcon,
  media: FilmIcon,
  program: TerminalIcon,
  other: FileIcon,
};

export function EntryIcon({ entry, size = 16 }: { entry: Pick<FsEntry, 'name' | 'kind' | 'bag' | 'mode' | 'link'>; size?: number }) {
  const type = entry.kind === 'other' ? 'other' : fileType(entry);
  const Icon = type === 'text' && /\.(py|cpp|hpp|h|c|cc|js|ts|sh)$/i.test(entry.name) ? CodeIcon : ICONS[type];
  return <Icon className={`fm-icon ${type}`} width={size} height={size} />;
}

// The name typed in place: its stem selected, Enter keeps it, Escape not
function RenameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const input = ref.current;
    if (input) {
      input.focus();
      const dot = name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : name.length);
    }
  }, [name]);
  const finish = (value: string | null) => {
    if (!done.current) {
      done.current = true;
      onDone(value);
    }
  };
  return (
    <input
      ref={ref}
      className="fm-rename"
      defaultValue={name}
      spellCheck={false}
      aria-label={`New name of ${name}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

interface RowProps {
  row: Row;
  index: number;
  top: number;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  dropping: boolean;
  renaming: boolean;
  now: number;
  handlers: ListHandlers;
}

const RowView = memo(function RowView({ row, index, top, selected, focused, cut, dropping, renaming, now, handlers }: RowProps) {
  if (row.type === 'note') {
    return (
      <div className={`fm-note${row.error ? ' error' : ''}`} style={{ top, paddingLeft: 8 + row.depth * INDENT_PX + 20 }}>
        {row.text}
      </div>
    );
  }
  const { entry, path, depth, open } = row;
  const folder = entry.kind === 'dir';
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={open ?? undefined}
      aria-selected={selected}
      data-row={index}
      className={`bt-row fm-row${selected ? ' selected' : ''}${focused ? ' focused' : ''}${cut ? ' cut' : ''}${dropping ? ' drop-into' : ''}${entry.kind === 'other' ? ' special' : ''}`}
      style={{ top }}
      title={`${entry.name}\n${typeLabel(entry)}${entry.link !== null ? ` → ${entry.link}` : ''}`}
      draggable={!renaming}
      onPointerDown={(e) => handlers.onPointer(e.pointerType)}
      onClick={(e) => handlers.onClick(path, e)}
      onDoubleClick={() => handlers.onOpen(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        handlers.onMenu(path, e.clientX, e.clientY);
      }}
      onDragStart={(e) => handlers.onDragStart(path, e)}
      onDragEnd={handlers.onDragEnd}
      onDragOver={folder ? (e) => handlers.onDragOver(path, e) : undefined}
      onDrop={folder ? (e) => handlers.onDrop(path, e) : undefined}
    >
      <span className="bt-row-indent" style={{ width: depth * INDENT_PX }} />
      {open !== null ? (
        <button
          type="button"
          className="bt-row-fold"
          tabIndex={-1}
          aria-label={open ? `Fold ${entry.name}` : `Unfold ${entry.name}`}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            handlers.onFold(path, !open);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <span className="bt-row-fold" />
      )}
      <span className="fm-row-name">
        <EntryIcon entry={entry} />
        {renaming ? (
          <RenameInput name={entry.name} onDone={(name) => handlers.onRename(path, name)} />
        ) : (
          <span className="fm-name">{entry.name}</span>
        )}
        {entry.link !== null && <LinkIcon className="fm-link" width={12} height={12} aria-label="A link" />}
      </span>
      <span className="fm-size">{folder ? '' : formatSize(entry.size)}</span>
      <span className="fm-date">{formatDate(entry.modified, now)}</span>
      <button
        type="button"
        className="fm-row-more"
        tabIndex={-1}
        aria-label={`What to do with ${entry.name}`}
        onClick={(e) => {
          e.stopPropagation();
          const box = e.currentTarget.getBoundingClientRect();
          handlers.onMenu(path, box.right, box.bottom);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <MoreIcon width={15} height={15} />
      </button>
    </div>
  );
});

export interface ListHandlers {
  onPointer: (type: string) => void;
  onClick: (path: string, event: MouseEvent) => void;
  onOpen: (path: string) => void;
  onFold: (path: string, open: boolean) => void;
  onMenu: (path: string | null, x: number, y: number) => void;
  onRename: (path: string, name: string | null) => void;
  onDragStart: (path: string, event: DragEvent) => void;
  onDragEnd: () => void;
  // Over or onto a folder's row; null: the folder shown, the list's background
  onDragOver: (folder: string | null, event: DragEvent) => void;
  onDrop: (folder: string | null, event: DragEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, page: number) => void;
}

export interface FileListProps {
  rows: Row[];
  // Another folder: back to the top
  version: string;
  selected: ReadonlySet<string>;
  focus: string | null;
  cut: ReadonlySet<string>;
  dropTarget: string | null;
  // The folder shown is the drop target
  droppingHere: boolean;
  renaming: string | null;
  sort: Sort;
  now: number;
  // What an empty list says
  empty: ReactNode;
  // To scroll to, once
  reveal: { path: string; seq: number } | null;
  handlers: ListHandlers;
  onSort: (key: SortKey) => void;
}

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'name', label: 'Name', className: 'fm-head-name' },
  { key: 'size', label: 'Size', className: 'fm-size' },
  { key: 'modified', label: 'Modified', className: 'fm-date' },
];

export function FileList({
  rows,
  version,
  selected,
  focus,
  cut,
  dropTarget,
  droppingHere,
  renaming,
  sort,
  now,
  empty,
  reveal,
  handlers,
  onSort,
}: FileListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [sight, setSight] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const measure = () => setSight({ top: list.scrollTop, height: list.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = 0;
      setSight({ top: 0, height: list.clientHeight });
    }
  }, [version]);

  // The row in sight, once it is listed, scrolling the list only:
  // scrollIntoView would scroll the board to the widget too
  const revealed = useRef(-1);
  useEffect(() => {
    const list = listRef.current;
    const index = reveal && reveal.seq !== revealed.current ? rows.findIndex((row) => row.path === reveal.path) : -1;
    if (!list || index < 0) {
      return;
    }
    revealed.current = reveal!.seq;
    const top = index * ROW_PX;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + ROW_PX > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ROW_PX - list.clientHeight;
    }
  }, [reveal, rows]);

  const first = Math.max(0, Math.floor(sight.top / ROW_PX) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((sight.top + sight.height) / ROW_PX) + OVERSCAN);
  const drawn = [];
  for (let index = first; index < last; index++) {
    const row = rows[index];
    drawn.push(
      <RowView
        key={row.path}
        row={row}
        index={index}
        top={index * ROW_PX}
        selected={selected.has(row.path)}
        focused={focus === row.path}
        cut={cut.has(row.path)}
        dropping={dropTarget === row.path}
        renaming={renaming === row.path}
        now={now}
        handlers={handlers}
      />,
    );
  }

  return (
    <div className="fm-list-box">
      <div className="fm-head" role="row">
        {COLUMNS.map(({ key, label, className }) => (
          <button
            key={key}
            type="button"
            className={className}
            aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : undefined}
            title={`By ${label.toLowerCase()}`}
            onClick={() => onSort(key)}
          >
            {label}
            {sort.key === key && <span aria-hidden="true">{sort.descending ? ' ↓' : ' ↑'}</span>}
          </button>
        ))}
        <span className="fm-row-more" />
      </div>
      <div
        ref={listRef}
        className={`fm-list${droppingHere ? ' drop-into' : ''}`}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        tabIndex={0}
        onScroll={(e) => setSight({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onKeyDown={(e) => handlers.onKeyDown(e, Math.max(1, Math.floor(sight.height / ROW_PX) - 1))}
        onClick={(e) => e.target === e.currentTarget && handlers.onClick('', e)}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('fm-rows')) {
            e.preventDefault();
            handlers.onMenu(null, e.clientX, e.clientY);
          }
        }}
        onDragOver={(e) => handlers.onDragOver(null, e)}
        onDrop={(e) => handlers.onDrop(null, e)}
      >
        {rows.length > 0 ? (
          <div className="fm-rows" style={{ height: rows.length * ROW_PX }} onClick={(e) => e.target === e.currentTarget && handlers.onClick('', e)}>
            {drawn}
          </div>
        ) : (
          <div className="widget-message fm-empty">{empty}</div>
        )}
      </div>
    </div>
  );
}
