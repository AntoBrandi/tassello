// The statuses of the diagnostics widget, a row each: as a tree, under their
// groups, which fold; or as a list, the worst first. The arrow keys go
// through them, and fold and unfold the groups.

import { memo, useRef, type KeyboardEvent } from 'react';

import { shortCount } from '../logs/model.ts';
import type { Level } from './model.ts';

// Of a level, its shape as well as its colour: a check, a triangle, a cross,
// a dashed ring (nothing known)
export function LevelIcon({ level, size = 14 }: { level: Level; size?: number }) {
  const mark = { fill: 'none', stroke: 'var(--diag-mark)', strokeWidth: 1.8, strokeLinecap: 'round' } as const;
  return (
    <svg className={`diag-icon ${level}`} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      {level === 'ok' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="m4.8 8.3 2.2 2.1 4.2-4.6" strokeLinejoin="round" {...mark} />
        </>
      )}
      {level === 'warn' && (
        <>
          <path d="M8 1.2c.5 0 .9.3 1.2.8l6 10.6c.5.9-.1 2-1.2 2H2c-1.1 0-1.7-1.1-1.2-2l6-10.6c.3-.5.7-.8 1.2-.8Z" fill="currentColor" />
          <path d="M8 5.6v3.6M8 11.9v.1" {...mark} />
        </>
      )}
      {level === 'error' && (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="m5.5 5.5 5 5M10.5 5.5l-5 5" {...mark} />
        </>
      )}
      {level === 'stale' && (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="2.4 2" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export interface StatusRow {
  key: string;
  depth: number;
  label: string;
  // The worst of its own and of those under it
  level: Level;
  message: string;
  // Its children unfolded or folded; null: none
  open: boolean | null;
  // Shown for those under it, not itself matching the filters
  dim: boolean;
  // It has a status of its own, which it shows the details of; else it folds
  // and unfolds when clicked
  status: boolean;
  // Folded away under it
  problems: { error: number; stale: number; warn: number } | null;
}

const INDENT_PX = 16;
// Of a row, as the stylesheet has it: for paging
const ROW_PX = 26;

interface RowProps extends Omit<StatusRow, 'key' | 'problems'> {
  rowKey: string;
  index: number;
  errors: number;
  stale: number;
  warnings: number;
  selected: boolean;
  role: 'treeitem' | 'option';
  onSelect: (key: string | null) => void;
  onFold: (key: string, open: boolean) => void;
}

const Row = memo(function Row({
  index,
  rowKey,
  depth,
  label,
  level,
  message,
  open,
  dim,
  status,
  errors,
  stale,
  warnings,
  selected,
  role,
  onSelect,
  onFold,
}: RowProps) {
  const problems = [
    { level: 'error', count: errors, name: 'in error' },
    { level: 'stale', count: stale, name: 'stale' },
    { level: 'warn', count: warnings, name: 'warning' },
  ].filter(({ count }) => count > 0);
  return (
    <div
      role={role}
      aria-level={role === 'treeitem' ? depth + 1 : undefined}
      aria-expanded={open ?? undefined}
      aria-selected={selected}
      data-row={index}
      className={`diag-row ${level}${selected ? ' selected' : ''}${dim ? ' dim' : ''}`}
      style={{ paddingLeft: 4 + depth * INDENT_PX }}
      title={message ? `${label}: ${message}` : label}
      onClick={() => {
        if (status) {
          onSelect(selected ? null : rowKey);
        } else {
          onSelect(rowKey);
          if (open !== null) {
            onFold(rowKey, open);
          }
        }
      }}
    >
      {open === null ? (
        role === 'treeitem' && <span className="diag-fold" />
      ) : (
        <span
          className="diag-fold"
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation();
            onFold(rowKey, open);
          }}
        >
          <svg viewBox="0 0 24 24" width="12" height="12">
            <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </span>
      )}
      <LevelIcon level={level} />
      <span className="diag-label">{label}</span>
      <span className="diag-msg">{message}</span>
      {problems.map(({ level, count, name }) => (
        <span key={level} className={`diag-badge ${level}`} title={`${count} ${name} under it`}>
          {shortCount(count)}
        </span>
      ))}
    </div>
  );
});

export interface StatusRowsProps {
  kind: 'tree' | 'list';
  rows: StatusRow[];
  selected: string | null;
  // What an empty tree or list says
  empty: string;
  onSelect: (key: string | null) => void;
  onFold: (key: string, open: boolean) => void;
}

export function StatusRows({ kind, rows, selected, empty, onSelect, onFold }: StatusRowsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // The row in sight, scrolling the list only: scrollIntoView would scroll
  // the board to the widget too
  const reveal = (index: number) => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    if (!list || !row) {
      return;
    }
    if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) {
      return;
    }
    const current = selected === null ? -1 : rows.findIndex((row) => row.key === selected);
    const row = rows[current] as StatusRow | undefined;
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_PX) - 1);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current + 1;
        break;
      case 'ArrowUp':
        next = current < 0 ? 0 : current - 1;
        break;
      case 'PageDown':
        next = current + page;
        break;
      case 'PageUp':
        next = current - page;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      // Unfolds, then goes to the first under it
      case 'ArrowRight':
        if (row?.open === false) {
          event.preventDefault();
          onFold(row.key, false);
          return;
        }
        if (!row?.open) {
          return;
        }
        next = current + 1;
        break;
      // Folds, then goes to the group above
      case 'ArrowLeft':
        if (row?.open) {
          event.preventDefault();
          onFold(row.key, true);
          return;
        }
        if (!row || row.depth === 0) {
          return;
        }
        next = current - 1;
        while (next > 0 && rows[next].depth >= row.depth) {
          next--;
        }
        break;
      case 'Enter':
      case ' ':
        if (row && row.open !== null) {
          event.preventDefault();
          onFold(row.key, row.open);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    next = Math.min(rows.length - 1, Math.max(0, next));
    onSelect(rows[next].key);
    reveal(next);
  };

  return (
    <div
      ref={listRef}
      className={`diag-rows ${kind}`}
      role={kind === 'tree' ? 'tree' : 'listbox'}
      aria-label="Statuses"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {rows.length > 0 ? (
        rows.map(({ key, problems, ...row }, index) => (
          <Row
            key={key}
            rowKey={key}
            index={index}
            {...row}
            errors={problems?.error ?? 0}
            stale={problems?.stale ?? 0}
            warnings={problems?.warn ?? 0}
            selected={key === selected}
            role={kind === 'tree' ? 'treeitem' : 'option'}
            onSelect={onSelect}
            onFold={onFold}
          />
        ))
      ) : (
        <p className="diag-empty">{empty}</p>
      )}
    </div>
  );
}
