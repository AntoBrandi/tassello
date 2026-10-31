# Writing a Tassello plugin

A plugin extends any Tassello with:

- **widgets**: React components with properties the editor shows, added to the palette;
- **status widgets**: readings at a glance in the panels' status bars, e.g. a battery's charge;
- **displays** of the Robot Viewer, as RViz's display plugins: a kind of thing drawn in 3D, e.g.
  a robot's own messages, with properties people edit in the viewer's list of displays;
- a **server side**, if they need one: code running in Tassello's server on the robot, with its
  ROS node, answering the widgets' requests and streaming them data;
- **defaults** for any widget's or display's properties, e.g. a robot's topic names and speed
  limits;
- **example panels**, copied into a new panels directory.

Many widgets need no server side at all: from the page, a widget can subscribe to any topic,
publish on any topic, call any service and follow TF.

## Start

```bash
tassello create-plugin my-robot
cd my-robot
npm install
npm run build
tassello --plugin .
```

Edit a panel, **Add widget**: the plugin's widgets have a section of their own. After a change,
`npm run build` and reload the page; restart Tassello for a change of the server side.

The plugin is an npm package:

```text
my-robot/
├── package.json         its manifest, the "tassello" field
├── vite.config.ts       builds the page's side with tassello/vite
├── src/client/index.tsx the page's side: definePlugin({ widgets })
├── src/client/style.css its styles
└── src/server/index.ts  the server's side: { activate(ctx) }
```

```json
{
  "name": "tassello-plugin-my-robot",
  "type": "module",
  "tassello": {
    "client": "dist/client/index.js",
    "styles": ["dist/client/index.css"],
    "server": "dist/server/index.js",
    "panels": "panels"
  }
}
```

All four fields are optional. `client` is an ES module, and its whole folder is served (for its
chunks and assets); `styles` must be in that folder. `server` is an ES module Node.js imports:
JavaScript when the plugin is installed in `node_modules`, where Node.js does not run TypeScript;
TypeScript elsewhere is fine with Node.js ≥ 22.18. `panels` is a folder of example panels: panel
files as **Export panel** saves them, their status bar included (`statusBar`: each status
widget's `id`, `type`, `x` and `w` in columns, and `config`; without an `x`, a status widget goes
after the one before it).

The package's `name` is the plugin's name: its widgets address its server side by it.

## The page's side

```tsx
import { definePlugin, defineWidget, PowerIcon, useTopic, type WidgetProps } from 'tassello/sdk';

interface BatteryConfig {
  topic: string;
  warnBelow: number;
}

function Battery({ config }: WidgetProps<BatteryConfig>) {
  const { message } = useTopic<{ percentage: number }>(config.topic);
  if (!message) {
    return <div className="widget-message">Waiting for {config.topic}…</div>;
  }
  const percent = Math.round(message.percentage * 100);
  return <div className={percent < config.warnBelow ? 'battery low' : 'battery'}>{percent} %</div>;
}

export default definePlugin({
  widgets: [
    defineWidget<BatteryConfig>({
      type: 'my-robot.battery',
      name: 'Battery',
      description: 'The charge left',
      icon: PowerIcon,
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 2, h: 1 },
      component: Battery,
      properties: [
        { key: 'topic', label: 'Topic', kind: 'topic', default: '/battery_state', topicTypes: ['sensor_msgs/msg/BatteryState'] },
        { key: 'warnBelow', label: 'Warn below (%)', kind: 'number', default: 20, min: 0, max: 100 },
      ],
    }),
  ],
});
```

`tassello/sdk` is not bundled into the plugin: the page provides it at run time, with React,
through its import map, so that the plugin shares the page's connection, dialogs and React.
`tassello/vite` builds the plugin that way; its types come from the `tassello` package, a
development dependency of the plugin.

### Widgets

`defineWidget<Config>({...})` checks the definition against the widget's config type:

| Field | |
|---|---|
| `type` | Stored in the panels: **never change it**. Prefix it with the plugin's own name, e.g. `my-robot.battery`, as types must be unique |
| `name`, `description`, `icon` | Shown in the palette |
| `defaultSize`, `minSize` | In grid cells (64 px on a desktop) |
| `properties` | Edited in the side panel, see below |
| `component` | The React component, given `WidgetProps<Config>` |
| `migrate` | Optional: upgrades a config saved by an earlier version of the widget, before its properties are read from it, e.g. properties renamed: `(stored) => stored` |

The component receives:

| Prop | |
|---|---|
| `config` | Every property's value: the panel's, or the default |
| `instance` | The widget in its panel: `id`, `type`, `title`, position and size |
| `panelId` | The panel's id |
| `editing` | Edit mode: the widget is shown, not used. Disable its controls |
| `updateConfig(changes)` | Changes some of its properties, saved with the panel as the side panel's changes are: what people choose in the widget itself (the Plot's series) |

A widget fills its cell (`height: 100%` works). A widget that throws shows its error instead of
breaking the board.

### Status widgets

Each panel has a status bar above its board: status widgets in a row, each one reading at a
glance. A status widget is defined as a widget is, with `defineStatusWidget`, and
listed in the plugin's `statusWidgets`:

```tsx
import { BoltIcon, definePlugin, defineStatusWidget, StatusReadout, useTopic, type StatusWidgetProps } from 'tassello/sdk';

interface BatteryStatusConfig {
  topic: string;
  warnBelow: number;
}

function BatteryStatus({ config }: StatusWidgetProps<BatteryStatusConfig>) {
  const { message } = useTopic<{ percentage: number; power_supply_status: number }>(config.topic, 1);
  if (!message) {
    return <StatusReadout icon={<BoltIcon />} value="…" tone="off" title={`Waiting for ${config.topic}`} />;
  }
  const percent = Math.round(message.percentage * 100);
  return (
    <StatusReadout
      icon={<BoltIcon />}
      value={`${percent}%`}
      label={message.power_supply_status === 1 ? 'Charging' : null}
      tone={percent < config.warnBelow ? 'critical' : 'ok'}
      title={`Battery ${percent}%`}
    />
  );
}

export default definePlugin({
  statusWidgets: [
    defineStatusWidget<BatteryStatusConfig>({
      type: 'my-robot.battery-status',
      name: 'Battery',
      description: 'The charge left',
      icon: BoltIcon,
      defaultWidth: 3,
      minWidth: 1,
      component: BatteryStatus,
      properties: [
        { key: 'topic', label: 'Topic', kind: 'topic', default: '/battery_state', topicTypes: ['sensor_msgs/msg/BatteryState'] },
        { key: 'warnBelow', label: 'Warn below (%)', kind: 'number', default: 20, min: 0, max: 100 },
      ],
    }),
  ],
});
```

| Field | |
|---|---|
| `type` | Stored in the panels' status bars: **never change it**. Prefixed with the plugin's name, and no widget's type: types are unique across both, as the defaults are by type |
| `name`, `description`, `icon` | Shown in the status bar's palette (**＋ Status**) |
| `defaultWidth`, `minWidth` | In the bar's columns: `STATUS_COLUMNS` (24) across its width, whatever the screen's. People place and resize status widgets as widgets on the board |
| `properties` | Edited in the side panel, as a widget's |
| `component` | The React component, given `StatusWidgetProps<Config>`: `config`, `instance` (`id`, `type`, `x` and `w`: its place and width in columns), `editing`, `updateConfig(changes)` |

The bar is 30 px tall. `StatusReadout` lays out what a status widget shows, as Tassello's own:
an `icon`, a `value`, a `label` after it and `children` filling the rest (a chart), coloured by
its `tone` (`'ok'`, `'warn'`, `'critical'`, `'off'` when there is nothing to show), with the
details in its `title`, shown by the pointer. It shows what fits the width, which changes with
the screen's: under 50 px the icon (or the value, with `narrow: 'value'`), under 96 px the icon
and the value, then the label too, and from 130 px the rest.

### Displays of the Robot Viewer

The Robot Viewer draws, in 3D or from above in 2D, a list of *displays*, as RViz does: each a kind
of thing (the robot model, TF, a map, a laser scan, a point cloud), with its own properties,
placed in the viewer's fixed frame by TF. People add displays to a viewer from those registered,
Tassello's and the plugins', in its side panel, where they edit their properties as a widget's.

A display is a class extending `Display`, of `tassello/viewer`, drawing with three.js. It is
registered by a definition, `defineDisplay`, listed in the plugin's `displays`: the definition
is in the plugin's module, the class in a module of its own, which the definition loads.
three.js is large: the page fetches it, and the class, only when a viewer shows the display.

```ts
// src/client/index.tsx
import { definePlugin, defineDisplay, FlagIcon } from 'tassello/sdk';

export interface GoalConfig {
  topic: string;
  color: string;
  length: number;
}

export default definePlugin({
  displays: [
    defineDisplay<GoalConfig>({
      type: 'my-robot.goal-display',
      name: 'Goal',
      description: 'The goal the robot drives to, as an arrow',
      icon: FlagIcon,
      properties: [
        { key: 'topic', label: 'Topic', kind: 'topic', default: '/goal_pose', topicTypes: ['geometry_msgs/msg/PoseStamped'] },
        { key: 'color', label: 'Colour', kind: 'color', default: '#a855f7' },
        { key: 'length', label: 'Length (m)', kind: 'number', default: 0.6, min: 0.05, step: 0.05 },
      ],
      load: () => import('./GoalDisplay.ts').then((m) => m.GoalDisplay),
    }),
  ],
});
```

```ts
// src/client/GoalDisplay.ts
import { ArrowHelper, Color, Group, Quaternion, Vector3 } from 'three';
import { Display, type DisplayContext } from 'tassello/viewer';

import type { GoalConfig } from './index.tsx';

interface PoseStamped {
  header: { frame_id: string };
  pose: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } };
}

export class GoalDisplay extends Display<GoalConfig> {
  // Placed by TF where the goal's frame is; the arrow, in it, where the goal is
  private readonly frame = new Group();
  private readonly arrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(), 0.6);
  private unsubscribe: (() => void) | null = null;

  constructor(context: DisplayContext) {
    super(context);
    this.arrow.visible = false;
    this.frame.add(this.arrow);
    this.root.add(this.frame);
  }

  configure(config: GoalConfig, previous: GoalConfig | null): void {
    this.arrow.setColor(new Color(config.color));
    this.arrow.setLength(config.length, config.length * 0.3, config.length * 0.15);
    if (config.topic !== previous?.topic) {
      this.unsubscribe?.();
      this.setStatus('waiting', `Waiting for ${config.topic}`);
      this.unsubscribe = this.subscribeTopic<PoseStamped>(config.topic, { types: ['geometry_msgs/msg/PoseStamped'] }, (goal) => {
        const { position: p, orientation: q } = goal.pose;
        this.arrow.position.set(p.x, p.y, p.z);
        this.arrow.quaternion.copy(new Quaternion(q.x, q.y, q.z, q.w));
        this.arrow.visible = true;
        this.attach(this.frame, goal.header.frame_id);
      });
    }
    this.render();
  }
}
```

| Field of `defineDisplay` | |
|---|---|
| `type` | Stored in the panels' viewers: **never change it**. Prefixed with the plugin's name; types are unique across widgets, status widgets and displays, as the defaults are by type |
| `name`, `description`, `icon` | Shown in the viewer's list of displays and in **Add a display** |
| `properties` | Edited in the list, when the display is opened, as a widget's (see Properties) |
| `load` | Resolves with the class: `() => import('./MyDisplay.ts').then((m) => m.MyDisplay)` |

A display puts its three.js objects in its `root`, which is in the fixed frame, with ROS's axes
(x forward, y left, z up, meters). The viewer calls:

| Method | When |
|---|---|
| `constructor(context)` | Created, when a viewer shows it (and calls `super(context)`) |
| `configure(config, previous)` | With its properties' values: first (`previous` is `null`), then whenever they change. Subscribe, or subscribe again, and draw |
| `onTransforms()` | The frames' poses were updated, about 15 times a second (objects attached are already placed) |
| `onFixedFrameChange()` | The fixed frame changed: ask again for what was placed in the former (`connection.subscribePoints`) |
| `onViewChange()` | The view changed between 3D and 2D (`context.view`) |
| `focus()` | What **Reset** fits, if anything: the robot model returns the robot |
| `dispose()` | It goes (hidden, removed, its viewer closed): free what is neither in `root` nor tracked, e.g. timers. The viewer frees `root` and what is in it (geometries, materials, textures, labels' elements) and the subscriptions tracked |

What it is given, as protected members:

| | |
|---|---|
| `this.root` | Its `Group`, in the fixed frame |
| `this.connection` | The page's connection (see The robot) |
| `this.fixedFrame` | The frame the view is in |
| `this.pose(frame)` | The frame's pose in the fixed frame (`{ position, quaternion }`), `null` if TF does not connect them |
| `this.place(object, frame)` | Puts the object at the frame's pose now; `false` if unknown |
| `this.attach(object, frame)` | Keeps the object at the frame's pose as TF updates it, hidden while unknown: offsets go in its children. Returns what detaches it |
| `this.subscribeTopic(topic, { maxRate, types, status }, onMessage)` | A topic's messages, as JSON, until the returned function is called or the display goes; its status (waiting, wrong type, ok) is the display's unless `status: false` |
| `this.setStatus(level, message)` | `'ok'`, `'waiting'`, `'warn'` or `'error'`: why it shows nothing, or something wrong. While no display shows anything, the viewer says the first one's in its middle; else in a note |
| `this.setNotes([{ text, tone }])` | Lines in the viewer's corner: `'info'` at the top right (what is loading), `'accent'` in the highlight colour, `'warn'` |
| `this.missingFrame(frame)` | Why a frame has no pose, for a status |
| `this.render()` | Draws the view again, after changing objects: it is drawn on demand |
| `this.context` | The rest: `frames` (every TF frame: `name`, `parent`, `pose`, `ageMs`), `view`, `scale` (the robot's radius, which helpers are sized after), `pixelRatio`, `track(cleanup)` (called when the display goes), `fit()`, `suggestFixedFrame(frame)` (what Auto stands for: the robot model's root link) |

A display that throws shows its error in the viewer; the others carry on.

`tassello/viewer` also has what Tassello's displays are made of: `PointsLayer` (points, coloured by
intensity, height or their own colours, as the Laser Scan and Point Cloud displays draw them),
`rainbow` (RViz's colour scale), `loadRobot` (a URDF and its meshes), and the displays themselves
(`RobotModelDisplay`, `TfDisplay`, `OccupancyGridDisplay`, `LaserScanDisplay`,
`PointCloudDisplay`, and `PointsDisplay` for points of another kind), to extend: a display
registered with `load: () => import('./MyCloud.ts').then((m) => m.MyCloud)`, where `MyCloud`
extends `PointCloudDisplay`, is a point cloud with something of its own.

`three` and `tassello/viewer` are not bundled into the plugin: the page provides them, as it does
`tassello/sdk`, so that the viewer's renderer draws the plugin's objects. Add `three` and
`@types/three` as development dependencies, of the version Tassello has (`npm ls three` in
Tassello: 0.186), for the types; three.js's addons (`three/examples/jsm/...`) are bundled into
the plugin, and use the page's three. `tassello/vite` builds the plugin that way, the classes'
modules as chunks of their own next to its module.

### Properties

Each property has a `key` in the config, a `label`, a `default` (which stands in for missing or
mistyped values, so properties can be added without touching the saved panels), an optional
`help`, and an optional `visible(config)` to hide it when it does not apply. By kind:

| Kind | Value | Extra fields |
|---|---|---|
| `boolean` | `boolean` | |
| `number` | `number` | `min`, `max`, `step` |
| `string` | `string` | `placeholder` |
| `text` | `string`, multi-line, monospace: commands | `placeholder` |
| `color` | `string`, `#rrggbb` | |
| `topic` | `string`, a topic name, suggesting those of the ROS graph | `topicTypes`, e.g. `['sensor_msgs/msg/Image']` |
| `select` | one of the options' values | `options: [{ value, label }]` |
| `image` | `string`, an image of the robot or uploaded (see `imageUrl`) | `placeholder` |
| `behavior-tree` | `string`, a behavior tree's XML (BT.CPP's) of the robot, or uploaded | `placeholder` |
| `displays` | `DisplayInstance[]`, a list of Robot Viewer displays (`id`, `type`, `name`, `enabled`, `config`), edited as the Robot Viewer's | |

A `select`'s options can also be known only at run time, e.g. the robot's: `useOptions`, a hook
the properties panel calls, gives those, shown after `options`. Its values are then not checked
against the options, and a value among neither is kept (it may be one later, e.g. once fetched):

```ts
function useArms() {
  const [arms, setArms] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => connection.subscribePlugin('my-robot', 'arms', {}, { data: (data) => setArms(data as typeof arms) }), []);
  return arms;
}

{ key: 'arm', label: 'Arm', kind: 'select', default: '', options: [{ value: '', label: 'None' }], useOptions: useArms }
```

### The robot

`connection`, the page's connection to the server:

| | |
|---|---|
| `publish(topic, type, message)` | Publishes a message, e.g. `publish('/beep', 'std_msgs/msg/Empty', {})`. `false` if not connected |
| `callService(service, type, request, timeoutMs?, { checked? })` | Resolves with the response, e.g. `callService('/reset', 'std_srvs/srv/Trigger')`. Checked, the request is made from the service's definition: 64 bit integers from numbers or text, `"now"` for a time, `"auto"` for a header, and a field it has not is an error |
| `request(plugin, method, params?, timeoutMs?)` | Calls the plugin's server side (`ctx.handle`): resolves with what it returns, rejects with what it throws |
| `subscribePlugin(plugin, stream, params, { data, status? })` | Follows a stream of the plugin's server side (`ctx.stream`). Returns the unsubscribe function |
| `subscribeTopic({ topic, maxRate }, { message, status })` | Any topic's messages, as JSON. Returns the unsubscribe function |
| `subscribeTf({ targetFrame, sourceFrame, rate }, callback)` | A frame's 2D pose in another |
| `subscribeTfFrames({ fixedFrame, rate }, callback)` | Every TF frame (`TfFrame`: `name`, `parent`, `ageMs`) and its 3D pose in `fixedFrame` (`[x, y, z, qx, qy, qz, qw]`, `null` if not connected to it; none if `fixedFrame` is empty), `rate` times a second, and why there are none (`error`). Returns the unsubscribe function |
| `subscribePoints({ kind, topic, fixedFrame, maxPoints, channel, maxFps }, { points, status })` | A laser scan's (`kind: 'scan'`) or a point cloud's (`'cloud'`) points, thinned on the robot to at most `maxPoints`, in their frame, with each point's intensity or colour (`channel`: `'auto'`, `'intensity'`, `'rgb'`, `'none'`): `points(frame)` gets `positions` (x, y, z), `values` (intensities, 0-1 over `range`) or `colors` (r, g, b), and `info`: the frame, its pose in `fixedFrame` as the message arrived (`null`, and `error`, if TF could not place it), `count`. The next comes once the promise it returns settles, at most `maxFps` a second. Returns the unsubscribe function |
| `subscribeOverlay({ kind, topic, frame }, { overlay, status })` | A laser scan's points (`kind: 'scan'`, `sensor_msgs/msg/LaserScan`) or a footprint's polygon (`'footprint'`, `geometry_msgs/msg/PolygonStamped`), put in `frame` by TF as each arrives: `{ points, error }`, `points` as x0, y0, x1, y1, ... at most 5 times a second. Returns the unsubscribe function |
| `subscribeBehaviorTree({ topic, tree }, { tree, update, status, recording? })` | A behavior tree's log (`nav2_msgs/msg/BehaviorTreeLog`), on the tree of its XML file: its nodes, then their states and transitions as they change (see `src/shared/protocol.ts`) |
| `recordBehaviorTree(topic, path, options?)` | Records the log into a rosbag in the new folder `path`, with `ros2 bag record`'s options (`RecordOptions`, rosbag2's defaults if not given), or stops (`null`): resolves with the bag's folder |
| `subscribeBehaviorTreePlayback({ bag, topic, tree }, handlers)` | A rosbag's log played back, as `subscribeBehaviorTree` follows a live one, with `playback(state)`: returns `{ id, unsubscribe }` |
| `controlBehaviorTreePlayback(id, { playing?, speed?, time? })` | Plays, pauses, sets the speed of, or seeks the playback |
| `subscribeRosout({ topic }, { update, status })` | The ROS log (`rcl_interfaces/msg/Log`, `topic` usually `/rosout`): the messages the server keeps, then the new ones, and the nodes of the ROS graph (see `RosoutUpdate` in `src/shared/protocol.ts`). Returns the unsubscribe function |
| `subscribeDiagnostics({ topic }, { update, status })` | The robot's diagnostics (`diagnostic_msgs/msg/DiagnosticArray`, `topic` usually `/diagnostics` or `/diagnostics_agg`): the statuses the server keeps, the latest of each name, stale once no longer received, and their latest changes of level, then those that changed (see `DiagnosticsUpdate` in `src/shared/protocol.ts`). Returns the unsubscribe function |
| `subscribeBehaviorTreeFile({ path, libraries }, { file, models })` | A behavior tree's XML file: its text and version, again whenever it changes, and the node models it can use (Nav2's, its includes', the libraries') |
| `saveBehaviorTreeFile(path, text, base, create?)` | Saves a behavior tree's XML file if still of the version `base` (`null`: whatever it is), or as a new file: resolves with `{ version, conflict }` |
| `subscribeTerminal({ terminal, command, folder }, { output, exit, status, shown })` | A terminal on the robot, by a name of the page's choosing: the login shell, or `command`, in `folder`. Its output as it comes (`TerminalOutput`: written to a terminal emulator, then acknowledged), from what the page shows, which `shown()` gives on every connection: `{ cols, rows, started, offset }`. Returns `{ id, unsubscribe }`; the terminal lives on without the page, for an hour. The dashboard's own pages only |
| `terminalInput(id, data)` / `resizeTerminal(id, cols, rows)` | What is typed in the terminal; its size |
| `ackTerminal(id, started, offset)` | The page wrote the output up to `offset`: the server sends at most 256 KB ahead of it |
| `restartTerminal(id)` | Hangs up the terminal's program, and starts it again |
| `subscribeNetwork(callback, { scan? })` | The robot's networks, as NetworkManager has them: its interfaces, the connections saved, the Wi-Fi networks in range, what the server's user may change and what the pages are having done, again whenever that changes, and `via`, the interface the page reaches the robot through (see `NetworkUpdate` in `src/shared/protocol.ts`, `NetworkState` in `src/shared/networking.ts`). The networks in range are looked for if the last look is old, unless `scan` is `false` (a scan may slow the network down: for the network joined only, as the Wi-Fi status widget follows it). Returns the unsubscribe function |
| `networkAction(request)` | Changes them (`NetworkRequest`): `connect`, `disconnect`, `create` (a Wi-Fi network, an access point, a cable's: `NetworkSettings`), `modify`, `delete`, `wifi` (on or off), `rescan`; resolves once NetworkManager is done with `{ uuid, message }`, rejects with why not. `secrets` resolves with a Wi-Fi network's name and password (`NetworkSecrets`). The dashboard's own pages only |
| `subscribeGraph(callback)` | The ROS graph: its topics with their publishers and subscribers, its services and actions with the nodes serving and using them, its nodes (`GraphSnapshot` in `src/shared/monitor.ts`), again whenever it changes. Returns the unsubscribe function |
| `subscribeTopicInfo(topic, callback)` | A topic's publishers and subscriptions with their QoS, and those that cannot talk (`ros2 topic info -v`, `TopicDetails`) |
| `subscribeTopicMonitor({ topic, window, echo, samples }, { stats, echo, samples, status })` | A topic's rate, bandwidth and delay over its latest `window` messages (`ros2 topic hz`, `bw`, `delay`, `TopicStats`), and its messages if `echo` (`{ field, truncate }`), at most 10 a second: JSON, but for lists and strings cut, 64 bit integers beyond JavaScript's and NaN (see `TruncatedValue` and the like). With `samples`, fields' paths (`twist.twist.linear.x`, `effort[2]`), the numbers of every message at them, ten batches a second (`TopicSamples`: when each message came, and each field's numbers, `null` where it has none) |
| `publishTopic({ topic, messageType, message, rate, times, qos }, callback)` | Publishes as `ros2 topic pub`: once (`rate` 0), `times` times or until the returned function is called (`times` 0), the message made from its JSON as a checked call's request; the count published comes as it goes (`PublishState`) |
| `interfaceInfo(type)` | An interface's definition (`ros2 interface show`), the schemas of its messages and their default values (`InterfaceInfo`) |
| `subscribeAction({ action, actionType }, { goals, status })` | What an action's servers are doing: their goals, whoever sent them, with their status and latest feedback, and the results of those the dashboard sent (`ActionGoal`). Returns the unsubscribe function |
| `sendGoal(action, type, goal)` / `cancelGoal(action, type, goal)` | Sends a goal: resolves with its UUID once accepted. Cancels one by its UUID, or all of the action's (`null`), whoever sent them |
| `subscribeParameters(node, { update, status })` | A node's parameters (`ros2 param list`, `get`, `describe`: `ParamInfo` in `src/shared/parameters.ts`), all of them, then those that change, whoever sets them. Returns the unsubscribe function |
| `setParameters(node, [{ name, value }], atomically?)` | `ros2 param set` (`value`: `{ type, value }`, `ParamValue`); a value of type `not_set` deletes the parameter. Resolves with what the node says of each: `{ name, successful, reason }` |
| `dumpParameters(node)` / `loadParameters(node, yaml)` | `ros2 param dump`: resolves with the YAML. `ros2 param load`: the node's parameters in the YAML set, resolves with what the node says of each |
| `subscribeBags(folder, callback)` | The rosbags of a folder (`BagInfo` in `src/shared/rosbag.ts`: their metadata, topics, files, size), the robot's recordings and its playback, and what its rosbag2 offers (`BagsUpdate`), again whenever they change. Returns the unsubscribe function |
| `bagsAction(request)` | `BagsRequest`: `record` (`ros2 bag record`: topics, all of them or a regular expression, `RecordOptions`) resolves with the `Recording`; `stop` with the bag's folder; `delete` with the paths deleted (bags only, the dashboard's own pages only); `play` (`ros2 bag play`: rate, loop, topics, offset, `/clock`) with the `Playback`; `pause`, `resume`, `seek`, `rate` and `stop-playback` control it |
| `subscribeSystem(callback)` | The robot's computer (`SystemUpdate`): its description (`SystemInfo`) and the last 5 minutes' chart points (`TrendPoint`) first, then a `SystemSample` every second: the cores' load and frequencies, memory, temperatures, fans, a Raspberry Pi's throttling bits, GPUs, power rails, disks and networks (`src/shared/system.ts`), and the file systems' space when it changes. Returns the unsubscribe function |
| `serverNow()` | Now, on the robot's clock |

The robot's files, as the File Manager widget has them (its REST API, `/api/fs`, see
`src/shared/file_manager.ts`): `fsApi`. Reads resolve with what the server says, changes with
`{ paths, conflicts }`, and failures reject with an `ApiError`, which has the HTTP `status`.

| | |
|---|---|
| `fsApi.list(path, known?)` | A folder's entries (`FsListing`); `undefined` while still the `known` version, for polling |
| `fsApi.details(path)` | An entry's kind, size, times, owner, permissions, link and disk (`FsDetails`) |
| `fsApi.disks()` | The robot's file systems, their size and free space (`FsDisk[]`) |
| `fsApi.analyze(path)` | What takes a folder's space (`FsAnalysis`) |
| `fsApi.readText(path, stamp?)` / `fsApi.saveText(path, text, base, create?)` | A text file and its version; saved only if still of the version `base` (`null`: whatever it is), else `{ conflict: true }` |
| `fsApi.operate(operation)` | `mkdir`, `create`, `rename`, `move`, `copy`, `delete`, `chmod` (`FsOperation`). Moves and copies with `conflict: 'ask'` do nothing while names are taken, and say which |
| `fsApi.upload(folder, name, file, conflict, onProgress)` | Uploads a `Blob`: `{ result, abort }` |
| `fsApi.downloadUrl(paths)` / `fsApi.viewUrl(path)` | A file to download (folders, and several entries, as a `.tar.gz`); an image to show (PGM maps as PNG) |

Messages are JSON as rclnodejs has them: fields by name, numeric arrays as arrays, 64 bit
integers as numbers. Subscriptions survive reconnections: they are renewed when the page
reconnects. Requests and calls reject when the page is not connected.

Hooks:

| | |
|---|---|
| `useTopic<T>(topic, maxRate?)` | `{ message, messageType, status, error }`: the latest message |
| `useTf(targetFrame, sourceFrame, rate?)` | The latest transform, or `null` |
| `useTfFrames(fixedFrame?, rate?)` | Every TF frame, as `subscribeTfFrames` gives them, or `null` |
| `useConnectionStatus()` | `'connecting'`, `'open'` or `'closed'` |
| `useCommandState(panelId, widgetId)` | The state of a command widget's command, see below |

### The page

| | |
|---|---|
| `useDialogs()` | `confirm({ title, message, confirmLabel, danger })` and `prompt({ title, label, initial })`, as promises |
| `notify(message, kind?)` | A short message at the bottom of the page; `kind` `'info'` or `'error'` |
| `Modal` | The page's modal dialog |
| `Joystick` | The teleop's pad: `axes` (`'xy'`, `'x'`, `'y'`), `onMove(x, y)` in -1..1 |
| `imageUrl(value)` | The URL of an `image` property's value |
| `*Icon` | Tassello's icons, 24×24 line drawings in the current colour |

### Styles

The plugin's stylesheets load after the page's. Use the page's classes, e.g. `button`,
`button primary`, `icon-button`, `widget-message` (a centred message, `error` in red), and its
colours: `var(--accent)`, `var(--text)`, `var(--text-muted)`, `var(--surface)`,
`var(--surface-2)`, `var(--border)`, `var(--danger)`, which follow the light and dark themes.
Prefix the plugin's own classes: they apply to the whole page.

### Defaults

A plugin can change the defaults of any widget's properties, Tassello's or another plugin's, of
any status widget's (`'wifi-status'`, `'cpu-status'`), and of any display's
(`'robot-model-display'`, `'tf-display'`, `'grid-display'`, `'laser-scan-display'`,
`'point-cloud-display'`).
They stand in for the values a panel does not set, so a robot's plugin makes Tassello's widgets
work for the robot out of the box:

```ts
export default definePlugin({
  widgets: [...],
  defaults: {
    teleop: { topic: '/my_robot/cmd_vel', maxLinear: 0.3, maxAngular: 1 },
    'arm-teleop': { controllers: 'arm_controller gripper_controller', link: 'gripper_link' },
    applications: { services: 'my-robot' },
    'robot-model-display': { descriptionTopic: '/my_robot/robot_description' },
    'laser-scan-display': { topic: '/my_robot/scan' },
  },
});
```

The Robot Viewer's own (its type is `'robot-model'`, the Robot Model widget's, which it replaced)
are `fixedFrame`, `view` (`'3d'` or `'2d'`) and `displays`: a robot's plugin can give new viewers
its own list, e.g. with its cameras' point clouds.

A default of the wrong type, or for a property the widget does not have, is reported in the page.

## The server's side

```ts
import type { TasselloPlugin } from 'tassello/server';

export default {
  activate(ctx) {
    const client = ctx.node.createClient('std_srvs/srv/Trigger', '/dock');

    ctx.handle('dock', async () => {
      if (!(await client.waitForService(1000))) {
        throw new Error('The docking server is not running');
      }
      return client.sendRequestAsync({});
    });

    ctx.stream('dock-state', (_params, emit) => {
      const subscription = ctx.node.createSubscription('std_msgs/msg/String', '/dock/state', (m) => emit(m.data));
      return () => ctx.node.destroySubscription(subscription);
    });
  },
} satisfies TasselloPlugin;
```

Import only types from `tassello/server`: the server gives the plugin everything at run time, so
its module needs `tassello` to type check, not to run. `activate(ctx)` may be async; if it throws,
the plugin's widgets still load, and its requests report why it did not start.

| `ctx` | |
|---|---|
| `name`, `dir` | The plugin's name and folder |
| `node` | The server's ROS node (rclnodejs), shared by every plugin: create publishers, subscriptions, clients on it |
| `rclnodejs` | The rclnodejs module |
| `logger` | Logs through the node, prefixed with the plugin's name |
| `handle(method, (params, session) => result)` | Answers `connection.request(plugin, method, params)`. The result (or its promise) goes to the page as JSON; what it throws is the page's error |
| `stream(name, (params, emit, session) => close)` | Opens a stream for `connection.subscribePlugin`; `emit(data)` sends it data. Returns what closes it, called when the page unsubscribes or goes away |
| `commandWidget(type, { property, fallback })` | Widgets of this type run a bash command of their config, like the button (see below) |
| `onShutdown(callback)` | Called when the server stops, before the node is destroyed |

`session.id` tells the pages apart: one per open page.

The page is trusted to be Tassello's, not to be right: check the params.

### Command widgets

A widget that runs a bash command on the robot, like the button, must not send the command: the
server reads it from the saved panel, so that a page can only run what an editor saved.
`ctx.commandWidget('my-robot.restart', { property: 'command', fallback: 'systemctl restart my-robot' })`
makes widgets of that type run their `command` property. The page asks with
`connection.send({ type: 'command.run', panelId, widgetId: instance.id })` (`command.stop` to
stop it), and follows it with `useCommandState(panelId, instance.id)`: running, exit code,
output, on every page.

## Distributing it

- **npm**: name it `tassello-plugin-<name>` (or `@scope/tassello-plugin-<name>`) and publish it.
  Installed next to Tassello (`npm install -g tassello tassello-plugin-<name>`), it loads by
  itself. Keep `tassello` an optional peer dependency, as the template does, so that installing
  the plugin does not install a second Tassello.
- **A ROS package**: a robot's own package can carry its plugin. Install the plugin's files into
  its share folder, and register it in the ament index; Tassello, started in a workspace with the
  package sourced, loads it:

  ```cmake
  install(FILES package.json DESTINATION share/${PROJECT_NAME})
  install(DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/www/ DESTINATION share/${PROJECT_NAME}/www)
  # The plugin's folder, relative to the install prefix: share/<package> if empty
  ament_index_register_resource(tassello_plugins)
  ```

- **A folder**: `tassello --plugin <folder>`.

The template of `tassello create-plugin` (`template/` in this repository) is a complete example of
the three: a widget, a request and a stream.

## Compatibility

A plugin is built against a version of `tassello/sdk` and `tassello/server`, and runs in the
Tassellos that version is compatible with, by semantic versioning: before 1.0, a new minor
version (0.1 to 0.2) may change the plugin API, as the changelog says. Panels keep the plugin's
widgets while it is missing, showing that their type is unknown, and show them again once it is
back; the Robot Viewers keep its displays the same way.
