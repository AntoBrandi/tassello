// The robot in 3D, or from above in 2D, as RViz shows it: displays drawn in a
// fixed frame, each a kind of thing (the robot model, TF, a map, a laser scan,
// a point cloud, or a plugin's), with its own properties, in a list edited in
// the side panel. Drag to orbit (pan in 2D), right drag (two fingers) to pan,
// scroll (pinch) to zoom.
//
// It replaces the Robot Model widget, whose type it keeps: the panels' robot
// models open as viewers of the robot model, its frames as a TF display.
//
// three.js is large: its code (RobotViewerView.tsx, the displays' classes) is
// only fetched when a panel shows a viewer.

import { lazy, Suspense } from 'react';

import type { DisplayInstance } from '../../../shared/panel.ts';
import { useTfFrames } from '../../connection.ts';
import { CubeIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { DEFAULT_DISPLAYS, migrateRobotModelConfig } from './model.ts';

export interface RobotViewerConfig {
  // '' for Auto: the robot model's root link, else the root of the TF tree
  fixedFrame: string;
  view: '3d' | '2d';
  displays: DisplayInstance[];
}

const RobotViewerView = lazy(() => import('./RobotViewerView.tsx'));

function RobotViewerWidget(props: WidgetProps<RobotViewerConfig>) {
  return (
    <Suspense fallback={<div className="widget-message">Loading the 3D view…</div>}>
      <RobotViewerView {...props} />
    </Suspense>
  );
}

// The TF frames, as options of the fixed frame
function useFrameOptions() {
  const update = useTfFrames('', 1);
  return (update?.frames ?? []).map((frame) => ({ value: frame.name, label: frame.name }));
}

export const robotViewerWidget = defineWidget<RobotViewerConfig>({
  // The Robot Model widget's, which it replaces: never change it
  type: 'robot-model',
  name: 'Robot Viewer',
  description: 'The robot in 3D or from above, as RViz shows it: its model, TF, maps, laser scans and point clouds.',
  icon: CubeIcon,
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 3, h: 3 },
  component: RobotViewerWidget,
  migrate: migrateRobotModelConfig,
  properties: [
    {
      key: 'fixedFrame',
      label: 'Fixed frame',
      kind: 'select',
      default: '',
      options: [{ value: '', label: 'Auto: the robot' }],
      useOptions: useFrameOptions,
      help: 'The frame the view is in, which TF places everything in: map or odom to see the robot move. Auto: the robot model’s root link',
    },
    {
      key: 'view',
      label: 'View',
      kind: 'select',
      default: '3d',
      options: [
        { value: '3d', label: '3D' },
        { value: '2d', label: '2D, from above' },
      ],
    },
    {
      key: 'displays',
      label: 'Displays',
      kind: 'displays',
      default: DEFAULT_DISPLAYS,
      help: 'What it draws, as RViz’s displays: plugins add more',
    },
  ],
});
