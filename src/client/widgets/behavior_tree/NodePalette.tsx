// The behavior tree editor's nodes to add, by kind: BT.CPP's, Nav2's, the
// libraries', the file's own models and subtrees, and the nodes the file
// uses that none of them knows. A click adds one with the selection (into it,
// or after it); with a mouse, a node is also dragged where it goes.

import { useMemo, useRef, useState, type PointerEvent } from 'react';

import type { BtNodeModel } from '../../../shared/bt_nodes.ts';
import type { BtNodeKind } from '../../../shared/protocol.ts';
import { CloseIcon, PlusIcon } from '../../icons.tsx';
import type { Point } from './pan_zoom.ts';
import { KindIcon } from './parts.tsx';

export interface PaletteItem {
  model: BtNodeModel;
  // Where it comes from
  library: string;
}

const GROUPS: { kind: BtNodeKind; title: string }[] = [
  { kind: 'control', title: 'Controls' },
  { kind: 'decorator', title: 'Decorators' },
  { kind: 'action', title: 'Actions' },
  { kind: 'condition', title: 'Conditions' },
  { kind: 'subtree', title: 'Subtrees' },
];
// A press moved this far drags
const DRAG_PX = 5;

function describe(item: PaletteItem): string {
  const { model } = item;
  const ports = model.ports.map((port) => `${port.direction === 'output' ? '→ ' : ''}${port.name}${port.default !== null ? ` = ${port.default}` : ''}`);
  return [`${model.id} · ${item.library}`, model.description, ports.length > 0 && `Ports: ${ports.join(', ')}`].filter(Boolean).join('\n');
}

export function NodePalette({
  items,
  libraries,
  warnings,
  onAdd,
  onDrag,
  onDrop,
  onLoadLibrary,
  onRemoveLibrary,
  onClose,
}: {
  items: PaletteItem[];
  // The widget's, and those loaded in this page: removable
  libraries: { path: string; removable: boolean }[];
  warnings: string[];
  onAdd: (item: PaletteItem) => void;
  // Dragged at a point of the page; dropped there (null: cancelled)
  onDrag: (item: PaletteItem, client: Point) => void;
  onDrop: (item: PaletteItem, client: Point | null) => void;
  onLoadLibrary: () => void;
  onRemoveLibrary: (library: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<BtNodeKind>>(new Set());
  const press = useRef<{ item: PaletteItem; start: Point; dragging: boolean } | null>(null);
  // A click after a drag is not one
  const dragged = useRef(false);

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (item: PaletteItem) => {
      const text = `${item.model.id} ${item.library} ${item.model.description}`.toLowerCase();
      return words.every((word) => text.includes(word));
    };
    // The names starting with what is searched first
    const rank = (item: PaletteItem) => (words.length > 0 && item.model.id.toLowerCase().startsWith(words[0]) ? 0 : 1);
    return GROUPS.map((group) => ({
      ...group,
      items: items
        .filter((item) => item.model.kind === group.kind && matches(item))
        .sort((a, b) => rank(a) - rank(b) || a.model.id.localeCompare(b.model.id)),
    })).filter((group) => group.items.length > 0);
  }, [items, query]);

  const onPointerDown = (item: PaletteItem, event: PointerEvent<HTMLButtonElement>) => {
    // Touch scrolls the list: a tap adds
    if (event.pointerType === 'touch' || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { item, start: { x: event.clientX, y: event.clientY }, dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) {
      return;
    }
    const client = { x: event.clientX, y: event.clientY };
    current.dragging ||= Math.hypot(client.x - current.start.x, client.y - current.start.y) > DRAG_PX;
    if (current.dragging) {
      onDrag(current.item, client);
    }
  };
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    press.current = null;
    if (current?.dragging) {
      dragged.current = true;
      onDrop(current.item, event.type === 'pointerup' ? { x: event.clientX, y: event.clientY } : null);
    }
  };

  return (
    <aside className="bte-palette" aria-label="Nodes to add">
      <header className="bte-palette-header">
        <input type="search" placeholder="Search the nodes" aria-label="Search the nodes" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="icon-button" aria-label="Close the nodes" title="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bte-palette-body">
        {groups.length === 0 && <p className="bt-muted bte-palette-empty">No node {query ? 'matches' : 'known'}</p>}
        {groups.map((group) => {
          const open = query !== '' || !closed.has(group.kind);
          return (
            <section key={group.kind}>
              <button
                type="button"
                className="bte-palette-group"
                aria-expanded={open}
                onClick={() =>
                  setClosed((current) => {
                    const next = new Set(current);
                    if (!next.delete(group.kind)) {
                      next.add(group.kind);
                    }
                    return next;
                  })
                }
              >
                {group.title}
                <span className="bt-muted">{group.items.length}</span>
              </button>
              {open && (
                <ul>
                  {group.items.map((item) => (
                    <li key={`${item.library}/${item.model.id}`}>
                      <button
                        type="button"
                        className="bte-palette-item"
                        title={describe(item)}
                        onPointerDown={(e) => onPointerDown(item, e)}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerEnd}
                        onPointerCancel={onPointerEnd}
                        onClick={() => {
                          if (dragged.current) {
                            dragged.current = false;
                          } else {
                            onAdd(item);
                          }
                        }}
                      >
                        <KindIcon node={{ kind: item.model.kind, type: item.model.id }} />
                        <span className="bte-palette-name">{item.model.id}</span>
                        <span className="bte-palette-library">{item.library}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <footer className="bte-palette-footer">
        {warnings.length > 0 && (
          <p className="field-help error" title={warnings.join('\n')}>
            {warnings[0]}
            {warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ''}
          </p>
        )}
        {libraries.map(({ path, removable }) => (
          <div key={path} className="bte-library" title={removable ? path : `${path}: the widget’s, in its properties`}>
            <span>{path.replace(/^.*\//, '')}</span>
            {removable && (
              <button type="button" className="icon-button" aria-label={`Remove the library ${path}`} onClick={() => onRemoveLibrary(path)}>
                <CloseIcon width={14} height={14} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="button" onClick={onLoadLibrary}>
          <PlusIcon width={16} height={16} /> Load a library…
        </button>
      </footer>
    </aside>
  );
}
