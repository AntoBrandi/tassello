// Messages exchanged over the dashboard's WebSocket (/ws). Text frames carry
// one JSON message each; binary frames, from the server only, carry the frames
// of image and grid streams.
//
// Subscriptions (image, grid, tf, path, topic, services, logs, ...) are
// numbered by the client, in one sequence per connection, and ended with
// `unsubscribe`.

import type { BtNodeModel } from './bt_nodes.ts';
import type {
  ActionGoal,
  GraphSnapshot,
  PublishQos,
  PublishState,
  TopicDetails,
  TopicEcho,
  TopicStats,
} from './monitor.ts';
import type { NetworkRequest, NetworkState } from './networking.ts';

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
  // The request is made from the service's definition: 64 bit integers from
  // numbers or text, "now" for a builtin_interfaces/msg/Time, "auto" for a
  // std_msgs/msg/Header, and a field it has not is refused; the response
  // comes as monitored messages do (TruncatedValue... in monitor.ts)
  checked?: boolean;
}

// The ROS graph: its topics, services, actions and nodes (GraphSnapshot), as
// graph updates, again whenever it changes
export interface GraphSubscribe {
  type: 'graph.subscribe';
  id: number;
}

// A topic's publishers and subscriptions, with their QoS (TopicDetails), as
// topic.info updates, again whenever they change
export interface TopicInfoSubscribe {
  type: 'topic.info.subscribe';
  id: number;
  topic: string;
}

// A topic's figures (ros2 topic hz, bw and delay, over the latest window
// messages) as topic.stats updates, twice a second while messages come, and
// its messages (ros2 topic echo), at most ECHO_RATE a second, as topic.echo
// updates. Its status comes as stream.status.
export interface TopicMonitorSubscribe {
  type: 'topic.monitor';
  id: number;
  topic: string;
  window: number;
  // Of the messages: their field at this path (all of them: ''), lists and
  // strings cut to truncate items; null: not echoed
  echo: { field: string; truncate: number } | null;
}

// Publishes on a topic (ros2 topic pub): message is made from the type's
// definition as a checked RosCall's request is, again for each message.
// Once (rate 0), times times, or until unsubscribed (times 0), at rate a
// second; how many are published comes as topic.published updates.
export interface TopicPublish {
  type: 'topic.publish';
  id: number;
  topic: string;
  messageType: string;
  message: unknown;
  rate: number;
  times: number;
  qos: PublishQos;
}

// An interface's definition, schemas and default values (InterfaceInfo):
// answered by a result with the same id
export interface InterfaceGet {
  type: 'interface.get';
  id: number;
  // pkg/msg/Name, pkg/srv/Name, pkg/action/Name
  interfaceType: string;
}

// What an action's servers are doing: their goals, whoever sent them, as
// action.goals updates. Its status comes as stream.status.
export interface ActionSubscribe {
  type: 'action.subscribe';
  id: number;
  action: string;
  actionType: string;
}

// Sends a goal (ros2 action send_goal), made as a checked RosCall's request
// is: answered by a result with the same id, the goal's UUID once accepted.
// Its feedback and result come to the action's subscriptions.
export interface ActionSend {
  type: 'action.send';
  id: number;
  action: string;
  actionType: string;
  goal: unknown;
}

// Cancels a goal, by its UUID, or all of the action's (null): answered by a
// result with the same id (CancelResult)
export interface ActionCancel {
  type: 'action.cancel';
  id: number;
  action: string;
  actionType: string;
  goal: string | null;
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

// A behavior tree's XML file, for the editor: its text as bt.file, again
// whenever it changes, and the nodes known (bt.models): those of Nav2, of
// the file's includes, and of the libraries (XML files of TreeNodesModel)
export interface BehaviorTreeFileSubscribe {
  type: 'bt.file.subscribe';
  id: number;
  // A robot path (/…, ~/…), package://<package>/<path> or uploads/<name>
  path: string;
  libraries: string[];
}

// Saves a behavior tree's XML file: answered by a result, a
// BehaviorTreeSaved. Only over a behavior tree (whose root is <root>), and
// only if it is still the version base (null: whatever it is now); create:
// only a new file. Uploads are not saved.
export interface BehaviorTreeFileSave {
  type: 'bt.file.save';
  id: number;
  path: string;
  text: string;
  base: string | null;
  create: boolean;
}

// The ROS log: the rcl_interfaces/msg/Log every node's logger publishes on
// /rosout. The messages the server keeps (the latest ROSOUT_HISTORY), then the
// new ones, at most ROSOUT_RATE times a second, and the nodes of the ROS graph
// whenever they change, as rosout updates. The server follows the log for
// every page at once, and for a while after the last one: a page opened later
// sees what was logged before. Its status comes as stream.status.
export interface RosoutSubscribe {
  type: 'rosout.subscribe';
  id: number;
  topic: string;
}

// The robot's diagnostics: the diagnostic_msgs/msg/DiagnosticArray of a topic,
// /diagnostics (every node's diagnostic_updater) or /diagnostics_agg (the
// aggregator's tree). The statuses the server keeps, the latest of each name,
// and their latest changes of level (DIAGNOSTICS_CHANGES), then those that
// changed, at most DIAGNOSTICS_RATE times a second, as diagnostics updates.
// The server follows the topic for every page at once, and for a while after
// the last one. Its status comes as stream.status.
export interface DiagnosticsSubscribe {
  type: 'diagnostics.subscribe';
  id: number;
  topic: string;
}

// A terminal on the robot: the user's login shell, or a command, on a
// pseudo-terminal, as the server's user. It outlives the page: the page opens
// it again by its name after a reload or a reconnection, and gets what it
// missed (TerminalOutput); the server hangs it up once no page has shown it
// for an hour. Only the dashboard's own pages open terminals.
export interface TerminalOpen {
  type: 'terminal.open';
  id: number;
  // Chosen by the page, for as long as the browser's tab lives
  terminal: string;
  // Run by the login shell; empty: the shell itself
  command: string;
  // Where it starts: /…, ~/…, package://<package>/…
  folder: string;
  cols: number;
  rows: number;
  // The output the page shows: its program's start (TerminalOutput.started)
  // and how far it goes; null if it shows none
  started: number | null;
  offset: number | null;
}

// Typed, pasted: written to the terminal as is
export interface TerminalInput {
  type: 'terminal.input';
  id: number;
  data: string;
}

// Of the terminal the page shows: the last page to say so sets the size
export interface TerminalResize {
  type: 'terminal.resize';
  id: number;
  cols: number;
  rows: number;
}

// The page has written the output up to offset: the server sends a page at
// most TERMINAL_WINDOW characters ahead of it, and those that fall too far
// behind get the screen instead of what they missed
export interface TerminalAck {
  type: 'terminal.ack';
  id: number;
  // Of the program's output (TerminalOutput.started): not another's
  started: number;
  offset: number;
}

// Hangs up the program if it runs, and starts it again
export interface TerminalRestart {
  type: 'terminal.restart';
  id: number;
}

// The robot's networks, as NetworkManager has them: its interfaces, the
// connections saved, the Wi-Fi networks in range and what the pages are
// having done to them, whenever that changes (network updates). The server
// follows them for every page at once.
export interface NetworkSubscribe {
  type: 'network.subscribe';
  id: number;
}

// Changes the robot's networks (nmcli): answered by a result with the same
// id once NetworkManager is done, e.g. a connection activated, or why not
// (NetworkResult, or NetworkSecrets). The dashboard's own pages only.
export interface NetworkAction {
  type: 'network.action';
  id: number;
  request: NetworkRequest;
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
  | BehaviorTreePlaybackControl
  | BehaviorTreeFileSubscribe
  | BehaviorTreeFileSave
  | RosoutSubscribe
  | DiagnosticsSubscribe
  | TerminalOpen
  | TerminalInput
  | TerminalResize
  | TerminalAck
  | TerminalRestart
  | NetworkSubscribe
  | NetworkAction
  | GraphSubscribe
  | TopicInfoSubscribe
  | TopicMonitorSubscribe
  | TopicPublish
  | InterfaceGet
  | ActionSubscribe
  | ActionSend
  | ActionCancel;

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

// Of a bt.file subscription
export interface BehaviorTreeFile {
  type: 'bt.file';
  id: number;
  // The file read: its absolute path
  file: string;
  // null if it could not be read, see error
  text: string | null;
  // Of its content: what a save names as its base
  version: string | null;
  // Why it cannot be saved: an upload, a file the server cannot write
  readOnly: string | null;
  error: string | null;
}

// Nodes of BT.CPP's trees, from a file of TreeNodesModel
export interface BtNodeLibrary {
  // Nav2, or the file's name
  name: string;
  // Its file
  file: string;
  models: BtNodeModel[];
}

// Of a bt.file subscription: whenever the file's includes or the libraries change
export interface BehaviorTreeModels {
  type: 'bt.models';
  id: number;
  libraries: BtNodeLibrary[];
  // The BehaviorTrees of the file's includes, which its SubTrees may name
  trees: { id: string; file: string }[];
  // Libraries and includes that could not be read
  warnings: string[];
}

// The result of a bt.file.save
export interface BehaviorTreeSaved {
  // The file's version: the one saved, or (conflict) the one found
  version: string;
  // Not saved: the file changed since the base
  conflict: boolean;
}

// A message of the ROS log (rcl_interfaces/msg/Log)
export interface LogEntry {
  // Numbered by the server as they come, from 1: what the page knows them by
  seq: number;
  // On the clock of its node (ms since the epoch; since the simulation's
  // start on sim time)
  stamp: number;
  // DEBUG 10, INFO 20, WARN 30, ERROR 40, FATAL 50
  level: number;
  // Its logger: the node's name after its namespace, dots for slashes
  // (robot1.amcl for /robot1/amcl), then its child loggers' (robot1.amcl.x)
  name: string;
  msg: string;
  // Where it was logged
  file: string;
  function: string;
  line: number;
}

// Of a rosout subscription
export interface RosoutUpdate {
  type: 'rosout';
  id: number;
  // entries are the messages the server keeps, which replace those of before,
  // instead of following them
  reset: boolean;
  // When the server started keeping this log, on its clock: another one
  // numbers its messages from 1 again
  started: number;
  // Oldest first
  entries: LogEntry[];
  // Messages left out before entries: too many came at once
  skipped: number;
  // The nodes of the ROS graph (/robot1/amcl), with every reset and when they
  // change; null: as before. Hidden nodes (_name) are left out.
  nodes: string[] | null;
}

// A status of the robot's diagnostics (diagnostic_msgs/msg/DiagnosticStatus):
// the latest of its name
export interface DiagnosticEntry {
  // Numbered by the server as they first come, from 1: what the changes refer
  // to them by
  id: number;
  // A path of the aggregator's (/Robot/Sensors/Lidar), or as diagnostic_updater
  // names them: its node, then its task (amcl: Localization)
  name: string;
  // OK 0, WARN 1, ERROR 2, STALE 3, as published
  level: number;
  message: string;
  hardwareId: string;
  values: { key: string; value: string }[];
  // Not received for a while: what published it stopped
  stale: boolean;
  // On the server's clock: when it was last received (as of when it was last
  // sent: unchanged, it is not sent again), and since when it is at its level,
  // STALE if stale
  updated: number;
  since: number;
}

// A status went to another level: STALE if it went stale
export interface DiagnosticChange {
  // Numbered by the server as they come, from 1
  seq: number;
  // On the server's clock
  time: number;
  // Of the status (DiagnosticEntry.id)
  status: number;
  level: number;
  message: string;
}

// Of a diagnostics subscription
export interface DiagnosticsUpdate {
  type: 'diagnostics';
  id: number;
  // statuses and changes are all those the server keeps, which replace those
  // of before, instead of following them
  reset: boolean;
  // When the server started following the topic, on its clock: another one
  // numbers its statuses and changes from 1 again
  started: number;
  // New or changed since the last update
  statuses: DiagnosticEntry[];
  // Oldest first
  changes: DiagnosticChange[];
}

// Of a terminal subscription: its program's output, as it comes. The status
// of the subscription comes as stream.status: its error if the terminal could
// not be opened.
export interface TerminalOutput {
  type: 'terminal.output';
  id: number;
  // When the program started, on the server's clock: output of another
  // program than the one the page shows (restarted, or the server was)
  // follows what it shows, from offset 0
  started: number;
  // In characters (UTF-16 code units) of the program's output, after data
  offset: number;
  // data is the screen and its scrollback (TERMINAL_SCROLLBACK lines),
  // which replace what the page shows, instead of following it
  reset: boolean;
  data: string;
  // The window's title the program set, with every reset; null: as before
  title: string | null;
}

// Of a terminal subscription: its program ended, after the last of its
// output. Sent again to the pages opening it, until restarted.
export interface TerminalExit {
  type: 'terminal.exit';
  id: number;
  started: number;
  // 128 + the signal's number if killed by one; null if hung up
  exitCode: number | null;
}

// Of a network subscription
export interface NetworkUpdate extends NetworkState {
  type: 'network';
  id: number;
  // The interface this page reaches the robot through; null if not known,
  // e.g. through a reverse proxy, or from the robot itself
  via: string | null;
  // The page may change the networks: one of the dashboard's own
  canChange: boolean;
}

// Of a graph subscription
export interface GraphUpdate {
  type: 'graph';
  id: number;
  graph: GraphSnapshot;
}

// Of a topic.info subscription
export interface TopicInfoUpdate extends TopicDetails {
  type: 'topic.info';
  id: number;
}

// Of a topic.monitor subscription
export interface TopicStatsUpdate {
  type: 'topic.stats';
  id: number;
  stats: TopicStats;
}

export interface TopicEchoUpdate extends TopicEcho {
  type: 'topic.echo';
  id: number;
}

// Of a topic.publish subscription
export interface TopicPublished extends PublishState {
  type: 'topic.published';
  id: number;
}

// Of an action subscription: its goals, the latest accepted first
export interface ActionGoals {
  type: 'action.goals';
  id: number;
  goals: ActionGoal[];
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
  | BehaviorTreeFile
  | BehaviorTreeModels
  | RosoutUpdate
  | DiagnosticsUpdate
  | TerminalOutput
  | TerminalExit
  | NetworkUpdate
  | GraphUpdate
  | TopicInfoUpdate
  | TopicStatsUpdate
  | TopicEchoUpdate
  | TopicPublished
  | ActionGoals
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
export const ROSOUT_RATE = 10;
// Messages of the ROS log kept by the server, and by the page
export const ROSOUT_HISTORY = 10_000;
// Diagnostics come about once a second
export const DIAGNOSTICS_RATE = 4;
// Changes of level kept by the server, and by the page
export const DIAGNOSTICS_CHANGES = 1000;
// Lines of a terminal kept above its screen, by the server and by the page
export const TERMINAL_SCROLLBACK = 2000;
// Characters of a terminal's output sent to a page and not yet written by it
export const TERMINAL_WINDOW = 256 * 1024;
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
