// A viewer of displays, as the Robot Viewer widget shows one, for any widget:
// the view, its toolbar (Reset, and if asked for 3D or 2D and the fixed
// frame), what it waits for, and its displays' notes. The Robot Viewer is one
// with its widget's config; a plugin embeds one with displays of its choosing
// (Tassello's, its own), e.g. a map and the paths built on it:
//
//   const ViewerView = lazy(() => import('tassello/viewer').then((m) => ({ default: m.ViewerView })));
//   <ViewerView fixedFrame="map" view="2d" displays={[
//     { id: 'map', type: 'grid-display', name: 'Map', enabled: true, config: { topic: '/map' } },
//   ]} />
//
// Imported lazily, as above: tassello/viewer brings three.js, fetched only when
// a viewer is shown.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { DisplayInstance } from '../../../shared/panel.ts';
import { CubeIcon, FitIcon } from '../../icons.tsx';
import { displayDefinition, resolveConfig } from '../registry.ts';
import type { DisplayNote, ViewMode } from './display.ts';
import { Viewer, type ViewerDisplay, type ViewerState } from './Viewer.ts';

export interface ViewerViewProps {
  // The frame the view is in; '' for Auto: the robot model's root link, else
  // the root of the TF tree. A display whose frame is the fixed frame needs no
  // TF to be shown.
  fixedFrame: string;
  view: ViewMode;
  // In the order they are drawn (later on top), as the Robot Viewer's list
  displays: DisplayInstance[];
  // Given: the toolbar has the 3D/2D switch, and the fixed frame's menu
  onViewChange?: (view: ViewMode) => void;
  onFixedFrameChange?: (frame: string) => void;
  // The toolbar's switch and menu greyed out, e.g. while the panel is edited
  disabled?: boolean;
  // Said in the middle while there are no displays
  emptyMessage?: string;
  // Drawn over the view, e.g. the widget's own controls
  children?: ReactNode;
}

export function ViewerView({
  fixedFrame,
  view,
  displays,
  onViewChange,
  onFixedFrameChange,
  disabled = false,
  emptyMessage = 'No displays',
  children,
}: ViewerViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [state, setState] = useState<ViewerState | null>(null);

  useEffect(() => {
    const created = new Viewer(containerRef.current!, setState);
    viewer.current = created;
    return () => {
      created.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => viewer.current?.setView(view), [view]);
  useEffect(() => viewer.current?.setFixedFrame(fixedFrame), [fixedFrame]);
  const resolved = useMemo<ViewerDisplay[]>(
    () =>
      displays.map((instance) => {
        const definition = displayDefinition(instance.type);
        return { instance, definition, config: definition ? resolveConfig(definition, instance.config) : {} };
      }),
    [displays],
  );
  useEffect(() => viewer.current?.setDisplays(resolved), [resolved]);

  // What hides the view: nothing to show, and why
  const shown = state?.displays.some((d) => d.level === 'ok' || d.level === 'warn');
  const blocking = state && !shown ? state.displays.find((d) => d.level === 'waiting' || d.level === 'error') : undefined;
  const problem = !state
    ? null
    : state.displays.length === 0
      ? { level: 'waiting', message: emptyMessage }
      : blocking && { level: blocking.level, message: blocking.message };

  const notes: DisplayNote[] = [];
  if (state?.frameError) {
    notes.push({ text: state.frameError, tone: 'warn' });
  }
  for (const display of state?.displays ?? []) {
    if (display.level !== 'ok' && display !== blocking) {
      notes.push({ text: `${display.name}: ${display.message}`, tone: 'warn' });
    }
    notes.push(...display.notes);
  }
  const info = notes.filter((note) => note.tone === 'info');
  const listed = [
    ...notes.filter((note) => note.tone === 'accent'),
    ...notes.filter((note) => note.tone !== 'accent' && note.tone !== 'info'),
  ];
  const frames = state?.frames ?? [];

  return (
    <div className="robot-model">
      <div ref={containerRef} className="robot-canvas" />
      {problem && (
        <div className={`robot-overlay ${problem.level}`}>
          <CubeIcon width={28} height={28} />
          <span>{problem.message}</span>
        </div>
      )}
      <div className="overlay-toolbar robot-toolbar">
        <button
          type="button"
          className="overlay-button"
          title="Reset the view"
          aria-label="Reset the view"
          onClick={() => viewer.current?.resetView()}
        >
          <FitIcon width={17} height={17} />
        </button>
        {onViewChange && (
          <>
            <span className="overlay-separator" />
            <div className="robot-view-switch" role="group" aria-label="View">
              {(['3d', '2d'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="overlay-button robot-view-button"
                  aria-pressed={view === mode}
                  title={mode === '3d' ? '3D: drag to orbit' : '2D, from above: drag to pan'}
                  disabled={disabled}
                  onClick={() => onViewChange(mode)}
                >
                  {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}
        {onFixedFrameChange && (
          <>
            <span className="overlay-separator" />
            <select
              className="robot-frame-select"
              aria-label="Fixed frame"
              title={`Fixed frame: ${state?.fixedFrame || 'none'}`}
              value={fixedFrame}
              disabled={disabled}
              onChange={(e) => onFixedFrameChange(e.target.value)}
            >
              <option value="">{state?.autoFrame ? `Auto (${state.autoFrame})` : 'Auto'}</option>
              {fixedFrame && !frames.includes(fixedFrame) && <option value={fixedFrame}>{fixedFrame}</option>}
              {frames.map((frame) => (
                <option key={frame} value={frame}>
                  {frame}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {info.length > 0 && (
        <div className="robot-loading">
          {info.map((note) => (
            <div key={note.text}>{note.text}</div>
          ))}
        </div>
      )}
      <div className="robot-notes">
        {listed.map((note, i) => (
          <span key={`${i} ${note.text}`} className={note.tone === 'accent' ? 'robot-motion' : 'robot-note'}>
            {note.text}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}
