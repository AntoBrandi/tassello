// The panel's canvas: a grid of cells on which the widgets lie, as the
// device's layout places them (see layouts.ts). On desktops the cells have a
// fixed size and the board grows and scrolls both ways; on tablets and phones
// the columns are fixed and fill the width, the board scrolls down. In edit
// mode the widgets are dragged to move them and by their corner to resize
// them, snapping to the cells; a move or resize onto another widget is
// refused.

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
import { DEVICES, fits, type Layout } from './layouts.ts';

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
  id: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  origin: Rect;
  // Where it would land, in cells
  rect: Rect;
  // Pointer travel, in pixels
  dx: number;
  dy: number;
  moved: boolean;
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
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPlace: (id: string, rect: Rect) => void;
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
  selectedId,
  onSelect,
  onPlace,
  onRemove,
  onConfigure,
  onHide,
  onVisibleColumns,
}: BoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(scrollRef);
  const [drag, setDrag] = useState<Drag | null>(null);
  const columns = DEVICES[device].columns;
  const width = (previewWidth ?? viewport.width) - 2 * PADDING;
  const cell = columns === null ? CELL : Math.max(MIN_CELL, Math.floor(width / columns));
  const visibleCols = columns ?? Math.max(1, Math.floor(width / cell));
  const visibleRows = Math.max(1, Math.floor((viewport.height - 2 * PADDING) / cell));

  useEffect(() => onVisibleColumns?.(visibleCols), [visibleCols, onVisibleColumns]);

  const placed = [...layout.rects.values()];
  const content = extent(drag ? [...placed, drag.rect] : placed);
  const cols = columns ?? (editing ? Math.max(content.cols + EDIT_MARGIN, visibleCols) : content.cols);
  const rows = editing ? Math.max(content.rows + EDIT_MARGIN, visibleRows) : content.rows;

  const begin = (event: PointerEvent, widget: WidgetInstance, kind: Drag['kind']) => {
    const origin = layout.rects.get(widget.id);
    if (!editing || event.button !== 0 || drag || !origin) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const scroll = scrollRef.current!;
    setDrag({
      id: widget.id,
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: scroll.scrollLeft,
      startScrollTop: scroll.scrollTop,
      origin,
      rect: origin,
      dx: 0,
      dy: 0,
      moved: false,
    });
    onSelect(widget.id);
  };

  const track = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const scroll = scrollRef.current!;
    const dx = event.clientX - drag.startX + scroll.scrollLeft - drag.startScrollLeft;
    const dy = event.clientY - drag.startY + scroll.scrollTop - drag.startScrollTop;
    const { origin } = drag;
    let rect: Rect;
    if (drag.kind === 'move') {
      const x = Math.max(0, origin.x + Math.round(dx / cell));
      rect = {
        ...origin,
        x: columns === null ? x : Math.min(columns - origin.w, x),
        y: Math.max(0, origin.y + Math.round(dy / cell)),
      };
    } else {
      const min = widgetDefinition(panel.widgets.find((w) => w.id === drag.id)?.type ?? '')?.minSize;
      const maxWidth = columns === null ? MAX_SIZE : columns - origin.x;
      rect = {
        ...origin,
        w: Math.min(maxWidth, Math.max(Math.min(min?.w ?? 1, maxWidth), origin.w + Math.round(dx / cell))),
        h: Math.min(MAX_SIZE, Math.max(min?.h ?? 1, origin.h + Math.round(dy / cell))),
      };
    }
    setDrag({ ...drag, dx, dy, rect, moved: drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD });
  };

  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const { id, rect, origin, moved } = drag;
    setDrag(null);
    const changed = rect.x !== origin.x || rect.y !== origin.y || rect.w !== origin.w || rect.h !== origin.h;
    if (moved && changed && fits(rect, layout, columns, id)) {
      onPlace(id, rect);
    }
  };

  const dropValid = drag ? fits(drag.rect, layout, columns, drag.id) : true;

  return (
    <div
      ref={scrollRef}
      className={`board-scroll${columns === null ? '' : ' columns'}`}
      onPointerDown={(event) => {
        if (editing && !(event.target as Element).closest('.widget')) {
          onSelect(null);
        }
      }}
    >
      <div
        className={`board${editing ? ' editing' : ''}${previewWidth ? ' preview' : ''}`}
        style={{ width: cols * cell, height: rows * cell, '--cell': `${cell}px` } as CSSProperties}
      >
        {drag?.moved && (
          <div className={`drop-target${dropValid ? '' : ' invalid'}`} style={place(drag.rect, cell)} />
        )}
        {panel.widgets.map((widget) => {
          const rect = layout.rects.get(widget.id);
          if (!rect) {
            return null;
          }
          const dragged = drag?.id === widget.id && drag.moved ? drag : null;
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
                selectedId === widget.id && 'selected',
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

// One broken widget must not take the board down. Retried when its config
// changes.
class WidgetErrorBoundary extends Component<
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
