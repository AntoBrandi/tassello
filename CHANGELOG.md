# Changelog

Tassello follows [semantic versioning](https://semver.org): before 1.0, a new minor version may
change the plugin API (`tassello/sdk`, `tassello/viewer`, `tassello/server`, `tassello/vite`), as
noted here.

## Unreleased

- Robot Viewer widget, in place of the Robot Model: the robot in 3D, or from above in 2D (the
  toolbar's **3D** and **2D**), as RViz shows it, made of *displays* drawn in a fixed frame,
  chosen in the toolbar from the TF frames (**Auto**: the robot model's root link, as the Robot
  Model showed the robot, else the root of the TF tree). Its first displays: **Robot Model** (the
  Robot Model widget's robot, its moving joints highlighted with their arrows, placed by TF),
  **TF** (the frames' axes and names, as its frames were shown, all of TF's, filtered by name,
  optionally with lines to their parents), **Occupancy Grid** (a map or a costmap on the ground of
  its frame, kept up to date by its `_updates`), **Laser Scan** and **Point Cloud** (their points,
  one colour or by intensity, height or their own `rgb`, at a size in pixels). The displays are
  listed in the side panel in the order they are drawn: each shown or hidden, renamed, moved,
  removed, opened to edit its properties; others added from Tassello's and the plugins'. What a
  display waits for or cannot show (no TF to the fixed frame, a topic of another type) is said in
  the middle while nothing is shown, else in a note; a display that fails says so, the others carry
  on. It keeps the Robot Model's type: saved panels open their robot models as viewers of the robot
  model and, if its frames were shown, of TF. In 2D, drag to pan and scroll to zoom.
- Laser scans and point clouds for the viewer are thinned on the robot (evenly, to at most the
  points asked for), quantized to 16 bits about their centre (6 bytes a point, 7 with an
  intensity, 9 with a colour) and placed by TF as each message arrives, then sent one at a time
  as the cameras' images are: a new `points.subscribe` stream of binary frames (format 2,
  `POINTS_FORMAT`, `PointsInfo` metadata, see `src/shared/points.ts`). A new `tf.frames`
  subscription sends every TF frame, its parent and its 3D pose in a fixed frame, 15 times a
  second for a viewer.
- Plugins: displays of their own for the Robot Viewer, as RViz's display plugins:
  `displays: [defineDisplay({ type, name, description, icon, properties, load })]`, `load`
  importing a class that extends `Display` of the new `tassello/viewer` (with three.js, fetched
  only when a viewer shows the display): `configure(config, previous)`, `onTransforms()`,
  `onFixedFrameChange()`, `focus()`, `dispose()`, and `pose`, `place`, `attach`,
  `subscribeTopic`, `setStatus`, `setNotes`. `three` and `tassello/viewer` are the page's, through
  its import map, as React and `tassello/sdk` are, and kept external by `tassello/vite`;
  Tassello's displays and `PointsLayer` are in `tassello/viewer`, to extend. Display types are
  unique across widgets and status widgets, and `defaults` apply to them
  (`'robot-model-display'`, `'tf-display'`, `'grid-display'`, `'laser-scan-display'`,
  `'point-cloud-display'`). `connection.subscribeTfFrames`, `connection.subscribePoints` and
  `useTfFrames`; a `displays` property kind; widgets' `migrate(stored)`, upgrading a config
  saved by an earlier version. **Changed**: the `robot-model` widget's properties are now
  `fixedFrame`, `view` and `displays`: defaults of its former `descriptionTopic`,
  `jointStatesTopic` and `highlightMotion` go to `'robot-model-display'`, of `showFrames` to the
  `tf` display's `enabled` in `displays`.

- Status bars: each panel has its own, above its board, of readings at a glance. Its first
  status widgets: **Wi-Fi**, the network the robot is on and its signal, as NetworkManager has
  them (yellow when weak, red when too weak or disconnected, thresholds of its own; the robot's
  own access point shown as such; which interface, with several); **CPU**, the load of all the
  cores or of the busiest, against its thresholds, with a chart of the last minute. It is one row
  of 24 columns stretched to the window's width: what is at its right end stays there on any
  screen, and a status widget shows what fits its width (the icon or the value, both, a label, a
  chart). In edit mode, as on the board, **＋ Status** adds one (after the one selected, else in
  the first free place); they are dragged to move them and by their corner to resize them, a move
  or resize onto another being refused; selected to edit their properties in the side panel,
  removed with their × or Delete, moved a column at a time with the arrow keys; every change is
  saved, followed by the other pages, and undone with Ctrl+Z as the panel's are. Hidden in view
  mode while empty. It is part of the panel's file (`statusBar`: each status widget's `id`,
  `type`, `x` and `w` in columns, `config`), so exported, imported and duplicated with it; the
  example panels have the Wi-Fi and the CPU.
- Plugins: status widgets of their own, `statusWidgets: [defineStatusWidget({ ... })]`, made as
  widgets are, with a width in the bar's columns (`defaultWidth`, `minWidth`, `STATUS_COLUMNS`);
  `StatusReadout` lays out an icon, a value, a label and a chart as Tassello's do, keeping what
  fits the width. Their types and widgets' are unique across both; `defaults` apply to either.
  `subscribeNetwork(callback, { scan: false })` follows the networks without looking for those
  in range (`network.subscribe`'s `scan`).

- Edit mode on tablets and phones: widgets are moved and resized by touch again. Pressing a
  widget selects it when the press ends, not as it begins: the properties it opened moved the
  board from under the finger (a tablet's cells shrank to make room for the side panel, a
  phone's board was covered by the sheet). The sheet steps aside while a widget is dragged, the
  resize corner is larger on touch screens, and on iOS a long press no longer selects text or
  opens a callout, losing the drag.
- Speedometer widget: the robot's speed on a dial, from its velocity commands (`Twist` or
  `TwistStamped`, e.g. `cmd_vel`, told apart by their type): the speed of the linear velocity
  (x, and y for omnidirectional robots), with a minus going backwards, on a scale from 0 to its
  max speed, at round steps (faster commands pegged at the end, in red), and the angular
  velocity under it. A command not renewed within its timeout (0.5 s, as base controllers'
  `cmd_vel_timeout`) shows as a stop: the latest may be the last of a publisher gone.
- Edit mode selects several widgets: Ctrl+click (⌘, Shift) adds one, or takes a selected one
  out; a band dragged across the board from an empty place selects those it touches (with Ctrl
  or Shift, added to those selected). Dragging any of them moves them together, refused as a
  whole if one would land on another widget; the arrow keys move them too, Delete removes them,
  Esc unselects them, each a single change that Ctrl+Z undoes. The side panel shows a widget's
  properties when it is the only one selected.
- Web Page widget: another web page in the panel, e.g. a server's interface (the robot's router,
  a camera's, Grafana, Foxglove). Its address may be a port alone (`:8081/`), on the host the
  dashboard was opened by, so that a panel works from any network. An address bar with the
  address, Reload and Open in a new tab (hidden if not wanted), and a zoom from 25 to 200 %. Only
  `http(s)` pages; not the dashboard itself, nor `http://` pages in a dashboard served over HTTPS
  (browsers block them), which are offered in a new tab instead.
- Panels are exported (**⋯ → Export panel**) as their JSON file, named after the panel (its
  latest name, if renamed), with their desktop, tablet and phone layouts, and imported from
  such files (**⋯ → Import panel…**, or from the page without panels), several at once: each a new panel, named as in its file, with
  “(2)” after it if the name is taken. The file is the same as in the panels directory, so
  either can be imported or copied there.
- Duplicating a panel keeps its tablet and phone layouts; the copy had the desktop's only.
- Plot widget: numbers of any topic over time, as rqt_plot and PlotJuggler plot them
  (`/odom.twist.twist.linear.x`, a battery's voltage, joints' efforts), up to 8 series on a
  chart, from every message. Live over the latest *time shown*; paused, zoomed (drag across it,
  the wheel, a pinch) and scrolled through time (Shift+wheel, a swipe, the arrow keys); the value
  axis fitted to what is shown or fixed; the values at the pointer; series hidden from the
  legend. What is shown exported as CSV, a row a message. The series are picked in the widget,
  from the topics of the graph and the numeric fields of their latest message (a `JointState`'s
  named by joint), and saved with the panel, or listed in its properties.
- The topic monitor (`topic.monitor`) samples: the numbers of every message at some fields, sent
  ten times a second (`TopicSamples`). Plugins: `subscribeTopicMonitor`'s `samples`; its `stats`
  and `echo` handlers are optional.
- Plugins: widgets get `updateConfig`, which changes their properties and saves the panel, as the
  side panel does.
- System Monitor widget: the robot's computer, every second. The CPU's load, of each core (those
  offline too), their frequencies and the load average; the memory, its cache and the swap; the
  temperatures of the thermal zones and hwmon chips, by chip with their hottest, against their
  own limits; the fans; a Raspberry Pi's throttling (under-voltage, frequency capped, throttled,
  soft temperature limit, now and since boot); the GPUs: a Jetson's (devfreq), NVIDIA's
  (`nvidia-smi`), AMD's (amdgpu); the power rails: a Jetson's INA3221 (L4T 32's too), hwmon's
  power sensors, Intel's RAPL when readable; the disks' traffic and busy time, and the file
  systems' space; the networks' traffic, of the device's own interfaces or those chosen. Charts
  of the last 5 minutes, kept by the server, with the values at the pointer (or the arrow keys).
  The board, its OS, uptime, and a Jetson's L4T release and power mode.
- Plugins: `connection.subscribeSystem`, and the types of `src/shared/system.ts`.
- Rosbags widget: the robot's rosbags, as `ros2 bag` makes and reads them. A folder's bags, the
  newest first, with their time span, size, storage and compression, and each topic's type,
  count and rate, from their `metadata.yaml` (Humble's and Jazzy's), else from their files (a
  recording killed: MCAP's summary, SQLite's tables). Downloaded (folders as `.tar.gz`), deleted
  (bags only, from the dashboard's own pages), or played on the robot's topics with
  `ros2 bag play`: paused, sought, sped up, looped, from an offset, some topics only, `/clock`
  published. New ones recorded with `ros2 bag record`: topics chosen from the graph, all of them,
  or matching a regular expression, but those matching another; with its advanced options, the
  storage (MCAP, SQLite) and its preset, a new file by size or duration, the compression of each
  file or message and its format, the cache, hidden topics, sim time. The recordings and the
  playback are the robot's: every page sees them, and stops them.
- Behavior Tree Inspector: its recordings are made by the same rosbags service, with the same
  advanced options, and listed (and stopped) by the Rosbags widgets. Bags compressed by rosbag2
  (zstd, each file or each message) are played back too.
- Plugins: `connection.subscribeBags`, `bagsAction`, `recordBehaviorTree`'s options, and the
  types of `src/shared/rosbag.ts`.
- Parameters widget: nodes' parameters, as rqt_reconfigure and `ros2 param` show them. A node's
  parameters grouped by their prefixes, each edited in place (a switch, a slider within its range,
  a field), with what the node refuses and why; changes made elsewhere followed live on
  `/parameter_events`. Their descriptions, ranges and constraints (`describe`); new ones set and
  undeclared ones deleted (`set`, `delete`); all of them dumped as YAML, downloaded, saved on the
  robot or copied (`dump`), and loaded from a YAML file of the robot or of the page's device
  (`load`), as `ros2 param` does, with Python's yaml. A widget can be for one node, or view only.
- The file browser picks parameter files (YAML) too.
- Plugins: `connection.subscribeParameters`, `setParameters`, `dumpParameters`, `loadParameters`,
  and the types of `src/shared/parameters.ts`.
- Navigation widget: the laser scan, put in the map frame by TF as each arrives (in 3D: a lidar
  mounted upside down lands where it looks), the quickest check of the localization; and the
  robot drawn with Nav2's footprint (`published_footprint`), moving with the robot. A scan no
  longer coming turns gray; what cannot be shown is said over the map.
- Plugins: `connection.subscribeOverlay`, a laser scan's points or a footprint's polygon in a
  frame.
- ROS Monitor widget: the ROS graph, as the `ros2` command line shows it, on three sheets: its
  topics, services and actions, filtered by name or type, the hidden ones on demand. A topic's
  messages (`ros2 topic echo`: a field of them, lists cut, the latest 100 kept while paused), their
  rate, bandwidth and delay over a window (`hz`, `bw`, `delay`: from the serialized messages,
  exact), its publishers and subscriptions with their QoS and those that cannot talk (`info -v`),
  a message to publish, field by field or as JSON, once or at a rate (`pub`: QoS matching the
  subscriptions, `now` stamps), going on while other topics are shown. A service to call, once
  or at a rate (`ros2 service call`), its nodes (`info`) and its events (`echo`, since Jazzy).
  Every goal of an action, whoever sent it, with its latest feedback, to cancel one or all; a
  goal to send and follow to its result (`ros2 action send_goal`). Their types' definitions
  (`ros2 interface show`).
- rclnodejs's code of the ROS interfaces sourced since it was installed (a robot's own messages,
  services and actions), or rebuilt with new ones, is made when the server starts: their topics,
  services and actions work in every widget without `npx generate-ros-messages`. rclnodejs's own
  fallback missed services' and actions' interfaces.
- Plugins: `connection.subscribeGraph`, `subscribeTopicInfo`, `subscribeTopicMonitor`,
  `publishTopic`, `interfaceInfo`, `subscribeAction`, `sendGoal`, `cancelGoal`, and `callService`'s
  `checked` option, which makes the request from the service's definition: 64 bit integers, which
  rclnodejs takes as BigInt only, now work. The types of `src/shared/monitor.ts`, and the
  `MinusIcon`, `TopicIcon`, `ServiceIcon`, `ActionIcon`, `MonitorIcon` and `SendIcon` icons.
- Behavior Tree Inspector widget: what a BT.CPP behavior tree is doing, from its
  `nav2_msgs/BehaviorTreeLog` (Nav2's `/behavior_tree_log`), on the tree of its XML file: the
  running branch, each node's status, last result, counts and ports, and the latest transitions,
  as a graph or a list. The server follows the log for every page and keeps the nodes' state.
- The inspector records its log into rosbags (`ros2 bag record`), and plays rosbags back in the
  widget (MCAP or SQLite, Humble's or Jazzy's), with pause, seek and speed.
- Behavior Tree Editor widget: a BT.CPP behavior tree's XML file of the robot, edited as a graph,
  with a palette of nodes (BT.CPP's, Nav2's, node libraries of `TreeNodesModel`, the file's own),
  drag and drop, a side panel for the nodes' names and ports, subtrees, undo and redo, copy and
  paste, and an XML view. Saves only what changed, keeping the file's comments and layout, and
  never over changes made on the robot since it was read.
- The file browser is resizable, and shows long names whole.
- Plugins: the `behavior-tree` property kind, `connection.subscribeBehaviorTree`,
  `recordBehaviorTree`, `subscribeBehaviorTreePlayback`, `controlBehaviorTreePlayback`,
  `subscribeBehaviorTreeFile`, `saveBehaviorTreeFile`.
- Uploads take behavior trees (XML) as well as images.
- Logs widget: the ROS log (`/rosout`), as rqt_console and swri_console show it: every node's
  messages coloured by level, the nodes running and those that logged with their counts, filters
  by node, level and text (terms or regular expressions, to show or to hide), pause, follow,
  clear, download, and a message's details. A widget can be for some nodes only (`amcl,
  *_server`). The server follows the log for every page and keeps its latest 10,000 messages.
- Plugins: `connection.subscribeRosout`, and the `LogsIcon`, `NodesIcon`, `SearchIcon`,
  `BanIcon`, `FilterIcon`, `DownloadIcon` and `ArrowDownToLineIcon` icons.
- Diagnostics widget: the robot's diagnostics (`diagnostic_msgs/msg/DiagnosticArray`), from every
  node's `diagnostic_updater` (`/diagnostics`, by node) or the aggregator's tree
  (`/diagnostics_agg`): each status's level, message, hardware ID and values, the groups with the
  worst under them, as a tree, as a list or as the latest changes of level, filtered by level and
  text. A widget can be for some statuses only (`Sensors, motor_*`). The server follows the
  diagnostics for every page, marks stale the statuses no longer received, and keeps their changes
  of level.
- Plugins: `connection.subscribeDiagnostics`, and the `DiagnosticsIcon` and `UnfoldIcon` icons.
- File Manager widget: the robot's files, in the behavior tree editor's look. Folders listed with
  their entries' sizes and times, unfolded in place, sorted and filtered; places (home, the ROS
  workspaces sourced, bookmarks) and the disks with their free space; an entry's details, its
  permissions changed there; an overview of the disks and of what takes a folder's space (its
  largest entries, its files by type, the largest and latest files). Entries made, renamed in
  place, cut, copied and pasted, moved or copied by dragging them onto folders, deleted,
  downloaded (folders as `.tar.gz`), uploaded by dropping files and folders onto the widget, with
  their progress; names taken are asked about. Text files are edited in tabs, as gedit does: line
  numbers, syntax highlighting (YAML, XML, Python, C++, CMake, JSON, shell, INI, Markdown, ROS
  interfaces), search and replace, indentation, line ends kept, undo and redo, never saved over
  changes made on the robot since they were read. Images are shown, PGM maps too. A widget can
  stay in its folder, or be read-only. The server polls the folders and files shown.
- Plugins: `fsApi` and `ApiError`, the `Fs*` types, and the `FolderIcon`, `FolderPlusIcon`,
  `FileIcon`, `FileTextIcon`, `FilePlusIcon`, `UploadIcon`, `ArrowUpIcon`, `ArrowLeftIcon`,
  `HomeIcon`, `HardDriveIcon`, `BookmarkIcon`, `SidebarIcon`, `PieChartIcon`, `InfoIcon`,
  `WrapIcon`, `LinkIcon`, `LockIcon` and `ArchiveIcon` icons.
- REST errors of the API reject with an `ApiError`, which has the HTTP status.
- Terminal widget: a shell on the robot (the login shell of the server's user), or a command, in
  a full terminal (xterm.js): colours, full screen programs and their mouse, copy and paste. It
  outlives the page: reloaded, reconnected or shown again, it is as it was, full screen programs
  included; hung up an hour after no page shows it. On touch screens, Termux's extra keys (Esc,
  Tab, Ctrl, Alt, Home, End, the arrows, Page Up and Down): sticky modifiers that also apply to the
  on-screen keyboard, keys swiped up for another character, a layout of one's own; the terminal
  fills the screen above the on-screen keyboard while typing; one finger scrolls, two pinch the
  text's size. Needs Python 3 (ROS 2's), no native module. Terminals open from the dashboard's own
  pages only.
- Plugins: `connection.subscribeTerminal`, `terminalInput`, `resizeTerminal`, `ackTerminal`,
  `restartTerminal`, the `TerminalOutput` and `TerminalExit` types, and the `ShellIcon`,
  `KeyboardIcon`, `MaximizeIcon`, `MinimizeIcon`, `ClipboardIcon`, `TextSmallerIcon` and
  `TextLargerIcon` icons.
- Networking widget: the robot's networks, through NetworkManager (`nmcli`), as a phone's settings
  show them. The Wi-Fi networks in range, joined with their password (WPA, WPA2 and WPA3 Personal,
  WEP, WPA Enterprise with PEAP), hidden ones by name; the connections saved, connected and
  disconnected, edited (password, interface, IPv4 by DHCP or static with gateway and DNS, shared,
  connecting automatically and with which priority) and forgotten; wired connections with an
  address of their own; the robot as an access point (WPA2, band, channel, its address), started
  now or at boot, and a network shared by its password and a QR code; the interfaces, their state,
  addresses, gateway, DNS, MAC address and speed. The server tells each page which interface it
  reaches the robot through, and the widget asks before a change that would cut it off. The server
  follows NetworkManager for every page (`nmcli monitor`), shows every page what is being done and
  how it ended, and says when its user may not change the networks (a polkit rule, see the
  README). Networks change from the dashboard's own pages only.
- Plugins: `connection.subscribeNetwork`, `networkAction`, the `Network*`, `WifiNetwork`,
  `WifiSecurity` and `ConnectionKind` types, and the `NetworkIcon`, `WifiIcon`, `WifiOffIcon`,
  `EthernetIcon`, `HotspotIcon` and `ShieldIcon` icons.
- Plugins: a `select` property's options can be known at run time, e.g. the robot's: `useOptions`,
  a hook the properties panel calls. Its values are not checked against the options.

## 0.1.0

The first release, from the Dieletrikbot's web dashboard.

- Panels of widgets on a grid, edited in the browser, with layouts of their own for tablets and
  phones.
- Widgets: Teleop, Navigation, Robot Model, Arm Teleop, Camera, Image Viewer, Button,
  Application Manager.
- Plugins: widgets loaded at run time (`tassello/sdk`, built with `tassello/vite`), server sides
  (`tassello/server`), defaults for any widget's properties, example panels. Found on the command
  line, in the ament index (`tassello_plugins`) and as `tassello-plugin-*` npm packages.
- Generic ROS access from the page: publish, call services, subscribe to topics, TF.
- `tassello create-plugin`.
