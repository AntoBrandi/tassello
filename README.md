# Tassello

**A web dashboard for ROS 2 robots.** Drive the robot, send it navigation goals, see it move in 3D,
watch its cameras, run commands on it and manage its services from any browser on the network,
phones included. Arrange it all in the browser, as panels of widgets, and extend it with plugins.

*Tassello* is Italian for a mosaic tile, and for a wall plug: the dashboard is a mosaic of widgets,
and plugins add more.

- **Panels of widgets** on a grid: add, move and resize them in the browser, no code or config files.
- **Every device**: a desktop canvas, and layouts of their own for tablets and phones.
- **Built in**: teleop pads, a Nav2 map with goals, the robot's URDF in 3D, an arm jogger, cameras,
  images, command buttons, a systemd application manager, a behavior tree inspector and
  editor, and the ROS log of every node.
- **Plugins**: widgets of your own, with server-side code if they need it, as npm or ROS packages.
- **One process**: a ROS 2 node in Node.js. Nothing to install on the robot but Node.js.

## Install

Tassello runs on the robot (or any machine on its ROS network) and needs:

- ROS 2: Humble, Jazzy, Kilted or Lyrical, on x64 or arm64 (e.g. a Raspberry Pi), for which
  [rclnodejs](https://github.com/RobotWebTools/rclnodejs) ships prebuilt binaries;
- Node.js 22 or newer, and npm.

```bash
npm install -g tassello
```

Then, with your ROS 2 setup sourced:

```bash
source /opt/ros/jazzy/setup.bash
tassello
```

and open `http://<robot>:8080`. The first start creates the panels directory with two example
panels, Teleoperation and Navigation.

```text
tassello [options] [--ros-args ...]

  -p, --port <port>         HTTP port (8080)
      --host <address>      the address to listen on (all of them)
      --panels-dir <dir>    where the panels are kept (~/.local/share/tassello/panels)
      --plugin <plugin>     loads a plugin: a folder, or an installed package's name. Repeatable
      --no-discover         loads only those plugins, not the installed ones
      --node-name <name>    the ROS node's name (tassello)
```

ROS arguments go after `--ros-args`, e.g. `tassello --ros-args -p use_sim_time:=true`. The port
and the panels directory are also the node's parameters `port` and `panels_dir`.

### As a service

To start it at boot, a systemd unit like this one (as the user the commands should run as):

```ini
[Unit]
Description=Tassello robot dashboard
After=network-online.target

[Service]
User=robot
ExecStart=/bin/bash -c 'source /opt/ros/jazzy/setup.bash && exec tassello'
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Using it

The page shows one **panel** at a time: a canvas of fixed-size cells on which **widgets** lie,
each spanning as many cells as needed. A panel is made for a task (teleoperation, navigation,
manipulation, ...) and the top bar switches between them. It has two modes:

- **View**: the widgets work: drive, watch, press.
- **Edit**: add widgets (**Add widget**), drag them to move them, drag their corner to resize
  them, click one to edit its properties in the side panel, and create, rename, duplicate or
  delete panels (**⋯**). Every change is saved as you make it; **Ctrl+Z** undoes it, the
  arrow keys move the selected widget and **Delete** removes it.

The URL names the panel (`#/teleoperation`), so a panel can be bookmarked, e.g. on a phone's
home screen. Each panel is a JSON file, `<panels dir>/<id>.json`: copy it to copy the panel to
another robot.

### Phones and tablets

A panel has a layout per kind of device, chosen by the width of the window: **desktop** (from
1100 px), **tablet** (from 640 px) and **phone**. The widgets and their properties are the same on
all of them; only where they are differs.

- On a desktop the board is a canvas of fixed cells, which scrolls both ways.
- Tablets have 12 columns and phones 6, stretched to the width of the screen: a layout looks the
  same on every phone, and the page only scrolls down.

Until arranged, a tablet's or phone's layout is made from the desktop's: the widgets in its reading
order, narrowed to the columns (keeping their shape), side by side where they fit. In edit mode the
device buttons of the top bar show each device's layout, at its width: moving or resizing a widget
there arranges the layout for that device, and the eye button hides a widget on it (e.g. the 3D
model on phones). **Back to automatic** forgets the device's own layout. Widgets added later go
after the others on the devices already arranged.

## Widgets

| Widget | What it does |
|---|---|
| **Teleop** | Publishes velocity commands (`Twist` or `TwistStamped`) while its pads are held: one pad (x, z), or two in omnidirectional mode (x and y, z). Then one zero, and nothing, so that the lower priorities of a twist_mux, e.g. navigation, take over again |
| **Navigation** | The map, optionally the global and local costmaps and the planned path, and the robot where TF puts it. Its tools set the pose estimate and send navigation goals, as RViz's do: press where the robot is or should go, drag towards where it faces. Pan, zoom, fit the map or follow the robot |
| **Robot Model** | The robot in 3D, from its URDF and meshes, posed by the joint states. The links of moving joints turn orange, with an arrow at the joint in the direction of the motion |
| **Arm Teleop** | Jogs an arm driven by ros2_control `JointTrajectoryController`s: a slider per joint, or pads moving the end effector in a straight line (damped least squares on the URDF's kinematics, collision checked by MoveIt's move_group when it runs) |
| **Camera** | An image topic, raw (`sensor_msgs/Image`) or compressed (`sensor_msgs/CompressedImage`) |
| **Image Viewer** | A static image: a file of the robot, typed (`/…`, `~/…`, `package://…`) or picked by browsing its folders, or an image uploaded from the page's device |
| **Button** | Runs a bash command on the robot, showing its output. Takes its running colour until the command finishes, on every page showing it; pressing it again stops the command |
| **Application Manager** | The robot's systemd services matching a name: their state, whether they start at boot, buttons to start, stop and restart them, and their journal |
| **Behavior Tree Inspector** | What a BT.CPP behavior tree is doing, from its log (Nav2's `/behavior_tree_log`): the tree of its XML file with the running branch lit, each node's status, last result, counts and ports, and the latest transitions. As a graph (pan, zoom, follow the running nodes) or a list. Records the log into rosbags, and plays rosbags back at any speed |
| **Behavior Tree Editor** | Edits a BT.CPP behavior tree's XML file of the robot as a graph: nodes from a palette (BT.CPP's, Nav2's, your libraries'), dragged where they go, moved with their children, their names and ports edited in a side panel. Subtrees, undo and redo, copy and paste, an XML view. Saves only what changed, never over changes made meanwhile |
| **Logs** | The ROS log (`/rosout`), as rqt_console and swri_console show it: every node's messages coloured by level, the nodes running and those that logged with their counts, filtered by node, by level and by text (terms or a regular expression, to show or to hide). Pause, follow the newest, clear, download, and a message's details: where it was logged |

Their properties (topics, frames, speeds, colours, ...) are edited in the side panel of edit mode.

Notes on some of them:

- **Navigation** publishes goals as `geometry_msgs/PoseStamped` (`/goal_pose`, which Nav2's
  bt_navigator follows) and pose estimates as `geometry_msgs/PoseWithCovarianceStamped`
  (`/initialpose`, with RViz's covariance, which AMCL starts from). Layers in another frame, like
  Nav2's local costmap, are placed in the map frame by TF.
- **Robot Model** loads the meshes of the description from the robot's ROS packages
  (`package://` paths), which the server serves compressed. three.js is only fetched by the pages
  showing one.
- **Arm Teleop** streams its controllers one-point trajectories just ahead of the arm, 20 times
  a second: when the stream stops, the arm stops at the last point. A joint stays within the
  URDF's limits, or those of an optional *calibration state*: a `std_msgs/String` topic whose
  JSON a robot's hardware interface may publish:

  ```json
  {
    "active": true,
    "calibrating": false,
    "problem": null,
    "joints": [
      { "name": "joint_1", "has_motor": true, "located": true, "drivable": true,
        "lower": -1.5, "upper": 1.5, "allowed_lower": -1.4, "allowed_upper": 1.4 }
    ]
  }
  ```

  A drivable joint moves within `allowed_lower`..`allowed_upper`; others do not move, and the
  widget says why (no motor, not located, no limits).
- **Button** commands run with `bash -c`, as the server's user and in its environment (the
  sourced ROS setup), from the home directory.
- **Application Manager** lists the services of the system's and the user's service managers. It
  acts as the server's user: for the system's services, give that user the right to manage them,
  e.g. a polkit rule allowing it to start, stop and restart `myrobot-*` units. To read systemd's
  own journal lines, the user must be in the `systemd-journal` group.
- **Image Viewer** reads only images (PNG, JPEG, GIF, WebP, BMP, SVG). Uploads are kept next to
  the panels (`~/.local/share/tassello/images`). Images are served sandboxed: an SVG cannot run
  scripts in the dashboard.
- **Behavior Tree Inspector** follows a `nav2_msgs/BehaviorTreeLog` topic, which BT.CPP trees
  log with Nav2's `RosTopicLogger`: Nav2's bt_navigator on `/behavior_tree_log`. Its *tree file*
  is the XML the robot runs (`/…`, `~/…`, `package://…`, browsed or uploaded), read with its
  includes and subtrees, and again when it changes; e.g. Nav2's default,
  `package://nav2_bt_navigator/behavior_trees/navigate_to_pose_w_replanning_and_recovery.xml`.
  Without it, the nodes are listed as the log names them. Since Jazzy, the log gives the nodes'
  UIDs, which tell them apart exactly; before, nodes of the same name (a `RecoveryNode` named
  after its action) are told apart by their statuses and their parents'. The log only says what
  changes: the server follows it for every page, and for 10 minutes after the last one closes,
  so that a page opened later sees the nodes as they are. A node reset to idle by its parent
  shows how it last ended.

  Its record button records the log on the robot with `ros2 bag record`, into a new folder
  (`<recordings folder>/behavior_tree_<date>_<time>` by default), until pressed again: every
  page showing the topic shows it recording. Its playback button opens a rosbag of the robot
  (a bag's folder, or its `.mcap` or `.db3` file, e.g. of a whole run recorded with
  `ros2 bag record -a`) and plays its log in the widget, on the tree of its file, without
  publishing anything: pause, seek and choose the speed (0.1× to 16×). Bags of Humble and of
  Jazzy are read either way; SQLite bags need Node.js 22.13, zstd compressed MCAP 22.15.
- **Behavior Tree Editor** edits one BehaviorTree of the file at a time (its toolbar switches
  between them, adds new ones, and double clicking a subtree opens its tree, even in an included
  file). Add a node from the palette by dragging it where it goes (into a node, or beside one), or
  click it to add it into the selected node, or after it. Drag nodes to move them with their
  children. The side panel edits the selected node's name and ports, with their types, defaults
  and descriptions from its model, and its other attributes (BT.CPP 4's `_skipIf`, `_while`…);
  it moves, duplicates, wraps, unwraps and replaces it. What BT.CPP would refuse, such as a
  decorator without its child, is marked. Keys: Delete, Ctrl+Z, Ctrl+Shift+Z, Ctrl+C, Ctrl+X,
  Ctrl+V, Ctrl+D, Ctrl+S, the arrows to move the selection (Alt: the node).

  The palette has BT.CPP's nodes (of the file's format, `BTCPP_format`), Nav2's (its
  `nav2_tree_nodes.xml`, when installed), those of the file's `TreeNodesModel` and includes, and
  those of the *node libraries*: XML files of `TreeNodesModel`, as Groot exports them, set in the
  widget's properties or loaded from the palette. Saving writes back only the elements changed,
  the rest of the file (comments, blank lines, indentation) as it was. The file is read again when
  it changes on the robot: without changes in the editor it is shown at once, with changes the
  editor asks which to keep, and a save over a file changed since it was read is refused.
  Uploads, and files the server cannot write, are saved elsewhere with *Save as*. The editor keeps
  its changes while the page is open, and the page asks before closing with changes not saved.
- **Logs** follows `/rosout` (`rcl_interfaces/msg/Log`), on which every node's logger publishes.
  Its list of nodes has those running in the ROS graph and those that logged, with their
  warnings and errors: choose some to see only theirs. A node's logger is named after it, dots
  for slashes (`robot1.amcl` for `/robot1/amcl`). The level buttons show and hide each level
  (Shift+click: that level only); *Include* and *Exclude* keep or drop the messages containing any
  of their terms, separated by `;`, or matching a regular expression. Pausing holds the list while
  the new messages wait; clearing empties it for this page. A message clicked shows whole, with its
  file, line and function; the arrow keys go through the list. *Download* saves the messages shown
  as ROS prints them (`[WARN] [1729435407.512346] [robot1.amcl]: ...`). The widget's properties
  set its nodes (names or globs, e.g. `amcl, *_server`: one widget per subsystem), the levels and
  filters it opens with, and the time shown: the clock, ROS stamps, or none. The server follows the
  log for every page, keeping its latest 10,000 messages, and for 10 minutes after the last page
  closes: a page opened later sees what was logged meanwhile, and when first opened, what each
  node logged in its last 10 seconds (rosout's own history).

## Plugins

A plugin adds widgets, and server-side code if they need it, to any Tassello: an npm package or
a folder whose `package.json` says what it has. Robots get their own controls this way without
forking the dashboard: a gripper, a battery gauge, a calibration procedure, a custom service.

```bash
tassello create-plugin my-robot      # a plugin with an example widget and server side
cd my-robot && npm install && npm run build
tassello --plugin .
```

Plugins are found:

- on the command line: `--plugin <folder or package>`;
- in ROS packages of the sourced workspaces that register a `tassello_plugins` resource in the
  ament index, so that a robot's ROS package can carry its own;
- as npm packages named `tassello-plugin-*` (or `@scope/tassello-plugin-*`), installed next to
  Tassello (e.g. both with `npm install -g`) or in the working directory's `node_modules`.

A plugin can also give Tassello's widgets new defaults (a robot's topic names and speed limits)
and ship example panels. See **[docs/plugins.md](docs/plugins.md)**.

## Security

Tassello has no login. **Anyone who can open the page can drive the robot, run any command as
the server's user, read its images, behavior trees and the behavior tree logs of its rosbags,
record rosbags into new folders, and write behavior tree files (XML files whose root is
`<root>`, over others of the same kind only)**: keep it on a network you trust, or behind a reverse proxy
with authentication (it serves everything under `/`, its WebSocket at `/ws`).

## How it works

```
 browser ── HTTP: page, /api (panels, topics, files), /plugins ────┐
         └─ WebSocket /ws: twists, poses, images, maps, TF, ───────┤
                           topics, services, commands, plugins     └─ server (Node.js, one ROS node)
                                                                        ├─ rclnodejs: ROS
                                                                        ├─ sharp: raw images to JPEG, maps to PNG
                                                                        ├─ bash: the buttons' commands
                                                                        └─ the plugins' server sides
```

Safety and bandwidth are the server's concern:

- A teleop widget streams its command while a pad is held. When the stream stops without its
  final zero (page closed, network lost), the server publishes it after 0.5 s. A page that stops
  answering the server's pings is dropped within 20 s. Arm jogs stop the same way.
- Each camera or map widget gets one frame at a time, the latest, and the next once it has drawn
  it: a slow network or phone skips frames instead of lagging behind. Raw images are scaled down
  and compressed once per frame, however many pages watch them. Maps are coloured and compressed
  on the server and kept up to date with their `<topic>_updates`, subscribed with the durability
  of their publishers, so latched maps arrive.
- Topics are subscribed once, whatever the number of pages, with the type and QoS of their
  publishers; TF only while a page shows the robot.
- Behavior tree logs, streams of transitions, are followed whole, none dropped: each page gets
  the nodes that changed, at most 10 times a second, however fast the tree ticks.
- The ROS log is followed once for every page: each gets the new messages at most 10 times a
  second, at most 500 at a time (a node logging faster has some skipped, which the page shows).
  Only the rows in sight are drawn.
- A button runs the command saved in its panel, never one sent by the page.

## Developing

```bash
git clone https://github.com/AntoBrandi/tassello && cd tassello
npm install
npm run build        # the page (dist/www), the server and the plugin API (dist/)
npm run server       # the server from its sources, with ROS sourced: http://localhost:8080
npm run dev          # the page, reloaded on every change, at http://localhost:5173
npm run typecheck
npm test
```

`npm run dev` forwards the API and the WebSocket to `DASHBOARD_SERVER`, `http://localhost:8080`
by default: point it at a robot to work on the page against the real thing.

- `src/client/`: the page, React built by Vite. `widgets/` holds the widgets, `board/` the grid,
  `sdk/` what plugins import as `tassello/sdk`.
- `src/server/`: the server, TypeScript that Node.js runs as is in development and that the
  build compiles to JavaScript for the package. `api.ts` is what plugins import as
  `tassello/server`.
- `src/shared/`: what both sides agree on: the panels and the WebSocket protocol (`protocol.ts`).
- `src/vite/`: the Vite plugin that builds plugins, `tassello/vite`.
- `template/`: what `tassello create-plugin` copies.

To add a widget to Tassello itself, write it in `src/client/widgets/` like `ButtonWidget.tsx` and
list it in `registry.ts`. Never change a widget's `type`: the panels store it.

## License

[Apache 2.0](LICENSE)
