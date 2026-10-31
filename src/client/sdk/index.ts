// tassello/sdk: what the plugins' widgets are made with. The page provides it
// at run time, through its import map, so that the plugins share the page's
// connection, dialogs and React: plugins build it as an external module (the
// tassello/vite plugin does), and get its types from the tassello package.
//
//   import { connection, defineWidget, definePlugin, useTopic } from 'tassello/sdk';
//
// The Robot Viewer's displays are defined here (defineDisplay), and made with
// tassello/viewer (see viewer.ts), which brings three.js.

// Widgets, status widgets, displays and plugins
export {
  defineWidget,
  defineStatusWidget,
  defineDisplay,
  definePlugin,
  type WidgetDefinition,
  type WidgetProps,
  type StatusWidgetDefinition,
  type StatusWidgetProps,
  type DisplayDefinition,
  type PropertySchema,
  type Property,
  type RegisteredWidget,
  type RegisteredStatusWidget,
  type RegisteredDisplay,
  type TasselloClientPlugin,
} from '../widgets/types.ts';
export { StatusReadout, type StatusReadoutProps, type StatusTone } from '../widgets/status/StatusReadout.tsx';
export { STATUS_COLUMNS } from '../../shared/panel.ts';

// The robot: ROS topics, services and TF, the plugins' server sides, commands
export {
  connection,
  useConnectionStatus,
  useTopic,
  useTf,
  useTfFrames,
  useCommandState,
  type BehaviorTreeFileHandlers,
  type BehaviorTreeFileOptions,
  type BehaviorTreeHandlers,
  type BehaviorTreeOptions,
  type BehaviorTreePlaybackOptions,
  type BehaviorTreePlaybackRequest,
  type Connection,
  type ConnectionStatus,
  type TopicState,
  type TopicHandlers,
  type TopicOptions,
  type PluginStreamHandlers,
  type RosoutHandlers,
  type RosoutOptions,
  type DiagnosticsHandlers,
  type DiagnosticsOptions,
  type TerminalHandlers,
  type TerminalOptions,
  type StreamHandlers,
  type FrameInfo,
  type ImageOptions,
  type OverlayHandlers,
  type OverlayOptions,
  type ParamsHandlers,
  type PointsFrame,
  type PointsHandlers,
  type PointsOptions,
  type TfOptions,
  type TfFramesOptions,
  type TopicMonitorHandlers,
  type TopicMonitorOptions,
  type TopicPublishOptions,
  type ActionHandlers,
  type ActionOptions,
} from '../connection.ts';
export { imageUrl, fsApi, ApiError, type Upload } from '../api.ts';

// The page
export { useDialogs, Modal, type Dialogs, type ConfirmOptions, type PromptOptions } from '../dialogs.tsx';
export { notify } from '../notifications.tsx';
export { Joystick, type JoystickProps } from '../widgets/Joystick.tsx';
export * from '../icons.tsx';

export type {
  BehaviorTreeFile,
  BehaviorTreeInfo,
  BehaviorTreeModels,
  BehaviorTreePlaybackState,
  BehaviorTreeRecording,
  BehaviorTreeSaved,
  BehaviorTreeUpdate,
  BtNode,
  BtNodeLibrary,
  BtNodeState,
  BtTransition,
  CommandState,
  ClientMessage,
  DiagnosticChange,
  DiagnosticEntry,
  DiagnosticsUpdate,
  LogEntry,
  NetworkUpdate,
  OverlayKind,
  OverlayUpdate,
  PointsChannel,
  PointsInfo,
  PointsKind,
  Pose3D,
  ParamsUpdate,
  BagsUpdate,
  RosoutUpdate,
  ServerMessage,
  StreamStatus,
  SystemUpdate,
  TerminalExit,
  TerminalOutput,
  TfFrame,
  TfFramesUpdate,
  TfUpdate,
  Transform2D,
} from '../../shared/protocol.ts';
export type { Points, PointsLayout } from '../../shared/points.ts';
export type { BtNodeModel, BtPortModel } from '../../shared/bt_nodes.ts';
export type { ParamDescriptor, ParamInfo, ParamResult, ParamScalar, ParamType, ParamValue } from '../../shared/parameters.ts';
export type {
  BagCapabilities,
  BagFile,
  BagInfo,
  BagsRequest,
  BagTopic,
  CompressionMode,
  Playback,
  PlayRequest,
  Recording,
  RecordOptions,
  RecordRequest,
} from '../../shared/rosbag.ts';
export type {
  DiskIo,
  Fan,
  Gpu,
  NetworkIo,
  PowerRail,
  SystemInfo,
  SystemSample,
  Temperature,
  TrendPoint,
} from '../../shared/system.ts';
export type {
  ActionGoal,
  BigIntValue,
  CancelResult,
  GoalStatus,
  GraphEndpoints,
  GraphSnapshot,
  GraphTopic,
  InterfaceInfo,
  InterfaceKind,
  MessageConstant,
  MessageField,
  MessageSchema,
  PublishQos,
  PublishState,
  QosProblem,
  QosProfile,
  SpecialNumber,
  Spread,
  TopicDetails,
  TopicEcho,
  TopicEndpoint,
  TopicSamples,
  TopicStats,
  TruncatedValue,
} from '../../shared/monitor.ts';
export type {
  ConnectionKind,
  NetworkActivity,
  NetworkConnection,
  NetworkDevice,
  NetworkPermissions,
  NetworkRequest,
  NetworkResult,
  NetworkSecrets,
  NetworkSettings,
  NetworkState,
  WifiNetwork,
  WifiSecurity,
} from '../../shared/networking.ts';
export type {
  FsAnalysis,
  FsConflict,
  FsDetails,
  FsDisk,
  FsEntry,
  FsListing,
  FsOperation,
  FsPlaces,
  FsResult,
  FsSaved,
  FsSpace,
  FsText,
} from '../../shared/file_manager.ts';
export type { DisplayInstance, Panel, StatusWidgetInstance, WidgetInstance } from '../../shared/panel.ts';
