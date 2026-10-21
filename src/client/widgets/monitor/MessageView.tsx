// A message as ros2 topic echo prints it, YAML-like, its nested messages and
// lists of them folding: fields by name, lists of numbers on a line, what the
// server cut off counted.

import { memo, useCallback, useState } from 'react';

import { ArrowRightIcon } from '../../icons.tsx';
import { isTruncated, specialText } from './model.ts';

interface Row {
  // Its path, of its fields and items: what folds it
  path: string;
  depth: number;
  // Its field's name, its index in its list (item), or nothing (the message
  // itself)
  label: string;
  item: boolean;
  // Its value on its line; null: a message or list under it
  value: { text: string; kind: string } | null;
  // Folds: null if it does not
  open: boolean | null;
  // A note: the items the server left out
  note?: string;
}

function scalar(value: unknown): { text: string; kind: string } {
  const special = specialText(value);
  if (special !== null) {
    return { text: special, kind: special.startsWith('.') || special.startsWith('-.') ? 'special' : 'number' };
  }
  if (isTruncated(value) && typeof value.head === 'string') {
    return { text: `'${value.head}…' (${value.$truncated.toLocaleString()} characters)`, kind: 'string' };
  }
  if (typeof value === 'string') {
    return { text: `'${value}'`, kind: 'string' };
  }
  if (typeof value === 'number') {
    return { text: String(value), kind: 'number' };
  }
  if (typeof value === 'boolean') {
    return { text: String(value), kind: 'bool' };
  }
  return { text: 'null', kind: 'special' };
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value !== 'object' ||
    specialText(value) !== null ||
    (isTruncated(value) && typeof value.head === 'string')
  );
}

// [1, 2, 3, … 720 in all]
function inlineList(items: unknown[], total: number | null): { text: string; kind: string } {
  const text = items.map((item) => scalar(item).text).join(', ');
  const more = total !== null ? `${items.length ? ', ' : ''}… ${total.toLocaleString()} in all` : '';
  return { text: `[${text}${more}]`, kind: 'list' };
}

function rows(value: unknown, folded: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  const visit = (v: unknown, path: string, depth: number, label: string, item: boolean) => {
    if (isScalar(v)) {
      out.push({ path, depth, label, item, value: scalar(v), open: null });
      return;
    }
    const truncated = isTruncated(v) ? v : null;
    const list = truncated ? (truncated.head as unknown[]) : Array.isArray(v) ? v : null;
    if (list) {
      if (list.every(isScalar)) {
        out.push({ path, depth, label, item, value: inlineList(list, truncated?.$truncated ?? null), open: null });
        return;
      }
      const open = !folded.has(path);
      out.push({ path, depth, label, item, value: null, open });
      if (open) {
        list.forEach((entry, i) => visit(entry, `${path}[${i}]`, depth + 1, String(i), true));
        if (truncated) {
          out.push({
            path: `${path}…`,
            depth: depth + 1,
            label: '',
            item: false,
            value: null,
            open: null,
            note: `… ${truncated.$truncated.toLocaleString()} items in all`,
          });
        }
      }
      return;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    const top = path === '';
    const open = top || !folded.has(path);
    if (!top) {
      out.push({
        path,
        depth,
        label,
        item,
        value: entries.length === 0 ? { text: '{}', kind: 'special' } : null,
        open: entries.length ? open : null,
      });
    }
    if (open) {
      for (const [key, entry] of entries) {
        visit(entry, top ? key : `${path}.${key}`, top ? depth : depth + 1, key, false);
      }
    }
  };
  visit(value, '', 0, '', false);
  return out;
}

const INDENT_PX = 14;

export const MessageView = memo(function MessageView({ message }: { message: unknown }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (path: string) =>
      setFolded((current) => {
        const next = new Set(current);
        if (!next.delete(path)) {
          next.add(path);
        }
        return next;
      }),
    [],
  );
  if (message === undefined) {
    return <p className="mon-muted">No such field in the message</p>;
  }
  return (
    <div className="mon-msg" role="tree">
      {rows(message, folded).map((row) => (
        <div
          key={row.path}
          className={`mon-msg-row${row.open !== null ? ' folds' : ''}`}
          style={{ paddingLeft: row.depth * INDENT_PX + (row.open === null ? 16 : 0) }}
          role="treeitem"
          aria-expanded={row.open ?? undefined}
          onClick={row.open !== null ? () => toggle(row.path) : undefined}
        >
          {row.open !== null && (
            <span className="mon-msg-fold" aria-hidden="true">
              <ArrowRightIcon width={11} height={11} />
            </span>
          )}
          {row.note ? (
            <span className="mon-msg-note">{row.note}</span>
          ) : (
            <>
              {row.item ? (
                <span className="mon-msg-index">- [{row.label}]</span>
              ) : (
                row.label && <span className="mon-msg-key">{row.label}:</span>
              )}
              {row.value && <span className={`mon-msg-value ${row.value.kind}`}>{row.value.text}</span>}
              {row.open === false && <span className="mon-msg-note">…</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
});
