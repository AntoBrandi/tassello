// Tassello's own displays of the Robot Viewer: their definitions, which the
// registry and the side panel need, without three.js. Each display's class
// is imported, with three.js, when a viewer first shows one.

import { AxesIcon, CubeIcon, MapIcon, PointCloudIcon, ScanIcon } from '../../../icons.tsx';
import { defineDisplay, type RegisteredDisplay } from '../../types.ts';
import { GRID_DISPLAY, LASER_SCAN_DISPLAY, POINT_CLOUD_DISPLAY, ROBOT_MODEL_DISPLAY, TF_DISPLAY } from '../model.ts';

export interface RobotModelDisplayConfig {
  descriptionTopic: string;
  jointStatesTopic: string;
  highlightMotion: boolean;
}

export interface TfDisplayConfig {
  showAxes: boolean;
  showNames: boolean;
  showArrows: boolean;
  // Of the axes, in meters; 0: after the robot's size
  scale: number;
  filter: string;
}

export interface GridDisplayConfig {
  topic: string;
  style: 'map' | 'costmap';
  alpha: number;
}

export interface LaserScanDisplayConfig {
  topic: string;
  colorBy: 'flat' | 'intensity' | 'height';
  color: string;
  // In pixels
  size: number;
  maxRate: number;
}

export interface PointCloudDisplayConfig {
  topic: string;
  colorBy: 'auto' | 'rgb' | 'intensity' | 'height' | 'flat';
  color: string;
  size: number;
  maxPoints: number;
  maxRate: number;
}

export const robotModelDisplay = defineDisplay<RobotModelDisplayConfig>({
  type: ROBOT_MODEL_DISPLAY,
  name: 'Robot Model',
  description: 'The robot in 3D, from its description and joint states, its moving joints highlighted',
  icon: CubeIcon,
  load: () => import('./RobotModelDisplay.ts').then((m) => m.RobotModelDisplay),
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
    {
      key: 'highlightMotion',
      label: 'Highlight the moving joints',
      kind: 'boolean',
      default: true,
      help: 'Their links take another colour, with an arrow in the direction of the motion',
    },
  ],
});

export const tfDisplay = defineDisplay<TfDisplayConfig>({
  type: TF_DISPLAY,
  name: 'TF',
  description: 'The TF frames: their axes (x red, y green, z blue), names, and the links to their parents',
  icon: AxesIcon,
  load: () => import('./TfDisplay.ts').then((m) => m.TfDisplay),
  properties: [
    { key: 'showAxes', label: 'Show the axes', kind: 'boolean', default: true },
    { key: 'showNames', label: 'Show the names', kind: 'boolean', default: true },
    {
      key: 'showArrows',
      label: 'Show the links to the parents',
      kind: 'boolean',
      default: false,
      help: 'A line from each frame to its parent, yellow at the frame',
    },
    {
      key: 'scale',
      label: 'Axes length (m)',
      kind: 'number',
      default: 0,
      min: 0,
      max: 10,
      step: 0.05,
      help: '0: after the size of the robot',
    },
    {
      key: 'filter',
      label: 'Frames',
      kind: 'string',
      default: '',
      placeholder: 'All',
      help: 'Those whose names contain one of these words, comma-separated, e.g. wheel, laser',
    },
  ],
});

export const gridDisplay = defineDisplay<GridDisplayConfig>({
  type: GRID_DISPLAY,
  name: 'Occupancy Grid',
  description: 'A map or a costmap (nav_msgs/OccupancyGrid), on the ground of its frame',
  icon: MapIcon,
  load: () => import('./OccupancyGridDisplay.ts').then((m) => m.OccupancyGridDisplay),
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '/map',
      topicTypes: ['nav_msgs/msg/OccupancyGrid'],
      help: 'Kept up to date by its <topic>_updates, as Nav2’s costmaps publish them',
    },
    {
      key: 'style',
      label: 'Colours',
      kind: 'select',
      default: 'map',
      options: [
        { value: 'map', label: 'Map: occupancy in greys' },
        { value: 'costmap', label: 'Costmap: costs in colours' },
      ],
    },
    { key: 'alpha', label: 'Opacity', kind: 'number', default: 0.8, min: 0, max: 1, step: 0.1 },
  ],
});

export const laserScanDisplay = defineDisplay<LaserScanDisplayConfig>({
  type: LASER_SCAN_DISPLAY,
  name: 'Laser Scan',
  description: 'A laser scan’s returns (sensor_msgs/LaserScan), where TF puts its frame',
  icon: ScanIcon,
  load: () => import('./PointsDisplays.ts').then((m) => m.LaserScanDisplay),
  properties: [
    { key: 'topic', label: 'Topic', kind: 'topic', default: '/scan', topicTypes: ['sensor_msgs/msg/LaserScan'] },
    {
      key: 'colorBy',
      label: 'Colour',
      kind: 'select',
      default: 'flat',
      options: [
        { value: 'flat', label: 'One colour' },
        { value: 'intensity', label: 'By intensity' },
        { value: 'height', label: 'By height' },
      ],
    },
    { key: 'color', label: 'Points’ colour', kind: 'color', default: '#ff2d6f', visible: (c) => c.colorBy === 'flat' },
    { key: 'size', label: 'Point size (px)', kind: 'number', default: 3, min: 1, max: 20, step: 1 },
    { key: 'maxRate', label: 'Max rate (Hz)', kind: 'number', default: 10, min: 0.5, max: 30, step: 0.5 },
  ],
});

export const pointCloudDisplay = defineDisplay<PointCloudDisplayConfig>({
  type: POINT_CLOUD_DISPLAY,
  name: 'Point Cloud',
  description: 'A point cloud (sensor_msgs/PointCloud2), thinned on the robot, where TF puts its frame',
  icon: PointCloudIcon,
  load: () => import('./PointsDisplays.ts').then((m) => m.PointCloudDisplay),
  properties: [
    { key: 'topic', label: 'Topic', kind: 'topic', default: '/points', topicTypes: ['sensor_msgs/msg/PointCloud2'] },
    {
      key: 'colorBy',
      label: 'Colour',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Its colours, else its intensity, else by height' },
        { value: 'rgb', label: 'Its colours (rgb)' },
        { value: 'intensity', label: 'By intensity' },
        { value: 'height', label: 'By height' },
        { value: 'flat', label: 'One colour' },
      ],
    },
    { key: 'color', label: 'Points’ colour', kind: 'color', default: '#3cc4b0', visible: (c) => c.colorBy === 'flat' },
    { key: 'size', label: 'Point size (px)', kind: 'number', default: 2, min: 1, max: 20, step: 1 },
    {
      key: 'maxPoints',
      label: 'Max points',
      kind: 'number',
      default: 30000,
      min: 100,
      max: 500000,
      step: 1000,
      help: 'The robot sends at most these, evenly through the cloud: 6-9 bytes each',
    },
    { key: 'maxRate', label: 'Max rate (Hz)', kind: 'number', default: 5, min: 0.5, max: 30, step: 0.5 },
  ],
});

export const CORE_DISPLAYS: RegisteredDisplay[] = [
  robotModelDisplay,
  tfDisplay,
  gridDisplay,
  laserScanDisplay,
  pointCloudDisplay,
];
