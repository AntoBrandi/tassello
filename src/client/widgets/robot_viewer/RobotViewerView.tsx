// The Robot Viewer widget's content, loaded with three.js only when a panel
// shows one (see RobotViewerWidget.tsx): the view, its toolbar (Reset, 3D or
// 2D, the fixed frame), what it waits for, and its displays' notes.

import { useEffect, useMemo, useRef, useState } from 'react';

import { CubeIcon, FitIcon } from '../../icons.tsx';
import { displayDefinition, resolveConfig } from '../registry.ts';
import type { WidgetProps } from '../types.ts';
import type { DisplayNote } from './display.ts';
import type { RobotViewerConfig } from './RobotViewerWidget.tsx';
import { Viewer, type ViewerDisplay, type ViewerState } from './Viewer.ts';

export default function RobotViewerView({ config, editing, updateConfig }: WidgetProps<RobotViewerConfig>) {
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

  useEffect(() => viewer.current?.setView(config.view), [config.view]);
  useEffect(() => viewer.current?.setFixedFrame(config.fixedFrame), [config.fixedFrame]);
  const displays = useMemo<ViewerDisplay[]>(
    () =>
      config.displays.map((instance) => {
        const definition = displayDefinition(instance.type);
        return { instance, definition, config: definition ? resolveConfig(definition, instance.config) : {} };
      }),
    [config.displays],
  );
  useEffect(() => viewer.current?.setDisplays(displays), [displays]);

  // What hides the view: nothing to show, and why
  const shown = state?.displays.some((d) => d.level === 'ok' || d.level === 'warn');
  const blocking = state && !shown ? state.displays.find((d) => d.level === 'waiting' || d.level === 'error') : undefined;
  const problem = !state
    ? null
    : state.displays.length === 0
      ? { level: 'waiting', message: 'No displays: add some in edit mode' }
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
        <span className="overlay-separator" />
        <div className="robot-view-switch" role="group" aria-label="View">
          {(['3d', '2d'] as const).map((view) => (
            <button
              key={view}
              type="button"
              className="overlay-button robot-view-button"
              aria-pressed={config.view === view}
              title={view === '3d' ? '3D: drag to orbit' : '2D, from above: drag to pan'}
              disabled={editing}
              onClick={() => updateConfig({ view })}
            >
              {view.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="overlay-separator" />
        <select
          className="robot-frame-select"
          aria-label="Fixed frame"
          title={`Fixed frame: ${state?.fixedFrame || 'none'}`}
          value={config.fixedFrame}
          disabled={editing}
          onChange={(e) => updateConfig({ fixedFrame: e.target.value })}
        >
          <option value="">{state?.autoFrame ? `Auto (${state.autoFrame})` : 'Auto'}</option>
          {config.fixedFrame && !frames.includes(config.fixedFrame) && (
            <option value={config.fixedFrame}>{config.fixedFrame}</option>
          )}
          {frames.map((frame) => (
            <option key={frame} value={frame}>
              {frame}
            </option>
          ))}
        </select>
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
    </div>
  );
}
