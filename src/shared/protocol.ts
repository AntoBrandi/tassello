// Messages exchanged over the dashboard's WebSocket (/ws). Text frames carry
// one JSON message each; binary frames, from the server only, carry the frames
// of image and grid streams.
//
// Subscriptions (image, grid, tf, path, topic, services, logs, ...) are
// numbered by the client, in one sequence per connection, and ended with
// `unsubscribe`.

// How the camera widget reads a topic: 'auto' detects the type from the ROS
// graph, 'compressed' appends /compressed to the topic unless it ends with it.
export type ImageTransport = 'auto' | 'raw' | 'compressed';

// How an OccupancyGrid is coloured: 'map' grays (occupancy), unknown cells
// transparent; 'costmap' a cost scale over transparent free cells
export type GridStyle = 'map' | 'costmap';

// ── Client → server ──────────────────────────────────────────────────────────

// Velocity command of a teleop widget, sent at its rate while a pad is held and
// once more, all zero, when released. The server stops the robot (publishes a
// zero twist) when the stream stops for TELEOP_WATCHDOG_MS without that zero.
export interface TwistCommand {
  type: 'twist';
  topic: string;
  stamped: boolean;
  frameId: string;
  linear: { x: number; y: number };
  angular: { z: number };
}

export interface ImageSubscribe {
  type: 'image.subscribe';
  // Chosen by the client, unique within its connection
  id: number;
  topic: string;
  transport: ImageTransport;
  maxFps: number;
  // JPEG quality (1-100) of raw images, which the server compresses
  quality: number;
  // Raw images wider than this are scaled down, 0: never
  maxWidth: number;
}

// An OccupancyGrid topic (map, costmap), drawn into an image, and kept up to
// date with the map_msgs/OccupancyGridUpdate of <topic>_updates
export interface GridSubscribe {
  type: 'grid.subscribe';
  id: number;
  topic: string;
  style: GridStyle;
  maxFps: number;
}

// The transform from sourceFrame to targetFrame (the pose of sourceFrame in
// targetFrame), sent `rate` times a second
export interface TfSubscribe {
  type: 'tf.subscribe';
  id: number;
  targetFrame: string;
  sourceFrame: string;
  rate: number;
}

// A nav_msgs/Path topic, e.g. Nav2's plan, sent whenever it changes (at most
// a few times a second)
export interface PathSubscribe {
  type: 'path.subscribe';
  id: number;
  topic: string;
}

// Any topic, its messages as JSON: the latest, then the next ones, at most
// maxRate a second. Its status comes as stream.status.
export interface TopicSubscribe {
  type: 'topic.subscribe';
  id: number;
  topic: string;
  maxRate: number;
}

// The systemd services whose names match the pattern: a name prefix
// ("myrobot": myrobot*.service) or a glob ("myrobot-*"), sent
// whenever their state changes. Of the system and the user's service manager.
export interface ServicesSubscribe {
  type: 'services.subscribe';
  id: number;
  pattern: string;
}

export type ServiceScope = 'system' | 'user';
export type ServiceVerb = 'start' | 'stop' | 'restart';

// Answered by service.result, with the same id (not a subscription's)
export interface ServiceAction {
  type: 'service.action';
  id: number;
  unit: string;
  scope: ServiceScope;
  verb: ServiceVerb;
}

// A service's journal: its latest lines, then the new ones
export interface LogsSubscribe {
  type: 'logs.subscribe';
  id: number;
  unit: string;
  scope: ServiceScope;
}

export interface Unsubscribe {
  type: 'unsubscribe';
  id: number;
}

// The client is ready for the next frame of the subscription: the server sends
// one frame at a time, so a slow network or browser drops frames, not latency.
export interface FrameAck {
  type: 'frame.ack';
  id: number;
}

// A 2D pose: a goal (geometry_msgs/PoseStamped) or a pose estimate
// (geometry_msgs/PoseWithCovarianceStamped, with the covariance of RViz's tool)
export interface PosePublish {
  type: 'pose';
  topic: string;
  covariance: boolean;
  frameId: string;
  x: number;
  y: number;
  yaw: number;
}

// Runs the command of a button widget, as the server has it saved in the panel
export interface CommandRun {
  type: 'command.run';
  panelId: string;
  widgetId: string;
}

export interface CommandStop {
  type: 'command.stop';
  panelId: string;
  widgetId: string;
}

// The arm of an arm teleop widget: the joints of its trajectory controllers
// (ros2_control JointTrajectoryControllers, by name), where they are and how
// far they may go, sent as arm updates whenever that changes (at most
// ARM_STATE_RATE a second). Also what its jog streams move.
export interface ArmSubscribe {
  type: 'arm.subscribe';
  id: number;
  controllers: string[];
  jointStatesTopic: string;
  descriptionTopic: string;
  // The hardware interface's calibration state (std_msgs/String, JSON), if
  // any: limits lifted while calibrating, the joints not located
  calibrationTopic: string;
}

// Where to move the end effector in Cartesian jogs: its link, solved for by
// move_group's IK (/compute_ik) for the planning group, along the axes of
// frameId
export interface ArmIk {
  group: string;
  link: string;
  frameId: string;
}

// Jog of the arm subscription id: joint speeds (rad/s, m/s for prismatic
// joints, by joint name) and the end effector's speed (m/s, along ik.frameId).
// Sent at the widget's rate while held, then once all zero; the server
// streams the controllers positions just ahead of the arm, and holds it when
// the jog ends, or stops for TELEOP_WATCHDOG_MS without its final zero.
export interface ArmJog {
  type: 'arm.jog';
  id: number;
  joints: Record<string, number>;
  cartesian: { x: number; y: number; z: number };
  ik: ArmIk;
}

// Publishes a message on a topic, creating the publisher on first use. The
// message is JSON, as rclnodejs takes it: fields by name, missing ones zero.
export interface RosPublish {
  type: 'ros.publish';
  topic: string;
  // e.g. std_msgs/msg/String
  messageType: string;
  message: unknown;
}

// Calls a ROS service; answered by a result with the same id (not a
// subscription's), whose value is the response
export interface RosCall {
  type: 'ros.call';
  id: number;
  service: string;
  // e.g. std_srvs/srv/SetBool
  serviceType: string;
  request: unknown;
  // How long to wait for the service to exist, then for its response
  timeoutMs: number;
}

// A request to a plugin's server side (PluginContext.handle), answered by a
// result with the same id
export interface PluginRequest {
  type: 'plugin.request';
  id: number;
  plugin: string;
  method: string;
  params: unknown;
}

// A stream of a plugin's server side (PluginContext.stream): its data comes as
// plugin.data, its failure as stream.status, until unsubscribed
export interface PluginSubscribe {
  type: 'plugin.subscribe';
  id: number;
  plugin: string;
  stream: string;
  params: unknown;
}

// A behavior tree's log (nav2_msgs/msg/BehaviorTreeLog, which Nav2's
// bt_navigator publishes on /behavior_tree_log): the tree's nodes as bt.tree,
// then their states and transitions as bt updates, at most BT_RATE a second.
// The server follows the log for every page at once, and for a while after
// the last one: a page opened later sees the nodes as they are. Its status
// comes as stream.status.
export interface BehaviorTreeSubscribe {
  type: 'bt.subscribe';
  id: number;
  topic: string;
  // The XML of the tree the robot runs, to show it whole: a robot path (/…,
  // ~/…), package://<package>/<path> or uploads/<name>. Empty: the nodes are
  // those of the log, as they first change.
  tree: string;
}

// Records a behavior tree's log into a rosbag (ros2 bag record into the new
// folder path), or stops recording it (path null): answered by a result, the
// bag's folder. Every page following the topic is told (bt.recording).
export interface BehaviorTreeRecord {
  type: 'bt.record';
  id: number;
  topic: string;
  path: string | null;
}

// A rosbag of a behavior tree's log, played back for this page: as a bt
// subscription, its tree and its nodes' states (on the bag's clock), and
// where the playback is (bt.playback.state). It starts playing.
export interface BehaviorTreePlaybackSubscribe {
  type: 'bt.playback';
  id: number;
  // A bag's folder, or one of its files (.mcap, .db3): /…, ~/…
  bag: string;
  // The log's topic, if the bag has several
  topic: string;
  tree: string;
}

// Controls the playback subscription id: any of its fields
export interface BehaviorTreePlaybackControl {
  type: 'bt.playback.control';
  id: number;
  playing?: boolean;
  // 1: as recorded
  speed?: number;
  // Seeks: on the bag's clock (ms since the epoch)
  time?: number;
}

export type ClientMessage =
  | TwistCommand
  | ImageSubscribe
  | GridSubscribe
  | TfSubscribe
  | PathSubscribe
  | TopicSubscribe
  | ServicesSubscribe
  | ServiceAction
  | LogsSubscribe
  | Unsubscribe
  | FrameAck
  | PosePublish
  | CommandRun
  | CommandStop
  | ArmSubscribe
  | ArmJog
  | RosPublish
  | RosCall
  | PluginRequest
  | PluginSubscribe
  | BehaviorTreeSubscribe
  | BehaviorTreeRecord
  | BehaviorTreePlaybackSubscribe
  | BehaviorTreePlaybackControl;

// ── Server → client ──────────────────────────────────────────────────────────

export interface Hello {
  type: 'hello';
  // Sent back in the X-Dashboard-Client header of the REST requests, so that
  // the client can tell its own panel changes from others'
  clientId: string;
  hostname: string;
  // The server's clock (ms since the epoch), against which the page measures
  // the times the server reports: the robot's and the browser's clocks differ
  time: number;
}

// The last run of a button widget's command, running or finished
export interface CommandState {
  panelId: string;
  widgetId: string;
  running: boolean;
  // Milliseconds since the epoch
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  // Why the command could not run
  error: string | null;
  // The tail of its standard output and error
  output: string;
}

// Every command state the server knows, sent on connection
export interface CommandStates {
  type: 'commands';
  states: CommandState[];
}

export interface CommandUpdate {
  type: 'command';
  state: CommandState;
}

// Of an image or grid subscription
export interface StreamStatus {
  type: 'stream.status';
  id: number;
  state: 'waiting' | 'streaming' | 'error';
  message: string;
}

export interface Transform2D {
  x: number;
  y: number;
  yaw: number;
}

export interface TfUpdate {
  type: 'tf';
  id: number;
  // null when it cannot be computed, see error
  transform: Transform2D | null;
  error: string | null;
  // Since the oldest of the dynamic transforms it is made of arrived, in ms
  ageMs: number;
}

export interface PanelsChanged {
  type: 'panels.changed';
  id: string;
  deleted: boolean;
  // clientId of the change's author, null if unknown
  origin: string | null;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface PathUpdate {
  type: 'path';
  id: number;
  frameId: string;
  // x0, y0, x1, y1, ... in frameId
  points: number[];
}

export interface TopicMessage {
  type: 'message';
  id: number;
  // e.g. std_msgs/msg/String
  messageType: string;
  // Numeric arrays as arrays, 64 bit integers as numbers
  message: unknown;
}

export interface ArmJointState {
  name: string;
  // The trajectory controller driving it
  controller: string;
  // rad (m for prismatic joints), null until known
  position: number | null;
  // Where it may go now: its limits, lifted while calibrating; null if none
  lower: number | null;
  upper: number | null;
  // Not located by the hardware: its position is only relative
  located: boolean;
  // The hardware moves it: not if it is not located, but while calibrating
  drivable: boolean;
}

export interface ArmUpdate {
  type: 'arm';
  id: number;
  joints: ArmJointState[];
  // The hardware interface is calibrating the arm
  calibrating: boolean;
  // What keeps some of the arm from being driven, e.g. a controller not found
  problems: string[];
  // The page's jog: blocked says why the arm does not go where asked
  jog: { state: 'idle' | 'moving' | 'blocked'; message: string };
}

// As systemctl show reports it
export interface ServiceInfo {
  unit: string;
  scope: ServiceScope;
  description: string;
  // loaded, not-found, ...
  load: string;
  // active, inactive, failed, activating, deactivating, ...
  active: string;
  // running, exited, dead, ...
  sub: string;
  // Why it last stopped: success, exit-code, signal, timeout, ...
  result: string;
  // enabled (starts at boot), disabled, linked, static, ...
  enabled: string;
  // When it entered its state, ms since the epoch on the server's clock
  since: number | null;
  // The dashboard's own service: stopping it stops the page's server
  self: boolean;
}

export interface ServicesUpdate {
  type: 'services';
  id: number;
  services: ServiceInfo[];
  // Listing them failed, e.g. no service manager reachable
  error: string | null;
}

export interface ServiceResult {
  type: 'service.result';
  id: number;
  error: string | null;
}

export interface LogsUpdate {
  type: 'logs';
  id: number;
  text: string;
  // text replaces the lines shown so far, instead of following them
  reset: boolean;
}

// The answer to a request (ros.call, plugin.request)
export type Result =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string };

export interface PluginData {
  type: 'plugin.data';
  id: number;
  data: unknown;
}

export type BtNodeKind = 'action' | 'condition' | 'control' | 'decorator' | 'subtree';

// A node of a behavior tree, as BT.CPP makes it from the XML
export interface BtNode {
  // As the log names it: its name attribute, or its type
  name: string;
  // Its registration ID: the XML tag, the ID of <Action ID="…"> and the like,
  // SubTree for subtrees (whose ID is a port)
  type: string;
  // null if unknown: the nodes of the log that are not in the tree file
  kind: BtNodeKind | null;
  // Its parent's index, -1 for the tree's root and the nodes not in the tree
  parent: number;
  // Its other attributes: its parameters and blackboard entries
  ports: Record<string, string>;
}

// The tree of a bt subscription, again whenever its file changes: the states
// and transitions known so far follow, as a reset update
export interface BehaviorTreeInfo {
  type: 'bt.tree';
  id: number;
  // The BehaviorTree shown: the file's main tree; '' without a file
  treeId: string;
  // In BT.CPP's order (that of their UIDs): depth first, each subtree
  // expanded where it is used
  nodes: BtNode[];
  // Why the tree file could not be read: the nodes are then the log's
  error: string | null;
  // What may be wrong with it: an include not found, a subtree not defined
  warnings: string[];
}

export interface BtNodeState {
  node: number;
  // IDLE, RUNNING, SUCCESS, FAILURE or SKIPPED, as the log says; null until
  // a transition of the node, or of one below it, is seen
  status: string | null;
  // Its last SUCCESS or FAILURE: parents reset their children to IDLE once
  // they are done with them, at once
  result: string | null;
  // When it last changed, on the server's clock; 0 if not seen changing
  since: number;
  // Transitions seen, of all kinds, then to SUCCESS and to FAILURE
  changes: number;
  successes: number;
  failures: number;
}

export interface BtTransition {
  // The robot's (ms since the epoch)
  time: number;
  node: number;
  from: string;
  to: string;
}

// Of a bt subscription: its topic's recording, if any, on connection and
// whenever it starts or stops
export interface BehaviorTreeRecording {
  type: 'bt.recording';
  id: number;
  // Its folder, and when it started on the server's clock
  recording: { path: string; since: number } | null;
}

// Of a bt.playback subscription, whenever it changes, and a few times a
// second while playing
export interface BehaviorTreePlaybackState {
  type: 'bt.playback.state';
  id: number;
  // The bag's topic played, '' until read
  topic: string;
  // The bag's clock (ms since the epoch): when its log starts and ends, and
  // where the playback is
  start: number;
  end: number;
  time: number;
  playing: boolean;
  speed: number;
  // Why the bag cannot be played
  error: string | null;
}

export interface BehaviorTreeUpdate {
  type: 'bt';
  id: number;
  // The states of all the nodes known, and the latest transitions: they
  // replace what came before
  reset: boolean;
  // Nodes of the log not in the tree (all of them without a tree file),
  // after the nodes known so far
  added: BtNode[];
  // Of the nodes that changed
  states: BtNodeState[];
  transitions: BtTransition[];
  // Why the log does not seem to be of the tree shown, null if it does
  mismatch: string | null;
}

export type ServerMessage =
  | Hello
  | CommandStates
  | CommandUpdate
  | StreamStatus
  | TfUpdate
  | PathUpdate
  | TopicMessage
  | ServicesUpdate
  | ServiceResult
  | LogsUpdate
  | ArmUpdate
  | Result
  | PluginData
  | BehaviorTreeInfo
  | BehaviorTreeUpdate
  | BehaviorTreeRecording
  | BehaviorTreePlaybackState
  | PanelsChanged
  | ErrorMessage;

// ── Binary frames ────────────────────────────────────────────────────────────
// Header, big endian, then metadata (JSON, metadata size bytes), then the image
// file (JPEG or PNG):
//   u32 subscription id | u8 format | u16 source width | u16 source height | u16 metadata size
// The source size is that of the ROS image or grid, before any scaling; 0 if
// unknown. Grid frames carry their GridInfo as metadata, image frames none.

export const FRAME_HEADER_BYTES = 11;
export const IMAGE_FORMATS = ['image/jpeg', 'image/png'] as const;

// Where a grid lies: its cells, in frameId, from its origin (the corner of cell
// 0, the first of the image's rows, which go along +y)
export interface GridInfo {
  frameId: string;
  width: number;
  height: number;
  // Meters per cell
  resolution: number;
  originX: number;
  originY: number;
  originYaw: number;
  // The cells that are not unknown, which the view fits; null if none
  known: { x: number; y: number; width: number; height: number } | null;
}

export const TELEOP_WATCHDOG_MS = 500;
export const ARM_STATE_RATE = 10;
export const BT_RATE = 10;
export const DASHBOARD_CLIENT_HEADER = 'X-Dashboard-Client';

// A plugin, as GET /api/plugins lists them
export interface PluginInfo {
  // Its package name: what its widgets' requests and streams address
  name: string;
  version: string;
  description: string;
  // The URL of its client module, which the page imports, if it has one
  client: string | null;
  // The URLs of its stylesheets
  styles: string[];
  // Why its server side did not start, if it did not
  error: string | null;
}
