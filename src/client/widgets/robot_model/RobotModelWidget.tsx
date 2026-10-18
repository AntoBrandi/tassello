// The robot in 3D, from its description (URDF) and joint states: the moving
// joints highlighted, with the direction of their motion, and optionally the
// TF frames of its links. Drag to orbit, right drag (two fingers) to pan,
// scroll (pinch) to zoom.
//
// three.js is large: its code (RobotModelView.tsx) is only fetched when a
// panel shows a robot model.

import { lazy, Suspense } from 'react';

import { CubeIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';

export interface RobotModelConfig {
  descriptionTopic: string;
  jointStatesTopic: string;
  showFrames: boolean;
  highlightMotion: boolean;
}

const RobotModelView = lazy(() => import('./RobotModelView.tsx'));

function RobotModelWidget({ config }: WidgetProps<RobotModelConfig>) {
  return (
    <Suspense fallback={<div className="widget-message">Loading the 3D view…</div>}>
      <RobotModelView config={config} />
    </Suspense>
  );
}

export const robotModelWidget = defineWidget<RobotModelConfig>({
  type: 'robot-model',
  name: 'Robot Model',
  description: 'The robot in 3D, its moving joints highlighted, and its TF frames.',
  icon: CubeIcon,
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 3, h: 3 },
  component: RobotModelWidget,
  properties: [
    {
      key: 'descriptionTopic',
      label: 'Robot description topic',
      kind: 'topic',
      default: '/robot_description',
      topicTypes: ['std_msgs/msg/String'],
      help: 'The URDF, as robot_state_publisher publishes it. Its package:// meshes come from the robot',
    },
    {
      key: 'jointStatesTopic',
      label: 'Joint states topic',
      kind: 'topic',
      default: '/joint_states',
      topicTypes: ['sensor_msgs/msg/JointState'],
      help: 'Where the joints are, and how they move',
    },
    { key: 'showFrames', label: 'Show the TF frames', kind: 'boolean', default: false },
    {
      key: 'highlightMotion',
      label: 'Highlight the moving joints',
      kind: 'boolean',
      default: true,
      help: 'Their links take another colour, with an arrow in the direction of the motion',
    },
  ],
});
