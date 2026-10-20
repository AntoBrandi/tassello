// The messages of the logs widget, a row each, the newest at the bottom. Only
// the rows in sight are drawn, at a fixed height: the log keeps thousands.
// Followed while scrolled to the bottom; else the row at the top stays there,
// as messages come and go and the filters change.

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { LogEntry } from '../../../shared/protocol.ts';
import { clockTime, indexOfSeq, LEVELS, levelIndex, stampTime, type TimeFormat } from './model.ts';

// Of a row: one line, or two (compact: its level, node and time, then its text)
const ROW_PX = 22;
const COMPACT_ROW_PX = 38;
// Drawn beyond those in sight, above and below
const OVERSCAN = 8;

interface RowProps {
  entry: LogEntry;
  top: number;
  selected: boolean;
  time: TimeFormat;
  showNode: boolean;
  onSelect: (seq: number | null) => void;
}

const Row = memo(function Row({ entry, top, selected, time, showNode, onSelect }: RowProps) {
  const { level, tag } = LEVELS[levelIndex(entry.level)];
  const newline = entry.msg.indexOf('\n');
  const more = newline < 0 ? 0 : entry.msg.split('\n').length - 1;
  return (
    <div
      role="option"
      aria-selected={selected}
      className={`log-row ${level}${selected ? ' selected' : ''}`}
      style={{ top }}
      onClick={() => onSelect(selected ? null : entry.seq)}
    >
      {time !== 'none' && (
        <time className="log-time">{time === 'clock' ? clockTime(entry.stamp) : stampTime(entry.stamp)}</time>
      )}
      <span className="log-level">{tag}</span>
      {showNode && <span className="log-node">{entry.name}</span>}
      <span className="log-msg">{newline < 0 ? entry.msg : entry.msg.slice(0, newline)}</span>
      {more > 0 && (
        <span className="log-more" title={`${more} more line${more === 1 ? '' : 's'}`}>
          +{more}
        </span>
      )}
    </div>
  );
});

export interface LogListProps {
  // Oldest first
  entries: LogEntry[];
  // Another log: what the list was scrolled to goes
  version: number;
  selected: number | null;
  follow: boolean;
  time: TimeFormat;
  showNode: boolean;
  // Of the node column, in characters
  nodeWidth: number;
  compact: boolean;
  // What an empty list says
  empty: string;
  onSelect: (seq: number | null) => void;
  // Scrolled to the bottom, or away from it
  onFollow: (follow: boolean) => void;
}

export function LogList({
  entries,
  version,
  selected,
  follow,
  time,
  showNode,
  nodeWidth,
  compact,
  empty,
  onSelect,
  onFollow,
}: LogListProps) {
  const rowPx = compact ? COMPACT_ROW_PX : ROW_PX;
  const listRef = useRef<HTMLDivElement>(null);
  const [sight, setSight] = useState({ top: 0, height: 0 });
  // The message at the top, and how far into its row the list is scrolled
  const anchor = useRef<{ seq: number; offset: number } | null>(null);
  // For the resize observer, which outlives the renders
  const latest = useRef({ entries, follow, rowPx });
  latest.current = { entries, follow, rowPx };

  // Where the list should be: at the bottom, or at its anchor
  const place = () => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const { entries, follow, rowPx } = latest.current;
    if (follow) {
      list.scrollTop = list.scrollHeight;
    } else if (anchor.current) {
      list.scrollTop = indexOfSeq(entries, anchor.current.seq) * rowPx + Math.min(anchor.current.offset, rowPx - 1);
    }
    setSight({ top: list.scrollTop, height: list.clientHeight });
  };

  useEffect(() => {
    anchor.current = null;
  }, [version]);

  useLayoutEffect(place, [entries, follow, rowPx]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const top = list.scrollTop;
    const index = Math.min(entries.length - 1, Math.floor(top / rowPx));
    anchor.current = index >= 0 ? { seq: entries[index].seq, offset: top - index * rowPx } : null;
    const atBottom = list.scrollHeight - top - list.clientHeight < rowPx / 2;
    if (atBottom !== follow) {
      onFollow(atBottom);
    }
    setSight({ top, height: list.clientHeight });
  };

  // The row in sight, scrolling the list only: scrollIntoView would scroll
  // the board to the widget too
  const reveal = (index: number) => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const top = index * rowPx;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + rowPx > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + rowPx - list.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) {
      return;
    }
    const page = Math.max(1, Math.floor(sight.height / rowPx) - 1);
    const current = selected === null ? -1 : indexOfSeq(entries, selected);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = current < 0 ? entries.length - 1 : current + 1;
        break;
      case 'ArrowUp':
        next = current < 0 ? entries.length - 1 : current - 1;
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
        next = entries.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    next = Math.min(entries.length - 1, Math.max(0, next));
    onSelect(entries[next].seq);
    reveal(next);
  };

  const first = Math.max(0, Math.floor(sight.top / rowPx) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((sight.top + sight.height) / rowPx) + OVERSCAN);
  const rows = [];
  for (let index = first; index < last; index++) {
    const entry = entries[index];
    rows.push(
      <Row
        key={entry.seq}
        entry={entry}
        top={index * rowPx}
        selected={entry.seq === selected}
        time={time}
        showNode={showNode}
        onSelect={onSelect}
      />,
    );
  }
  return (
    <div
      ref={listRef}
      className={`logs-list${compact ? ' compact' : ''}`}
      role="listbox"
      aria-label="Messages"
      tabIndex={0}
      style={{ '--log-row': `${rowPx}px`, '--log-node': `${nodeWidth}ch` } as CSSProperties}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {entries.length > 0 ? (
        <div className="logs-rows" style={{ height: entries.length * rowPx }}>
          {rows}
        </div>
      ) : (
        <p className="logs-empty">{empty}</p>
      )}
    </div>
  );
}
