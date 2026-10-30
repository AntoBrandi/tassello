// A panel's status bar, under the top bar and above its board: a row of
// columns stretched to its width (see status_bar.ts), on which the status
// widgets lie. In edit mode, as on the board, a status widget is selected by a
// click, dragged to move it and by its corner to resize it, snapping to the
// columns; a move or resize onto another is refused. The ＋ at its end adds
// one.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
} from 'react';

import type { Rect, StatusWidgetInstance } from '../../shared/panel.ts';
import { CloseIcon, PlusIcon, QuestionIcon } from '../icons.tsx';
import { resolveConfig, statusWidgetDefinition } from '../widgets/registry.ts';
import { StatusReadout } from '../widgets/status/StatusReadout.tsx';
import { WidgetErrorBoundary } from './Board.tsx';
import { fits, movedBy } from './layouts.ts';
import { placeStatus, STATUS_COLUMNS, STATUS_GAP, statusLayout, widened } from './status_bar.ts';

// A press that moves less than this is a click, not a drag
const DRAG_THRESHOLD = 4;

interface Drag {
  id: string;
  kind: 'move' | 'resize';
  pointerId: number;
  startX: number;
  origin: Rect;
  // Where it would land
  rect: Rect;
  // Pointer travel, in pixels
  dx: number;
  moved: boolean;
}

export interface StatusBarProps {
  widgets: StatusWidgetInstance[];
  panelId: string;
  editing: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  // A status widget moved or resized, in columns
  onPlace: (id: string, place: { x: number; w: number }) => void;
  onRemove: (id: string) => void;
  // A status widget's own changes of its properties
  onConfigure: (id: string, changes: Record<string, unknown>) => void;
  onAdd: () => void;
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function minWidth(type: string): number {
  return statusWidgetDefinition(type)?.minWidth ?? 1;
}

export function StatusBar({ widgets, panelId, editing, selected, onSelect, onPlace, onRemove, onConfigure, onAdd }: StatusBarProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(gridRef);
  const column = width / STATUS_COLUMNS;
  const layout = useMemo(() => statusLayout(widgets), [widgets]);
  const [drag, setDrag] = useState<Drag | null>(null);

  const begin = (event: PointerEvent, widget: StatusWidgetInstance, kind: Drag['kind']) => {
    const origin = layout.rects.get(widget.id);
    if (!editing || event.button !== 0 || drag || !origin) {
      return;
    }
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: widget.id, kind, pointerId: event.pointerId, startX: event.clientX, origin, rect: origin, dx: 0, moved: false });
  };

  const track = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId || column <= 0) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const columns = Math.round(dx / column);
    const rect =
      drag.kind === 'move'
        ? movedBy(new Map([[drag.id, drag.origin]]), columns, 0, STATUS_COLUMNS).get(drag.id)!
        : widened(drag.origin, columns, minWidth(widgets.find((w) => w.id === drag.id)?.type ?? ''));
    setDrag({ ...drag, dx, rect, moved: drag.moved || Math.abs(dx) > DRAG_THRESHOLD });
  };

  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const { id, origin, rect, moved } = drag;
    setDrag(null);
    if (!moved) {
      if (event.type === 'pointerup') {
        onSelect(id);
      }
      return;
    }
    onSelect(id);
    if ((rect.x !== origin.x || rect.w !== origin.w) && fits(new Map([[id, rect]]), layout, STATUS_COLUMNS)) {
      onPlace(id, { x: rect.x, w: rect.w });
    }
  };

  const dropValid = drag ? fits(new Map([[drag.id, drag.rect]]), layout, STATUS_COLUMNS) : true;

  return (
    <div className={`statusbar${editing ? ' editing' : ''}`} role="region" aria-label="Status bar">
      <div
        ref={gridRef}
        className="statusbar-grid"
        style={{ '--status-column': `${column}px` } as CSSProperties}
        onPointerDown={(event) => {
          if (editing && !(event.target as Element).closest('.status-widget')) {
            onSelect(null);
          }
        }}
      >
        {drag?.moved && (
          <div className={`drop-target${dropValid ? '' : ' invalid'}`} style={placeStatus(drag.rect, column)} />
        )}
        {widgets.map((widget) => {
          const rect = layout.rects.get(widget.id)!;
          const dragged = drag?.moved && drag.id === widget.id ? drag : null;
          const style: CSSProperties = placeStatus(rect, column);
          if (dragged?.kind === 'move') {
            style.transform = `translateX(${dragged.dx}px)`;
          } else if (dragged?.kind === 'resize') {
            style.width = Math.max(column - STATUS_GAP, rect.w * column - STATUS_GAP + dragged.dx);
          }
          const name = statusWidgetDefinition(widget.type)?.name ?? widget.type;
          return (
            <div
              key={widget.id}
              className={[
                'status-widget',
                editing && 'editing',
                selected === widget.id && 'selected',
                dragged && 'dragging',
                // It covers the drop target
                dragged && !dropValid && 'refused',
              ]
                .filter(Boolean)
                .join(' ')}
              style={style}
              title={editing ? `${name}: drag it to move it, by its corner to resize it` : undefined}
              onPointerDown={(event) => begin(event, widget, 'move')}
              onPointerMove={track}
              onPointerUp={end}
              onPointerCancel={end}
            >
              <StatusWidgetView instance={widget} panelId={panelId} editing={editing} onConfigure={onConfigure} />
              {editing && (
                <>
                  <button
                    type="button"
                    className="status-remove"
                    title={`Remove ${name}`}
                    aria-label={`Remove ${name}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onRemove(widget.id)}
                  >
                    <CloseIcon width={11} height={11} />
                  </button>
                  {/* Its moves and release reach the widget's handlers */}
                  <div className="status-resize" title="Resize" onPointerDown={(event) => begin(event, widget, 'resize')} />
                </>
              )}
            </div>
          );
        })}
        {editing && widgets.length === 0 && (
          <span className="statusbar-hint">This panel’s status bar: readings at a glance, such as the Wi-Fi and the CPU</span>
        )}
      </div>
      {editing && (
        <button type="button" className="button statusbar-add" title="Add a status widget" aria-label="Add a status widget" onClick={onAdd}>
          <PlusIcon width={16} height={16} />
          <span className="hide-narrow">Status</span>
        </button>
      )}
    </div>
  );
}

const StatusWidgetView = memo(function StatusWidgetView({
  instance,
  panelId,
  editing,
  onConfigure,
}: {
  instance: StatusWidgetInstance;
  panelId: string;
  editing: boolean;
  onConfigure: StatusBarProps['onConfigure'];
}) {
  const definition = statusWidgetDefinition(instance.type);
  const config = useMemo(
    () => (definition ? resolveConfig(definition, instance.config) : {}),
    [definition, instance.config],
  );
  const updateConfig = useCallback(
    (changes: Record<string, unknown>) => onConfigure(instance.id, changes),
    [onConfigure, instance.id],
  );
  if (!definition) {
    return (
      <StatusReadout
        icon={<QuestionIcon width={16} height={16} />}
        value="?"
        tone="off"
        title={`Unknown status widget type “${instance.type}”: is the plugin that adds it installed?`}
      />
    );
  }
  return (
    <WidgetErrorBoundary resetKey={config}>
      <definition.component
        config={config}
        instance={instance}
        panelId={panelId}
        editing={editing}
        updateConfig={updateConfig}
      />
    </WidgetErrorBoundary>
  );
});
