# Tassello

**A web dashboard for ROS 2 robots.** Drive the robot, send it navigation goals, see it move in 3D,
watch its cameras, run commands on it, open a terminal on it and manage its services from any
browser on the network, phones included. Arrange it all in the browser, as panels of widgets, and extend it with plugins.

*Tassello* is Italian for a mosaic tile, and for a wall plug: the dashboard is a mosaic of widgets,
and plugins add more.

- **Panels of widgets** on a grid: add, move and resize them in the browser, no code or config files.
- **Every device**: a desktop canvas, and layouts of their own for tablets and phones.
- **Built in**: teleop pads, a Nav2 map with goals, the robot's URDF in 3D, an arm jogger, cameras,
  images, command buttons, a systemd application manager, a behavior tree inspector and
  editor, the ROS log of every node, the robot's diagnostics, its topics, services and actions
  as the `ros2` command line shows them, its nodes' parameters, its rosbags (recorded, listed,
  downloaded and played back), a file manager, a terminal, its networks (Wi-Fi
  joined, connections switched, the robot as an access point), and its computer: CPU, memory,
  temperatures, a Raspberry Pi's throttling, a Jetson's GPU and power, disks and networks.
- **Plugins**: widgets of your own, with server-side code if they need it, as npm or ROS packages.
- **One process**: a ROS 2 node in Node.js. Nothing to install on the robot but Node.js.

## Install

Tassello runs on the robot (or any machine on its ROS network) and needs:

- ROS 2: Humble, Jazzy, Kilted or Lyrical, on x64 or arm64 (e.g. a Raspberry Pi), for which
  [rclnodejs](https://github.com/RobotWebTools/rclnodejs) ships prebuilt binaries;
- Node.js 22 or newer, and npm;
- Python 3, which ROS 2 comes with: the Terminal widget's pseudo-terminals;
- NetworkManager, which Ubuntu runs, for the Networking widget.

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

Source the workspaces whose messages the widgets use too, a robot's own (`/opt/<vendor>/…`, a
colcon workspace's `install/setup.bash`): rclnodejs needs JavaScript code of every interface it
uses, which it makes when installed for the packages then sourced. Tassello makes that of the
others when it starts, and again for a package rebuilt with new interfaces, in a fraction of a
second; rclnodejs keeps it in its `generated` folder, which the server's user must be able to
write (else, run `npx generate-ros-messages` in Tassello's folder, with them sourced, as a user who
can).

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
| **Navigation** | The map, optionally the global and local costmaps and the planned path, the laser scan, and the robot where TF puts it, drawn with Nav2's footprint. Its tools set the pose estimate and send navigation goals, as RViz's do: press where the robot is or should go, drag towards where it faces. Pan, zoom, fit the map or follow the robot |
| **Robot Model** | The robot in 3D, from its URDF and meshes, posed by the joint states. The links of moving joints turn orange, with an arrow at the joint in the direction of the motion |
| **Arm Teleop** | Jogs an arm driven by ros2_control `JointTrajectoryController`s: a slider per joint, or pads moving the end effector in a straight line (damped least squares on the URDF's kinematics, collision checked by MoveIt's move_group when it runs) |
| **Camera** | An image topic, raw (`sensor_msgs/Image`) or compressed (`sensor_msgs/CompressedImage`) |
| **Image Viewer** | A static image: a file of the robot, typed (`/…`, `~/…`, `package://…`) or picked by browsing its folders, or an image uploaded from the page's device |
| **Button** | Runs a bash command on the robot, showing its output. Takes its running colour until the command finishes, on every page showing it; pressing it again stops the command |
| **Application Manager** | The robot's systemd services matching a name: their state, whether they start at boot, buttons to start, stop and restart them, and their journal |
| **Behavior Tree Inspector** | What a BT.CPP behavior tree is doing, from its log (Nav2's `/behavior_tree_log`): the tree of its XML file with the running branch lit, each node's status, last result, counts and ports, and the latest transitions. As a graph (pan, zoom, follow the running nodes) or a list. Records the log into rosbags, and plays rosbags back at any speed |
| **Behavior Tree Editor** | Edits a BT.CPP behavior tree's XML file of the robot as a graph: nodes from a palette (BT.CPP's, Nav2's, your libraries'), dragged where they go, moved with their children, their names and ports edited in a side panel. Subtrees, undo and redo, copy and paste, an XML view. Saves only what changed, never over changes made meanwhile |
| **Logs** | The ROS log (`/rosout`), as rqt_console and swri_console show it: every node's messages coloured by level, the nodes running and those that logged with their counts, filtered by node, by level and by text (terms or a regular expression, to show or to hide). Pause, follow the newest, clear, download, and a message's details: where it was logged |
| **Diagnostics** | The robot's diagnostics (`/diagnostics`, or the aggregator's `/diagnostics_agg`), as rqt_robot_monitor shows them: each status's level, the groups with the worst under them, those with problems unfolded. As a tree, as a list (the worst first) or as the latest changes of level, filtered by level and by text; a widget can be for some statuses only. A status's details: its message, hardware ID, values and latest changes. Pause, download, and forget the statuses no longer published |
| **ROS Monitor** | The ROS graph, as the `ros2` command line shows it, on three sheets: its topics, services and actions, filtered by name or type, the hidden ones on demand. A topic's messages, their rate, bandwidth and delay, its publishers and subscriptions with their QoS and those that cannot talk, a message to publish once or at a rate (`ros2 topic echo`, `hz`, `bw`, `delay`, `info -v`, `pub`); a service to call, once or at a rate (`ros2 service call`, `info`, `echo`); every goal of an action, whoever sent it, with its feedback, and a goal to send or cancel (`ros2 action send_goal`, `info`); their types' definitions (`ros2 interface show`) |
| **Parameters** | Nodes' parameters, as rqt_reconfigure and `ros2 param` show them: the nodes of the graph, and the parameters of the one chosen grouped by their prefixes, each edited in place (a switch, a slider within its range, a field), live as they change wherever they are set. Their descriptions, ranges and constraints (`ros2 param describe`); new ones set and undeclared ones deleted (`set`, `delete`); all of them dumped as YAML, downloaded or saved on the robot (`dump`), and loaded from a YAML file of the robot or of the page's device (`load`) |
| **Rosbags** | The robot's rosbags, as `ros2 bag` makes and reads them: those of a folder, the newest first, with when, how long and how big, their storage and compression, each topic's type, count and rate (`ros2 bag info`); downloaded, deleted, or played on the robot's topics (`ros2 bag play`: paused, sought, sped up, looped, some topics only). New ones recorded (`ros2 bag record`): topics chosen from the graph, all of them, or matching an expression, with rosbag2's options: the storage (MCAP, SQLite) and its preset, a new file by size or duration, compression of each file or message. Every page sees the recordings and the playback, the behavior tree inspectors' too |
| **File Manager** | The robot's files: folders unfolded in place, places (home, the ROS workspaces, bookmarks) and the disks' free space, an entry's details and permissions, what takes a folder's space. Make, rename, cut, copy, paste, drag onto folders, delete, download (folders as `.tar.gz`) and upload (drop files and folders onto it). Text files edited in tabs as gedit does: highlighting, search and replace, undo; images and PGM maps shown |
| **Terminal** | A shell on the robot, or a command (`htop`, `tmux attach`), in a full terminal: colours, full screen programs, the mouse. It outlives the page: reloaded, reconnected or shown again, it is as it was. On touch screens, the keys phones lack, as Termux has them: Esc, Tab, Ctrl, Alt, Home, End, the arrows, Page Up and Down, and while typing the terminal fills the screen above the on-screen keyboard |
| **System Monitor** | The robot's computer, as top, sensors and a Jetson's jtop show it: the CPU's load, of each core, and their frequencies; the memory and swap; the temperatures by chip, and the fans; a Raspberry Pi's throttling (under-voltage, capped frequency, now and since boot); the GPUs (a Jetson's, NVIDIA's, AMD's) and the power rails (a Jetson's); the disks' traffic and space; the networks' traffic. With charts of the last 5 minutes |
| **Networking** | The robot's networks, through NetworkManager, as a phone's settings show them: the Wi-Fi networks in range, joined with their password; the connections saved, switched between, edited (their addresses by DHCP or static), forgotten; the robot as an access point, its network shared by a QR code; the interfaces, their state and addresses. Asks before a change that would cut the page off from the robot |

Their properties (topics, frames, speeds, colours, ...) are edited in the side panel of edit mode.

Notes on some of them:

- **Navigation** publishes goals as `geometry_msgs/PoseStamped` (`/goal_pose`, which Nav2's
  bt_navigator follows) and pose estimates as `geometry_msgs/PoseWithCovarianceStamped`
  (`/initialpose`, with RViz's covariance, which AMCL starts from). Layers in another frame, like
  Nav2's local costmap, are placed in the map frame by TF.

  The laser scan (`sensor_msgs/LaserScan`, `/scan`) is the quickest check of the localization:
  its points fall on the map's walls when the robot is where the map frame says. Each scan is put
  in the map frame by TF as it arrives, on the server, in 3D (a lidar mounted upside down or
  tilted lands where it looks), its points without a return left out, at most 5 a second; a scan
  no longer coming turns gray after 1.5 s. The robot is drawn with the footprint Nav2's costmaps
  use (`geometry_msgs/PolygonStamped`, `/local_costmap/published_footprint`), put in the robot's
  frame as it arrives and drawn where the robot is now, so that it moves with it; a circle
  without it, or zoomed out too far to see it. What cannot be shown, e.g. a scan whose frame TF
  does not connect to the map, is said above the robot's pose.
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
  (`<recordings folder>/behavior_tree_<date>_<time>` by default), with the Rosbags widget's
  advanced options, until pressed again: every page showing the topic shows it recording, and
  the Rosbags widgets list it (and may stop it). Its playback button opens a rosbag of the robot
  (a bag's folder, or its `.mcap` or `.db3` file, e.g. of a whole run recorded with
  `ros2 bag record -a`) and plays its log in the widget, on the tree of its file, without
  publishing anything: pause, seek and choose the speed (0.1× to 16×). Bags of Humble and of
  Jazzy are read either way, compressed by rosbag2 (zstd, each file or each message) or not;
  SQLite bags need Node.js 22.13, zstd compressed ones 22.15.
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
- **Diagnostics** follows a `diagnostic_msgs/msg/DiagnosticArray` topic: `/diagnostics`, on which
  every node's `diagnostic_updater` publishes its statuses (named `node: task`, grouped by node),
  or `/diagnostics_agg`, the aggregator's tree of them (`/Robot/Sensors/Lidar`). A group shows the
  worst level under it; one the aggregator puts in error only because some statuses under it are
  stale shows as stale. A status not received for 5 s, or for 3 of its periods if it is slower, is
  stale: what published it stopped. The level buttons show and hide each level (Shift+click: that
  level only), counting the statuses, not the groups that sum them up; *Filter* keeps the statuses
  whose name, message or hardware ID contain any of its terms, separated by `;`, or match a
  regular expression, and a group's with all those under it. The groups with problems unfold, and
  stay unfolded once these are gone, until folded; the arrow keys go through the tree and fold
  and unfold it. A status clicked shows its message, hardware ID, values and latest changes of
  level. Pausing holds the statuses as they are; *Forget* hides those no longer published, until
  they are again; *Download* saves the statuses shown, the worst first, with their values (or the
  changes shown). The widget's properties set its statuses (names, paths or globs, e.g.
  `Sensors, motor_*`: from the root if they start with `/`, else at any depth), and the levels,
  filter and view it opens with. The server follows the diagnostics for every page, and for 10
  minutes after the last page closes, keeping the latest status of each name and their latest
  1,000 changes of level.
- **ROS Monitor** lists the topics (`ros2 topic list -v`: their types, publishers and
  subscribers), the services and the actions (with the nodes serving and using them, asked node
  by node as `ros2 action info` does), read again every 2 s. The filter keeps those whose name or
  type contain any of its terms, separated by `;` (`ros2 topic find`), or match a regular
  expression; the eye shows the hidden ones: names with a part starting with `_` (an action's
  topics and services), and every node's parameter services. A topic, service or action clicked
  shows its details in tabs, beside the list or under it; the arrow keys go through the list. The
  widget's properties set the sheet and filter it opens with, and a topic, service or action to
  open (one widget for `/odom`'s messages).

  A topic's **Echo** shows its messages as `ros2 topic echo` prints them, folding: the latest,
  at most 10 a second, or only a *field* of them (`pose.position`, `ranges[0]`); lists and
  strings longer than the widget's *length* are cut (`--truncate-length`), NaN and infinities
  written `.nan`, `.inf`. Pausing keeps the latest 100 to go back through. Copy writes a message
  as YAML; the pencil edits it in the Publish tab. **Rate** shows, over the latest messages (the
  *window*, `--window`), their rate and the spread of the intervals between them (`ros2 topic
  hz`), their bandwidth and sizes, serialized (`ros2 topic bw`), and for messages with a header,
  the delay from its stamp to their arrival on the ROS clock (`ros2 topic delay`). The server
  takes the messages serialized: their sizes are exact, the stamps read from their bytes, and
  only those shown are deserialized. **Info** lists the publishers and subscriptions with their
  QoS (`ros2 topic info -v`), the dashboard's own named so, and says which do not talk and why: a
  best effort publisher and a reliable subscription, a volatile publisher and a transient local
  (latched) one, deadlines and liveliness that do not match, other types. **Publish** fills in a
  message field by field, made from its type's definition (lists of numbers on a line, nested
  messages folding, constants suggested), or as JSON; a time may be *now*, made the time of each
  message as `ros2 topic pub` does (`"now"` in JSON, `"auto"` for a header). It is published
  once, or at a rate, a number of times or until stopped (`-r`, `-t`), with its QoS: by default
  reliable, and transient local if one of the topic's subscriptions is, which every subscription
  matches. A new publisher waits up to a second for the subscriptions to match it, as a first
  message would be lost. Publishing goes on while other topics are shown, until stopped from the
  status line or the widget goes. **Type** shows the type's definition as `ros2 interface show`
  prints it.

  A service's **Call** fills in its request as Publish does a message, and calls it once or at
  a rate (`ros2 service call -r`), with a timeout, showing its response and how long it took.
  **Echo** shows its requests and responses as they go (`ros2 service echo`), when its node
  introspects them: since Jazzy, with `configure_introspection`. An action's **Goals** are those
  its servers have, whoever sent them, from its status topic, with the latest feedback of each:
  what Nav2 is doing, goals sent from RViz included. Those sent from the dashboard have their
  result too. Any goal is canceled with its button, all of them with *Cancel all*. **Send** fills
  in a goal and sends it (`ros2 action send_goal -f`), following it to its result. The server
  follows an action for the pages, and for 10 minutes after the last one: a page opened later
  finds the goals sent and their results. **Info** lists the nodes serving and using a service
  or an action (`ros2 service info`, `ros2 action info`).

  Messages, requests and goals are made from rclnodejs's code of their types, which Tassello
  makes when it starts for the workspaces sourced (see Install).
- **Parameters** lists the nodes of the graph (but the hidden ones, as `ros2 node list` does), or
  shows one node only, its *node* (a panel to tune `/controller_server`). A node's parameters are
  read through its parameter services (`rcl_interfaces`), grouped by the prefixes of their names
  (the groups of read-only parameters only, such as `qos_overrides`, folded), and filtered by name
  or description. Each is edited with its type's editor: a switch for a boolean, a slider and a
  field for a number with a range, a field for the others (lists' items separated by commas),
  applied on Enter or when left; what the node refuses (out of its range, of another type, read
  only) is said under it, with the node's reason, and the value goes back. Changes made elsewhere
  (`ros2 param set`, the node itself) show as they come: the server follows `/parameter_events`.
  A parameter's details give its description, type, range and constraints, copy its value or its
  `ros2 param set` command, and delete it (`ros2 param delete`, which only undeclared parameters
  allow). *Add* sets a parameter the node did not declare, which nodes allow only if they say so;
  its type is read from its value as `ros2 param set` reads it (`[1, 2.5]`: doubles), or chosen.
  *Dump* writes the YAML `ros2 param dump` writes, downloaded, saved on the robot or copied; *Load*
  reads a parameter file of the robot or of the page's device as `ros2 param load` does (the
  node's section, and the `/**` one) and sets its parameters one by one, saying which the node
  refused and why. Parameter files are read and written by Python's yaml, as `ros2 param` does. A
  widget can be *view only*.
- **Rosbags** lists the bags of its *folder* (`~/bags` by default; the toolbar browses for
  another): its folders holding a bag, and its lone `.mcap` and `.db3` files, the newest first,
  read again every 2 s while shown. What a bag holds is read from its `metadata.yaml` (Humble's
  and Jazzy's); a bag without it (its recording killed) from its files: MCAP's summary, SQLite's
  tables (up to 64 MB), and it says so (`ros2 bag reindex` makes the metadata). A bag's details
  give its path, its time span, its files, and its topics with their types, counts and rates.
  *Download* sends a folder as a `.tar.gz`, a file as it is; *Delete* deletes bags only, a folder
  holding anything else than a bag's files being refused (the File Manager deletes those).
  *Record* runs `ros2 bag record` into a new folder (`<folder>/rosbag2_<date>_<time>`): the
  topics chosen from the graph (the widget's *topics to record* chosen first, others typed in),
  or all of them, and those matching a regular expression, but those matching another. Its
  *Advanced* options are `ros2 bag record`'s: the storage (the distribution's default, MCAP or
  SQLite, as `ros2 bag list storage` lists them) and its preset (MCAP's `fastwrite`, `zstd_fast`,
  `zstd_small`, SQLite's `resilient`), a new file at a size or a duration (`-b`, `-d`), the
  compression of each file or of each message and its format (`ros2 bag list compressor`: zstd;
  MCAP compresses its chunks with its presets instead, each message is refused), the cache, the
  hidden topics and sim time. The page remembers them for the next recording, the behavior tree
  inspector's too. Recordings show above the bags with their time and size, stopped as Ctrl+C
  stops them, which completes the bag; the server stops them too when it stops. *Play* runs
  `ros2 bag play`, one bag at a time: its messages published again on the robot's topics, at a
  rate, looped, from an offset, some topics only, `/clock` published or not, started paused.
  Pause, seek and the rate go through the player's services (`/rosbag2_player/…`); where it is
  is the server's reckoning from them. A widget can be *view only*.
- **File Manager** opens its *folder* (`~` by default; `/…`, `~/…`, `package://…`) and lists it
  with its entries' sizes and times, sorted by name (naturally: `run_2` before `run_10`), size or
  time, folders first; the chevrons unfold folders in place. Its places are home, the root, the
  ROS installations and workspaces sourced (`AMENT_PREFIX_PATH`), its *bookmarks* (the widget's,
  and those made in the page, kept by the browser) and the disks, with their free space. Click to
  select (Ctrl, Shift: several), double click (on touch screens tap) to open: folders, text files
  into the editor, images (PNG, JPEG, SVG…, and PGM maps, converted on the robot) into a viewer.
  Right click, or the ⋯ of a row, for the rest: download (a folder, or several entries, as one
  `.tar.gz`), cut, copy and paste (between file managers too), duplicate, move or copy to a folder
  picked, rename (F2, in place), copy the path, details, delete (there is no trash: it asks
  first). Drag entries onto a folder, a place or the address bar's folders to move them (Ctrl:
  copy them); drop files or folders from the computer to upload them, with their progress. Where
  names are taken, it asks: replace, keep both (`map (2).yaml`) or skip. *Details* show an entry's
  kind, size (a folder's computed on demand), times, owner, mode, link and disk, an image's
  preview, and change its permissions; *what takes the space* shows the disks (size, use, free
  space, inodes when short) and analyzes the folder: its largest entries, its files by type, the
  largest and the latest files under it, on its disk only, for 15 s at most. Keys: the arrows
  (Left and Right fold), Enter, Backspace, Alt+arrows (up, back, forward), Delete, F2, Ctrl+A,
  Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+F (filter), Ctrl+L (type a path), Ctrl+H (hidden files), and typing
  a name's first letters.

  Text files (UTF-8, 5 MB at most) open in tabs, edited as with gedit: line numbers, the line of
  the cursor lit, syntax highlighting (YAML, XML for URDF, xacro, launch and SDF, Python, C and
  C++, CMake, JSON, shell, INI, TOML and systemd units, Markdown, ROS interfaces), search and
  replace (case, whole words, regular expressions with `$1`), Tab and Shift+Tab indenting the lines
  selected, new lines indented as the one before, Ctrl+/ commenting lines out, go to line (Ctrl+I),
  undo and redo a word at a time, long lines wrapped on demand (then not highlighted). The status
  line shows the cursor's line and column, and switches the highlighting, the indentation and the
  line ends (kept as the file has them, LF or CRLF). As the behavior tree editor, it saves only
  over the version read: a file changed on the robot is shown at once without changes in the
  editor, with changes the editor asks which to keep, and a save over a file changed since it was
  read is refused. *Save as* writes elsewhere, e.g. a file the server's user cannot write. Changes
  are kept while the page is open, and the page asks before closing with changes not saved.

  The folders shown and the files open are read again every 3 s. A widget can *stay in its
  folder* (e.g. one for the maps, or the rosbags) or be *read-only*: these are the page's choices,
  not a protection (see Security).
- **Terminal** runs the login shell of the server's user (`$SHELL -l`, as SSH does: its
  `~/.bashrc` and the ROS setup Tassello was started with), or the widget's *command* through it,
  in its *folder* (`~` by default; `/…`, `~/…`, `package://…`), on a pseudo-terminal of its own:
  `TERM=xterm-256color`, true colour, full screen programs (vim, htop, less) and their mouse. A
  terminal belongs to the browser's tab: reloading the page, losing the connection or showing
  another panel and coming back finds it as it was, what it printed meanwhile included, screens of
  full screen programs too. A terminal no page shows is hung up after an hour (its programs get
  SIGHUP, as when a terminal window is closed), as is the one unseen the longest when 16 are open:
  for jobs that should outlive it, `tmux` or `nohup`. A *command* such as `tmux new -A -s robot` gives every page, and every
  device, the same session. When the program ends, Enter or *Restart* starts it again; *Restart*
  also hangs up a program that hangs. Changing the widget's command or folder starts it anew.

  Copy with Ctrl+C while text is selected (it interrupts otherwise) or Ctrl+Shift+C, paste with
  Ctrl+Shift+V or the toolbar's button (pages served over http cannot read the clipboard: it opens
  a box to paste into, on phones too). The toolbar changes the size of the text for this device, as
  pinching does, and fills the window with the terminal.

  On touch screens (or always, or never: *Extra keys*) the keys phones lack are under the
  terminal, as Termux has them: Esc, `/`, `-`, Home, ↑, End, Page Up, then Tab, Ctrl, Alt, ←, ↓,
  →, Page Down. Tapped, they type without closing the on-screen keyboard. Ctrl, Alt and Shift
  apply to the next key, of the row or of the keyboard (Ctrl, then `c`: interrupt); tapped twice,
  or held, they stay until tapped again. Swiping up on a key, or holding it, types what its corner
  shows (`\`, `|`, `~`); the arrows repeat while held. Their *layout* is a property: a line per
  row, keys by name (`ESC TAB CTRL ALT SHIFT HOME END PGUP PGDN UP DOWN LEFT RIGHT INS DEL BKSP
  ENTER SPACE F1`…`F12 KEYBOARD PASTE`) or what they type (`~`, `|`, `ros2`), what swiping up
  types after a colon (`-:|`). While the on-screen keyboard is open, the terminal fills the screen
  above it, the keys right above the keyboard (*Full screen while typing*). One finger scrolls (the
  scrollback, or the program: less, htop), flung or not; two pinch the text's size.
- **Networking** changes the networks through NetworkManager (`nmcli`), which Ubuntu runs (a
  robot whose netplan renders with systemd-networkd shows its interfaces as not managed). Its
  **Wi-Fi** view lists the networks in range of each Wi-Fi interface, the one connected to first,
  then those saved, then by signal. *Join* asks for the password (WPA and WPA2 Personal, WPA3
  Personal, WEP, and WPA Enterprise with PEAP and MSCHAPv2), *Connect* uses the one saved, and
  asks for it again if it is found wrong; *Join a hidden network…* looks for one by name. *New
  access point…* makes the robot a Wi-Fi network of its own: WPA2 with a password made for it,
  2.4 or 5 GHz, a channel, the robot's address on it (10.42.0.1 if not given), giving addresses to
  who joins (NetworkManager's shared mode, with `dnsmasq-base`). *Start automatically* makes it
  the robot's network from when it starts, wherever it is. *Share…* shows a network's name and
  password, and the QR code phones join it by. The **Saved** view lists the connections saved, by
  kind (Wi-Fi networks, access points, wired, VPN), the active then the latest used first: connect
  and disconnect them, edit them (their name, password, interface, IPv4: DHCP, static with a
  gateway and DNS servers, shared or disabled, whether they connect by themselves and with which
  priority) and forget them; *New wired connection…* gives a cable an address of its own, e.g. on
  a lidar's network. The **Interfaces** view shows each interface's state, addresses, gateway, DNS
  servers, MAC address and speed, and the connections it may connect with. A widget can be for
  some interfaces only (`wlan0, eth*`), or read-only. Those other programs configure (docker's
  bridges, VPN clients' tunnels) are left out, unless *Show every interface*.

  The server tells each page which interface it reaches the robot through: a change that would
  cut the page off (disconnecting that interface, switching its Wi-Fi to another network, making
  it an access point, turning Wi-Fi off) is asked about first, saying so. What is being done shows
  on every page, and how it ended, also to a page that lost the robot meanwhile: after switching
  networks, the robot is reached on the new one; if it could not join it, NetworkManager connects
  by itself to one of those saved that connect automatically. A Wi-Fi network or an access point
  that fails to start is not kept; a cable's waits for its cable.

  A desktop's NetworkManager lets the users of its session change the networks, not a service's:
  give the server's user the right with a polkit rule. On Ubuntu 22.04 (polkit 0.105),
  `/etc/polkit-1/localauthority/50-local.d/tassello-networking.pkla`, for the user `robot`:

  ```ini
  [Let the dashboard change the networks]
  Identity=unix-user:robot
  Action=org.freedesktop.NetworkManager.*
  ResultAny=yes
  ResultInactive=yes
  ResultActive=yes
  ```

  From Ubuntu 24.04 (and Debian 12), `/etc/polkit-1/rules.d/50-tassello-networking.rules`:

  ```js
  polkit.addRule(function (action, subject) {
    if (action.id.indexOf('org.freedesktop.NetworkManager.') === 0 && subject.user === 'robot') {
      return polkit.Result.YES;
    }
  });
  ```

  Without it, the widget says the networks cannot be changed. *Share…* reads the passwords with
  `nmcli --show-secrets`, which needs the same right; those a desktop's keyring keeps cannot be
  read.
- **System Monitor** reads `/proc` and `/sys` every second, for every page at once, while one
  shows it, and keeps the last 5 minutes for the charts (a page opened later has them at once).
  The temperatures are the kernel's thermal zones and its hwmon chips' sensors (the chips that
  are a thermal zone again, once), grouped by chip with the hottest of each; a sensor is hot from
  its own limits (else 80 °C), and critical at its own critical (else 95 °C). A **Raspberry Pi**'s
  throttling is its firmware's (`get_throttled` in `/sys`, else `vcgencmd get_throttled`): under-
  voltage, frequency capped, throttled, soft temperature limit, now and since boot. A **Jetson**'s
  GPU is devfreq's (its load and clock), its power the INA3221's rails (`VDD_IN` the whole
  board's), its L4T release and power mode (`nvpmodel -q`) are shown with the board. NVIDIA's
  GPUs are read with `nvidia-smi` every 2 s, AMD's from amdgpu's files; an Intel CPU's package
  power from RAPL, if its counters are readable (root's only, since Linux 5.10). Cores taken
  offline (a Jetson's power modes) show as such. The disks are the whole ones (not partitions,
  loop devices, device mapper or RAID), their space the File Manager's; the networks are the
  device's own interfaces (not docker's bridges, VPN clients' tunnels: their traffic is the
  devices' too), or those of its *interfaces* (`wlan0, tun*`). Each section can be hidden.

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

Tassello has no login. **Anyone who can open the page can drive the robot, publish on any topic,
call any service and send or cancel any goal (the ROS Monitor), change any node's parameters
(Parameters), record, play and delete rosbags (Rosbags), run any command as
the server's user (the Terminal, a shell), read, write, upload, move and delete any of the
files that user can (the File Manager), and change the robot's networks and read their passwords
(Networking)**: keep it on a network you trust, or behind a reverse proxy
with authentication (it serves everything under `/`, its WebSocket at `/ws`). Changes to the files
are accepted from the dashboard's own pages only (they send a header that another site's page
cannot), and the root, the home folder and the system's top folders (`/usr`, `/etc`…) are never
deleted nor moved. Terminals open, networks change and rosbags are deleted from the dashboard's
own pages only too: those whose origin is the host they reached (the `Host` header, or the
`X-Forwarded-Host` a reverse proxy sets), which another site's page cannot pretend.

## How it works

```
 browser ── HTTP: page, /api (panels, topics, files), /plugins ────┐
         └─ WebSocket /ws: twists, poses, images, maps, TF, ───────┤
                           topics, services, commands, plugins     └─ server (Node.js, one ROS node)
                                                                        ├─ rclnodejs: ROS
                                                                        ├─ sharp: raw images to JPEG, maps to PNG
                                                                        ├─ bash: the buttons' commands
                                                                        ├─ python3: the terminals' pseudo-terminals
                                                                        ├─ nmcli: the networks (NetworkManager)
                                                                        ├─ ros2 bag: rosbags recorded and played
                                                                        ├─ /proc, /sys, nvidia-smi: the system monitor
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
- Diagnostics are followed once for every page: each gets the statuses that changed, at most 4
  times a second, not those received the same again. Subscribed best effort, they come from
  every publisher, whatever its QoS.
- A button runs the command saved in its panel, never one sent by the page.
- A terminal's pseudo-terminal is opened by a few lines of Python (ROS 2's own), no native module
  to build. Its output is also played on a terminal of the server's own (xterm.js, headless), which
  paces the program, never the pages: a page gets at most 256 KB ahead of what it has drawn, and a
  page further behind (a slow phone, a hidden tab, a flood of output) gets the screen as it is
  instead of all that led to it. A page that reconnects gets what it missed, from the last 1 MB.
- The networks are read once for every page: again as soon as `nmcli monitor` reports a change,
  and every 3 s for the signals of the Wi-Fi networks in range, which are scanned for when a page
  opens the widget (at most every 30 s) or asks. Passwords are on `nmcli`'s command line only for
  the moment it takes to save them, activating a connection being another command.
- Rosbags are recorded and played by `ros2 bag`, the robot's own, as children of the server:
  one recording per folder, for every page (the behavior tree inspectors' among them), one
  playback. A folder of bags is read once for every page showing it, every 2 s, a bag's metadata
  again only when its files change; the recordings' sizes every second.
- The system monitor's sensors are read once for every page, every second while one watches and
  for 30 s after the last leaves; they are looked for again every 30 s (USB ones come and go).
  Each page gets a sample a second, about 4 KB.
- The File Manager's folders are read again every 3 s, and answered "unchanged" while they are;
  the largest are listed in part (5,000 entries), and only the rows in sight are drawn. Uploads
  and downloads are streamed, folders archived by `tar` as they are sent; saves replace files at
  once (a temporary file renamed over them).

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
