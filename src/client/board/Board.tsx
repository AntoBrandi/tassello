// The panel's canvas: a grid of cells on which the widgets lie, as the
// device's layout places them (see layouts.ts). On desktops the cells have a
// fixed size and the board grows and scrolls both ways; on tablets and phones
// the columns are fixed and fill the width, the board scrolls down. In edit
// mode the widgets are dragged to move them and by their corner to resize
// them, snapping to the cells; a move or resize onto another widget is
// refused. Several are selected with Ctrl (⌘, Shift) and a click, or by
// dragging a band across the board from an empty place, and dragged together.

import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { Device, Panel, Rect, WidgetInstance } from '../../shared/panel.ts';
import { EyeOffIcon, QuestionIcon, TrashIcon } from '../icons.tsx';
import { resolveConfig, widgetDefinition } from '../widgets/registry.ts';
import { CELL, extent, GAP, place } from './geometry.ts';
import { DEVICES, fits, movedBy, type Layout } from './layouts.ts';

// Empty cells beyond the widgets in edit mode, to drag them further
const EDIT_MARGIN = 4;
// Board padding inside the scroll area (see .board-scroll in styles.css)
const PADDING = 16;
// A press that moves less than this is a click, not a drag
const DRAG_THRESHOLD = 4;
const MAX_SIZE = 100;
// Stretched cells never get smaller than this
const MIN_CELL = 32;

interface Drag {
  // The widget pressed
  id: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  // Of the widgets dragged: the selection when moving, the widget pressed
  // when resizing
  origins: Map<string, Rect>;
  // Where they would land, in cells
  rects: Map<string, Rect>;
  // Pointer travel, in pixels
  dx: number;
  dy: number;
  moved: boolean;
  // The selection if the press turns out a click, not a drag
  click: string[] | null;
  // The selection once the press ends, if it turns out a drag, and shown
  // until then. Not made as the press begins: the properties panel it opens
  // would move the board under the finger (a tablet's cells shrink to make
  // room for it, a phone's board is covered by it)
  select: string[] | null;
}

// A band dragged across the board, from where it started to the pointer, in
// pixels on the board: the widgets it touches are selected
interface Band {
  pointerId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Selected before, and kept (Ctrl, ⌘, Shift)
  kept: string[];
  moved: boolean;
}

// Adds to the selection, instead of replacing it
function adding(event: PointerEvent): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey;
}

function bandSelection(band: Band, rects: Map<string, Rect>, cell: number): string[] {
  const left = Math.min(band.x0, band.x1);
  const right = Math.max(band.x0, band.x1);
  const top = Math.min(band.y0, band.y1);
  const bottom = Math.max(band.y0, band.y1);
  const touched = [...rects]
    .filter(([, rect]) => {
      const box = place(rect, cell);
      return box.left < right && left < box.left + box.width && box.top < bottom && top < box.top + box.height;
    })
    .map(([id]) => id);
  return [...new Set([...band.kept, ...touched])];
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export interface BoardProps {
  panel: Panel;
  device: Device;
  layout: Layout;
  // The width of the device shown, when not the one the page is on (edit
  // mode previewing a phone on a desktop): the board is that wide
  previewWidth: number | null;
  editing: boolean;
  selection: string[];
  onSelect: (ids: string[]) => void;
  // The widgets moved, or the one resized, by id
  onPlace: (rects: Map<string, Rect>) => void;
  onRemove: (id: string) => void;
  // A widget's own changes of its properties (WidgetProps.updateConfig)
  onConfigure: (id: string, changes: Record<string, unknown>) => void;
  // Tablets and phones only: hides the widget on the device
  onHide?: (id: string) => void;
  // Columns visible without scrolling, for placing new widgets
  onVisibleColumns?: (cols: number) => void;
}

export function Board({
  panel,
  device,
  layout,
  previewWidth,
  editing,
  selection,
  onSelect,
  onPlace,
  onRemove,
  onConfigure,
  onHide,
  onVisibleColumns,
}: BoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(scrollRef);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  const columns = DEVICES[device].columns;
  const width = (previewWidth ?? viewport.width) - 2 * PADDING;
  const cell = columns === null ? CELL : Math.max(MIN_CELL, Math.floor(width / columns));
  const visibleCols = columns ?? Math.max(1, Math.floor(width / cell));
  const visibleRows = Math.max(1, Math.floor((viewport.height - 2 * PADDING) / cell));

  useEffect(() => onVisibleColumns?.(visibleCols), [visibleCols, onVisibleColumns]);

  const placed = [...layout.rects.values()];
  const content = extent(drag ? [...placed, ...drag.rects.values()] : placed);
  const cols = columns ?? (editing ? Math.max(content.cols + EDIT_MARGIN, visibleCols) : content.cols);
  const rows = editing ? Math.max(content.rows + EDIT_MARGIN, visibleRows) : content.rows;

  const begin = (event: PointerEvent, widget: WidgetInstance, kind: Drag['kind']) => {
    if (!editing || event.button !== 0 || drag || !layout.rects.has(widget.id)) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    // A selected widget drags the selection along: clicked, it is selected
    // alone, or taken out of the selection (Ctrl, ⌘, Shift). Another is
    // selected (or added to the selection) when the press ends
    let dragged = [widget.id];
    let click: string[] | null = null;
    let select: string[] | null = null;
    if (kind === 'move' && selection.includes(widget.id)) {
      dragged = selection;
      click = adding(event) ? selection.filter((id) => id !== widget.id) : [widget.id];
    } else {
      if (kind === 'move' && adding(event)) {
        dragged = [...selection, widget.id];
      }
      click = select = dragged;
    }
    const origins = new Map(dragged.filter((id) => layout.rects.has(id)).map((id) => [id, layout.rects.get(id)!]));
    const scroll = scrollRef.current!;
    setDrag({
      id: widget.id,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: scroll.scrollLeft,
      startScrollTop: scroll.scrollTop,
      origins,
      rects: origins,
      dx: 0,
      dy: 0,
      moved: false,
      click,
      select,
    });
  };

  const track = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const scroll = scrollRef.current!;
    const dx = event.clientX - drag.startX + scroll.scrollLeft - drag.startScrollLeft;
    const dy = event.clientY - drag.startY + scroll.scrollTop - drag.startScrollTop;
    let rects: Map<string, Rect>;
    if (drag.kind === 'move') {
      rects = movedBy(drag.origins, Math.round(dx / cell), Math.round(dy / cell), columns);
    } else {
      const origin = drag.origins.get(drag.id)!;
      const min = widgetDefinition(panel.widgets.find((w) => w.id === drag.id)?.type ?? '')?.minSize;
      const maxWidth = columns === null ? MAX_SIZE : columns - origin.x;
      rects = new Map([
        [
          drag.id,
          {
            ...origin,
            w: Math.min(maxWidth, Math.max(Math.min(min?.w ?? 1, maxWidth), origin.w + Math.round(dx / cell))),
            h: Math.min(MAX_SIZE, Math.max(min?.h ?? 1, origin.h + Math.round(dy / cell))),
          },
        ],
      ]);
    }
    setDrag({ ...drag, dx, dy, rects, moved: drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD });
  };

  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const { rects, origins, moved, click, select } = drag;
    setDrag(null);
    if (!moved) {
      if (click && event.type === 'pointerup') {
        onSelect(click);
      }
      return;
    }
    if (select) {
      onSelect(select);
    }
    const changed = [...rects].some(([id, rect]) => {
      const origin = origins.get(id)!;
      return rect.x !== origin.x || rect.y !== origin.y || rect.w !== origin.w || rect.h !== origin.h;
    });
    if (changed && fits(rects, layout, columns)) {
      onPlace(rects);
    }
  };

  // Where the pointer is on the board, in pixels, kept within it
  const onBoard = (event: PointerEvent) => {
    const box = boardRef.current!.getBoundingClientRect();
    return {
      x: Math.min(box.width, Math.max(0, event.clientX - box.left)),
      y: Math.min(box.height, Math.max(0, event.clientY - box.top)),
    };
  };

  // From an empty place: a click unselects, a drag draws a band
  const beginBand = (event: PointerEvent<HTMLDivElement>) => {
    const scroll = event.currentTarget;
    const box = scroll.getBoundingClientRect();
    if (
      !editing ||
      event.button !== 0 ||
      drag ||
      band ||
      (event.target as Element).closest('.widget') ||
      // Its scroll bars
      event.clientX - box.left >= scroll.clientWidth ||
      event.clientY - box.top >= scroll.clientHeight
    ) {
      return;
    }
    scroll.setPointerCapture(event.pointerId);
    const { x, y } = onBoard(event);
    const kept = adding(event) ? selection : [];
    setBand({ pointerId: event.pointerId, x0: x, y0: y, x1: x, y1: y, kept, moved: false });
  };

  const trackBand = (event: PointerEvent) => {
    if (!band || event.pointerId !== band.pointerId) {
      return;
    }
    const { x, y } = onBoard(event);
    setBand({ ...band, x1: x, y1: y, moved: band.moved || Math.hypot(x - band.x0, y - band.y0) > DRAG_THRESHOLD });
  };

  const endBand = (event: PointerEvent) => {
    if (!band || event.pointerId !== band.pointerId) {
      return;
    }
    setBand(null);
    if (event.type === 'pointerup') {
      onSelect(band.moved ? bandSelection(band, layout.rects, cell) : band.kept);
    }
  };

  const dropValid = drag ? fits(drag.rects, layout, columns) : true;
  const selected = band?.moved ? bandSelection(band, layout.rects, cell) : (drag?.select ?? selection);

  return (
    <div
      ref={scrollRef}
      className={`board-scroll${columns === null ? '' : ' columns'}${band ? ' selecting' : ''}`}
      onPointerDown={beginBand}
      onPointerMove={trackBand}
      onPointerUp={endBand}
      onPointerCancel={endBand}
    >
      <div
        ref={boardRef}
        className={`board${editing ? ' editing' : ''}${previewWidth ? ' preview' : ''}`}
        style={{ width: cols * cell, height: rows * cell, '--cell': `${cell}px` } as CSSProperties}
      >
        {drag?.moved &&
          [...drag.rects].map(([id, rect]) => (
            <div key={id} className={`drop-target${dropValid ? '' : ' invalid'}`} style={place(rect, cell)} />
          ))}
        {band?.moved && (
          <div
            className="selection-band"
            style={{
              left: Math.min(band.x0, band.x1),
              top: Math.min(band.y0, band.y1),
              width: Math.abs(band.x1 - band.x0),
              height: Math.abs(band.y1 - band.y0),
            }}
          />
        )}
        {panel.widgets.map((widget) => {
          const rect = layout.rects.get(widget.id);
          if (!rect) {
            return null;
          }
          const dragged = drag?.moved && drag.rects.has(widget.id) ? drag : null;
          const style: CSSProperties = place(rect, cell);
          if (dragged?.kind === 'move') {
            style.transform = `translate(${dragged.dx}px, ${dragged.dy}px)`;
          } else if (dragged?.kind === 'resize') {
            style.width = Math.max(cell - GAP, rect.w * cell - GAP + dragged.dx);
            style.height = Math.max(cell - GAP, rect.h * cell - GAP + dragged.dy);
          }
          const definition = widgetDefinition(widget.type);
          const Icon = definition?.icon ?? QuestionIcon;
          return (
            <div
              key={widget.id}
              className={[
                'widget',
                editing && 'editing',
                selected.includes(widget.id) && 'selected',
                dragged && 'dragging',
              ]
                .filter(Boolean)
                .join(' ')}
              style={style}
              onPointerDown={(event) => begin(event, widget, 'move')}
              onPointerMove={track}
              onPointerUp={end}
              onPointerCancel={end}
            >
              <WidgetView instance={widget} panelId={panel.id} editing={editing} onConfigure={onConfigure} />
              {editing && (
                <div className="widget-chrome">
                  <span className="widget-tag">
                    <Icon width={14} height={14} />
                    {definition?.name ?? widget.type}
                  </span>
                  <div className="widget-buttons">
                    {onHide && (
                      <button
                        type="button"
                        className="widget-button"
                        title={`Hide on ${DEVICES[device].label.toLowerCase()}s`}
                        aria-label={`Hide on ${DEVICES[device].label.toLowerCase()}s`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => onHide(widget.id)}
                      >
                        <EyeOffIcon width={14} height={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="widget-button remove"
                      title="Remove widget"
                      aria-label="Remove widget"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => onRemove(widget.id)}
                    >
                      <TrashIcon width={14} height={14} />
                    </button>
                  </div>
                  <div
                    className="resize-handle"
                    title="Resize"
                    onPointerDown={(event) => begin(event, widget, 'resize')}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const WidgetView = memo(function WidgetView({
  instance,
  panelId,
  editing,
  onConfigure,
}: {
  instance: WidgetInstance;
  panelId: string;
  editing: boolean;
  onConfigure: BoardProps['onConfigure'];
}) {
  const definition = widgetDefinition(instance.type);
  const config = useMemo(
    () => (definition ? resolveConfig(definition, instance.config) : {}),
    [definition, instance.config],
  );
  const updateConfig = useCallback(
    (changes: Record<string, unknown>) => onConfigure(instance.id, changes),
    [onConfigure, instance.id],
  );
  return (
    <div className="widget-card">
      {instance.title && <div className="widget-title">{instance.title}</div>}
      <div className="widget-body">
        {definition ? (
          <WidgetErrorBoundary resetKey={config}>
            <definition.component
              config={config}
              instance={instance}
              panelId={panelId}
              editing={editing}
              updateConfig={updateConfig}
            />
          </WidgetErrorBoundary>
        ) : (
          <div className="widget-message">
            Unknown widget type “{instance.type}”: is the plugin that adds it installed?
          </div>
        )}
      </div>
    </div>
  );
});

// One broken widget must not take the board (or the status bar) down.
// Retried when its config changes.
export class WidgetErrorBoundary extends Component<
  { resetKey: unknown; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(previous: { resetKey: unknown }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    return this.state.error ? (
      <div className="widget-message error">This widget failed: {this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}
