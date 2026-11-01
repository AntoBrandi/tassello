// tassello/viewer: what the plugins' displays of the Robot Viewer are made
// with, the page's own, with three.js. Import it, and three, only in a
// display's module, which its definition loads (defineDisplay of tassello/sdk):
// the page fetches three.js when a viewer first shows a display, not before.
//
//   import { ArrowHelper, Vector3 } from 'three';
//   import { Display, type DisplayContext } from 'tassello/viewer';
//
// three is the page's own too (its import map): the plugins' objects are drawn
// by its renderer. Build them as external modules (the tassello/vite plugin
// does), with three as a development dependency of the version Tassello has.

export {
  Display,
  normalizeFrame,
  type DisplayClass,
  type DisplayContext,
  type DisplayNote,
  type DisplayStatusLevel,
  type FrameState,
  type Pose,
  type ViewerPointer,
  type ViewMode,
} from '../widgets/robot_viewer/display.ts';
export { ViewerView, type ViewerViewProps } from '../widgets/robot_viewer/ViewerView.tsx';
export { PointsLayer, toLinear, type PointsColoring, type PointsStyle } from '../widgets/robot_viewer/displays/points.ts';
export { LinesLayer, type LinesStyle } from '../widgets/robot_viewer/displays/lines.ts';
export {
  rainbow,
  parseColor,
  frameFilter,
  cameraInfoTopic,
  intrinsicsOf,
  intrinsicsFromFov,
  imageCorners,
  type Intrinsics,
} from '../widgets/robot_viewer/model.ts';

// Tassello's displays, to extend
export { RobotModelDisplay, type JointMotion } from '../widgets/robot_viewer/displays/RobotModelDisplay.ts';
export { TfDisplay } from '../widgets/robot_viewer/displays/TfDisplay.ts';
export { OccupancyGridDisplay } from '../widgets/robot_viewer/displays/OccupancyGridDisplay.ts';
export { PointsDisplay, LaserScanDisplay, PointCloudDisplay } from '../widgets/robot_viewer/displays/PointsDisplays.ts';
export { CameraDisplay } from '../widgets/robot_viewer/displays/CameraDisplay.ts';
export { PolygonDisplay } from '../widgets/robot_viewer/displays/PolygonDisplay.ts';
export { PathDisplay } from '../widgets/robot_viewer/displays/PathDisplay.ts';
export { OctomapDisplay } from '../widgets/robot_viewer/displays/OctomapDisplay.ts';
export type {
  CameraDisplayConfig,
  GridDisplayConfig,
  LaserScanDisplayConfig,
  OctomapDisplayConfig,
  PathDisplayConfig,
  PointCloudDisplayConfig,
  PolygonDisplayConfig,
  RobotModelDisplayConfig,
  TfDisplayConfig,
} from '../widgets/robot_viewer/displays/index.ts';
export { loadRobot, type LoadedRobot } from '../widgets/robot_viewer/displays/urdf.ts';
