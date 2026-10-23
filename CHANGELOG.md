# Changelog

Tassello follows [semantic versioning](https://semver.org): before 1.0, a new minor version may
change the plugin API (`tassello/sdk`, `tassello/server`, `tassello/vite`), as noted here.

## Unreleased

- Panels are exported (**⋯ → Export panel**) as their JSON file, `<id>.json`, with their
  desktop, tablet and phone layouts, and imported from such files (**⋯ → Import panel…**, or
  from the page without panels), several at once: each a new panel, named as in its file, with
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
