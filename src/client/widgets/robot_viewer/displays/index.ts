// Tassello's own displays of the Robot Viewer: their definitions, which the
// registry and the side panel need, without three.js. Each display's class
// is imported, with three.js, when a viewer first shows one.

import type { ImageTransport } from '../../../../shared/protocol.ts';
import {
  AxesIcon,
  CameraIcon,
  CubeIcon,
  MapIcon,
  PathIcon,
  PointCloudIcon,
  PolygonIcon,
  ScanIcon,
  VoxelsIcon,
} from '../../../icons.tsx';
import { defineDisplay, type RegisteredDisplay } from '../../types.ts';
import {
  CAMERA_DISPLAY,
  GRID_DISPLAY,
  LASER_SCAN_DISPLAY,
  OCTOMAP_DISPLAY,
  PATH_DISPLAY,
  POINT_CLOUD_DISPLAY,
  POLYGON_DISPLAY,
  ROBOT_MODEL_DISPLAY,
  TF_DISPLAY,
} from '../model.ts';

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

export interface CameraDisplayConfig {
  topic: string;
  transport: ImageTransport;
  // '' : beside the images' topic
  cameraInfoTopic: string;
  // Of the images' frame: 'optical' z forward, x right, y down; 'body' x
  // forward, y left, z up
  axes: 'optical' | 'body';
  // Of the image from the camera, in meters
  distance: number;
  alpha: number;
  showFrustum: boolean;
  // Across, in degrees, without camera info
  fov: number;
  maxRate: number;
  maxWidth: number;
  quality: number;
}

export interface PolygonDisplayConfig {
  topic: string;
  color: string;
  // In pixels
  width: number;
  alpha: number;
}

export interface PathDisplayConfig {
  topic: string;
  color: string;
  // In pixels
  width: number;
  alpha: number;
  poseStyle: 'none' | 'arrows' | 'axes';
  // Of the arrows or axes, in meters
  poseSize: number;
}

export interface OctomapDisplayConfig {
  topic: string;
  colorBy: 'auto' | 'rgb' | 'height' | 'flat';
  color: string;
  alpha: number;
  // 1-16: 16 the map's resolution
  maxDepth: number;
  maxVoxels: number;
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

export const cameraDisplay = defineDisplay<CameraDisplayConfig>({
  type: CAMERA_DISPLAY,
  name: 'Camera',
  description: 'A camera’s images (sensor_msgs/Image or CompressedImage) in front of it, as it sees, with its frustum',
  icon: CameraIcon,
  load: () => import('./CameraDisplay.ts').then((m) => m.CameraDisplay),
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '/camera/image_raw',
      topicTypes: ['sensor_msgs/msg/Image', 'sensor_msgs/msg/CompressedImage'],
      help: 'Raw images are compressed to JPEG on the robot, compressed ones passed through',
    },
    {
      key: 'transport',
      label: 'Transport',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto: the type the topic is published with' },
        { value: 'raw', label: 'Raw: sensor_msgs/Image' },
        { value: 'compressed', label: 'Compressed: <topic>/compressed' },
      ],
    },
    {
      key: 'cameraInfoTopic',
      label: 'Camera info topic',
      kind: 'topic',
      default: '',
      topicTypes: ['sensor_msgs/msg/CameraInfo'],
      placeholder: 'Beside the images’: …/camera_info',
      help: 'Its projection sizes the image as the camera sees it; without it, the field of view below',
    },
    {
      key: 'axes',
      label: 'Axes of the images’ frame',
      kind: 'select',
      default: 'optical',
      options: [
        { value: 'optical', label: 'Optical: z forward, x right, y down' },
        { value: 'body', label: 'Body: x forward, y left, z up' },
      ],
      help: 'Camera drivers’ frames are optical (…_optical_frame); a camera_link is a body’s',
    },
    { key: 'distance', label: 'Image distance (m)', kind: 'number', default: 1, min: 0.05, max: 50, step: 0.1 },
    { key: 'alpha', label: 'Opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.1 },
    { key: 'showFrustum', label: 'Show the frustum', kind: 'boolean', default: true },
    {
      key: 'fov',
      label: 'Field of view without camera info (°)',
      kind: 'number',
      default: 60,
      min: 1,
      max: 170,
      step: 1,
    },
    { key: 'maxRate', label: 'Max rate (Hz)', kind: 'number', default: 10, min: 0.5, max: 30, step: 0.5 },
    {
      key: 'maxWidth',
      label: 'Max width (raw images, px)',
      kind: 'number',
      default: 640,
      min: 0,
      max: 8192,
      step: 1,
      help: 'Wider raw images are scaled down before being sent. 0: full size',
    },
    { key: 'quality', label: 'JPEG quality (raw images)', kind: 'number', default: 75, min: 1, max: 100, step: 1 },
  ],
});

export const polygonDisplay = defineDisplay<PolygonDisplayConfig>({
  type: POLYGON_DISPLAY,
  name: 'Polygon',
  description: 'A polygon (geometry_msgs/PolygonStamped), e.g. Nav2’s footprint, where TF puts its frame',
  icon: PolygonIcon,
  load: () => import('./PolygonDisplay.ts').then((m) => m.PolygonDisplay),
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '/local_costmap/published_footprint',
      topicTypes: ['geometry_msgs/msg/PolygonStamped'],
    },
    { key: 'color', label: 'Colour', kind: 'color', default: '#ffd23f' },
    { key: 'width', label: 'Line width (px)', kind: 'number', default: 2, min: 1, max: 20, step: 1 },
    { key: 'alpha', label: 'Opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.1 },
  ],
});

export const pathDisplay = defineDisplay<PathDisplayConfig>({
  type: PATH_DISPLAY,
  name: 'Path',
  description: 'A path (nav_msgs/Path), e.g. Nav2’s plan, where TF puts its frame',
  icon: PathIcon,
  load: () => import('./PathDisplay.ts').then((m) => m.PathDisplay),
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '/plan',
      topicTypes: ['nav_msgs/msg/Path'],
      help: 'Thinned on the robot to at most 5000 poses',
    },
    { key: 'color', label: 'Colour', kind: 'color', default: '#19ff00' },
    { key: 'width', label: 'Line width (px)', kind: 'number', default: 2, min: 1, max: 20, step: 1 },
    { key: 'alpha', label: 'Opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.1 },
    {
      key: 'poseStyle',
      label: 'Poses',
      kind: 'select',
      default: 'none',
      options: [
        { value: 'none', label: 'None: the line only' },
        { value: 'arrows', label: 'Arrows' },
        { value: 'axes', label: 'Axes' },
      ],
    },
    {
      key: 'poseSize',
      label: 'Pose size (m)',
      kind: 'number',
      default: 0.15,
      min: 0.01,
      max: 5,
      step: 0.05,
      visible: (c) => c.poseStyle !== 'none',
    },
  ],
});

export const octomapDisplay = defineDisplay<OctomapDisplayConfig>({
  type: OCTOMAP_DISPLAY,
  name: 'Octomap',
  description: 'An octomap’s occupied voxels (octomap_msgs/Octomap), decoded on the robot, where TF puts its frame',
  icon: VoxelsIcon,
  load: () => import('./OctomapDisplay.ts').then((m) => m.OctomapDisplay),
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: '/octomap_binary',
      topicTypes: ['octomap_msgs/msg/Octomap'],
      help: 'octomap_server’s /octomap_binary, or its /octomap_full, which has a ColorOcTree’s colours',
    },
    {
      key: 'colorBy',
      label: 'Colour',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Its colours, else by height' },
        { value: 'rgb', label: 'Its colours (a full ColorOcTree)' },
        { value: 'height', label: 'By height' },
        { value: 'flat', label: 'One colour' },
      ],
    },
    { key: 'color', label: 'Voxels’ colour', kind: 'color', default: '#5aa9e6', visible: (c) => c.colorBy === 'flat' },
    { key: 'alpha', label: 'Opacity', kind: 'number', default: 1, min: 0, max: 1, step: 0.1 },
    {
      key: 'maxDepth',
      label: 'Tree depth',
      kind: 'number',
      default: 16,
      min: 1,
      max: 16,
      step: 1,
      help: '16: the map’s resolution. Each level less doubles the voxels’ size, and draws far fewer of them',
    },
    {
      key: 'maxVoxels',
      label: 'Max voxels',
      kind: 'number',
      default: 200000,
      min: 1000,
      max: 1000000,
      step: 1000,
      help: 'The robot sends at most these, evenly through the map: 6-9 bytes each, each drawn as a cube',
    },
    { key: 'maxRate', label: 'Max rate (Hz)', kind: 'number', default: 1, min: 0.1, max: 10, step: 0.1 },
  ],
});

export const CORE_DISPLAYS: RegisteredDisplay[] = [
  robotModelDisplay,
  tfDisplay,
  gridDisplay,
  octomapDisplay,
  laserScanDisplay,
  pointCloudDisplay,
  cameraDisplay,
  pathDisplay,
  polygonDisplay,
];
