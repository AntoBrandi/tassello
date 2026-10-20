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
