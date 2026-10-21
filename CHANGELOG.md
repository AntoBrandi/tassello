# Changelog

Tassello follows [semantic versioning](https://semver.org): before 1.0, a new minor version may
change the plugin API (`tassello/sdk`, `tassello/server`, `tassello/vite`), as noted here.

## Unreleased

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
