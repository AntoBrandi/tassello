// What the Interactive Markers display works out without three.js: the
// messages of an interactive marker server (visualization_msgs), as
// interactive_markers' client completes them (autoComplete: the default
// arrows and rings of controls that have no markers, the description above
// the marker), their menus as trees, and the order of the server's updates.
//
// A server of namespace ns (/basic_controls) publishes ns/update
// (InteractiveMarkerUpdate: the markers that changed, the poses that moved,
// the markers erased, or a keep alive), answers ns/get_interactive_markers
// (all its markers, as of a sequence number) and listens to ns/feedback
// (InteractiveMarkerFeedback: what people do to its markers).

export const UPDATE_TYPE = 'visualization_msgs/msg/InteractiveMarkerUpdate';
export const FEEDBACK_TYPE = 'visualization_msgs/msg/InteractiveMarkerFeedback';
export const GET_MARKERS_TYPE = 'visualization_msgs/srv/GetInteractiveMarkers';

// visualization_msgs/Marker's types
export const MarkerType = {
  ARROW: 0,
  CUBE: 1,
  SPHERE: 2,
  CYLINDER: 3,
  LINE_STRIP: 4,
  LINE_LIST: 5,
  CUBE_LIST: 6,
  SPHERE_LIST: 7,
  POINTS: 8,
  TEXT_VIEW_FACING: 9,
  MESH_RESOURCE: 10,
  TRIANGLE_LIST: 11,
} as const;

// InteractiveMarkerControl's orientation_mode
export const OrientationMode = { INHERIT: 0, FIXED: 1, VIEW_FACING: 2 } as const;

// InteractiveMarkerControl's interaction_mode
export const InteractionMode = {
  NONE: 0,
  MENU: 1,
  BUTTON: 2,
  MOVE_AXIS: 3,
  MOVE_PLANE: 4,
  ROTATE_AXIS: 5,
  MOVE_ROTATE: 6,
  MOVE_3D: 7,
  ROTATE_3D: 8,
  MOVE_ROTATE_3D: 9,
} as const;

// InteractiveMarkerFeedback's event_type
export const FeedbackEvent = {
  KEEP_ALIVE: 0,
  POSE_UPDATE: 1,
  MENU_SELECT: 2,
  BUTTON_CLICK: 3,
  MOUSE_DOWN: 4,
  MOUSE_UP: 5,
} as const;

// MenuEntry's command_type: only FEEDBACK is the server's; the others run a
// command where RViz runs, which a dashboard does not
export const MenuCommand = { FEEDBACK: 0, ROSRUN: 1, ROSLAUNCH: 2 } as const;

export const UpdateKind = { KEEP_ALIVE: 0, UPDATE: 1 } as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface PoseMsg {
  position: Vec3;
  orientation: Quat;
}

export interface ColorMsg {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HeaderMsg {
  frame_id: string;
  stamp: { sec: number; nanosec: number };
}

export interface MarkerMsg {
  header: HeaderMsg;
  ns: string;
  id: number;
  type: number;
  pose: PoseMsg;
  scale: Vec3;
  color: ColorMsg;
  points: Vec3[];
  colors: ColorMsg[];
  text: string;
  mesh_resource: string;
  mesh_use_embedded_materials: boolean;
}

export interface ControlMsg {
  name: string;
  orientation: Quat;
  orientation_mode: number;
  interaction_mode: number;
  always_visible: boolean;
  markers: MarkerMsg[];
  independent_marker_orientation: boolean;
  description: string;
}

export interface MenuEntryMsg {
  id: number;
  parent_id: number;
  title: string;
  command: string;
  command_type: number;
}

export interface InteractiveMarkerMsg {
  header: HeaderMsg;
  pose: PoseMsg;
  name: string;
  description: string;
  scale: number;
  menu_entries: MenuEntryMsg[];
  controls: ControlMsg[];
}

export interface InteractiveMarkerPoseMsg {
  header: HeaderMsg;
  pose: PoseMsg;
  name: string;
}

export interface UpdateMsg {
  server_id: string;
  seq_num: number;
  type: number;
  markers: InteractiveMarkerMsg[];
  poses: InteractiveMarkerPoseMsg[];
  erases: string[];
}

export interface FeedbackMsg {
  header: HeaderMsg;
  client_id: string;
  marker_name: string;
  control_name: string;
  event_type: number;
  pose: PoseMsg;
  menu_entry_id: number;
  mouse_point: Vec3;
  mouse_point_valid: boolean;
}

// ── Messages, whole ──
// As JSON, a field may be missing (or of a message of an older version):
// those below fill in what is not there, as zeros, as ROS would.

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function vec3(value: unknown): Vec3 {
  const v = record(value);
  return { x: num(v.x), y: num(v.y), z: num(v.z) };
}

// Normalized; an empty one (all zeros, as ROS leaves it) is the identity
export function quat(value: unknown): Quat {
  const q = record(value);
  const x = num(q.x);
  const y = num(q.y);
  const z = num(q.z);
  const w = num(q.w);
  const length = Math.hypot(x, y, z, w);
  return length < 1e-9 ? { x: 0, y: 0, z: 0, w: 1 } : { x: x / length, y: y / length, z: z / length, w: w / length };
}

export function pose(value: unknown): PoseMsg {
  const p = record(value);
  return { position: vec3(p.position), orientation: quat(p.orientation) };
}

export function color(value: unknown): ColorMsg {
  const c = record(value);
  return { r: num(c.r), g: num(c.g), b: num(c.b), a: num(c.a) };
}

export function header(value: unknown): HeaderMsg {
  const h = record(value);
  const stamp = record(h.stamp);
  return { frame_id: str(h.frame_id), stamp: { sec: num(stamp.sec), nanosec: num(stamp.nanosec) } };
}

export function marker(value: unknown): MarkerMsg {
  const m = record(value);
  return {
    header: header(m.header),
    ns: str(m.ns),
    id: num(m.id),
    type: num(m.type),
    pose: pose(m.pose),
    scale: vec3(m.scale),
    color: color(m.color),
    points: list(m.points).map(vec3),
    colors: list(m.colors).map(color),
    text: str(m.text),
    mesh_resource: str(m.mesh_resource),
    mesh_use_embedded_materials: m.mesh_use_embedded_materials === true,
  };
}

function control(value: unknown): ControlMsg {
  const c = record(value);
  return {
    name: str(c.name),
    orientation: quat(c.orientation),
    orientation_mode: num(c.orientation_mode),
    interaction_mode: num(c.interaction_mode),
    always_visible: c.always_visible === true,
    markers: list(c.markers).map(marker),
    independent_marker_orientation: c.independent_marker_orientation === true,
    description: str(c.description),
  };
}

function menuEntry(value: unknown): MenuEntryMsg {
  const e = record(value);
  return {
    id: num(e.id),
    parent_id: num(e.parent_id),
    title: str(e.title),
    command: str(e.command),
    command_type: num(e.command_type),
  };
}

export function interactiveMarker(value: unknown): InteractiveMarkerMsg {
  const m = record(value);
  return {
    header: header(m.header),
    pose: pose(m.pose),
    name: str(m.name),
    description: str(m.description),
    scale: num(m.scale),
    menu_entries: list(m.menu_entries).map(menuEntry),
    controls: list(m.controls).map(control),
  };
}

export function update(value: unknown): UpdateMsg {
  const u = record(value);
  return {
    server_id: str(u.server_id),
    seq_num: num(u.seq_num),
    type: num(u.type),
    markers: list(u.markers).map(interactiveMarker),
    poses: list(u.poses).map((p) => {
      const item = record(p);
      return { header: header(item.header), pose: pose(item.pose), name: str(item.name) };
    }),
    erases: list(u.erases).map(str),
  };
}

// ── autoComplete, as interactive_markers' (tools.cpp) ──

const STEPS = 36;

function emptyMarker(): MarkerMsg {
  return marker({});
}

// After the control's axis: x red, y green, z blue, half transparent
export function defaultColor(orientation: Quat): ColorMsg {
  const { x: qx, y: qy, z: qz, w: qw } = orientation;
  // The x axis of the rotation
  const x = Math.abs(1 - 2 * (qy * qy + qz * qz));
  const y = Math.abs(2 * (qx * qy + qw * qz));
  const z = Math.abs(2 * (qx * qz - qw * qy));
  const max = Math.max(x, y, z, 1e-9);
  return { r: x / max, g: y / max, b: z / max, a: 0.5 };
}

// Along the control's x, on its pos side: from half the marker's scale out
function makeArrow(im: InteractiveMarkerMsg, ctrl: ControlMsg, pos: number): MarkerMsg {
  const arrow = emptyMarker();
  arrow.type = MarkerType.ARROW;
  arrow.pose.orientation = { ...ctrl.orientation };
  arrow.scale = { x: im.scale * 0.15, y: im.scale * 0.25, z: im.scale * 0.2 };
  arrow.color = defaultColor(ctrl.orientation);
  const dir = pos > 0 ? 1 : -1;
  const inner = 0.5 * Math.abs(pos);
  const outer = inner + 0.4;
  arrow.points = [
    { x: dir * im.scale * inner, y: 0, z: 0 },
    { x: dir * im.scale * outer, y: 0, z: 0 },
  ];
  return arrow;
}

// A ring in the control's yz plane, around its x: striped to rotate, in
// broad bands to move and rotate, plain to move in the plane
function makeDisc(im: InteractiveMarkerMsg, ctrl: ControlMsg, width = 0.3): MarkerMsg {
  const disc = emptyMarker();
  disc.type = MarkerType.TRIANGLE_LIST;
  disc.pose.orientation = { ...ctrl.orientation };
  disc.scale = { x: im.scale, y: im.scale, z: im.scale };
  disc.color = defaultColor(ctrl.orientation);
  const inner: Vec3[] = [];
  const outer: Vec3[] = [];
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    const y = 0.5 * Math.cos(a);
    const z = 0.5 * Math.sin(a);
    inner.push({ x: 0, y, z });
    outer.push({ x: 0, y: y * (1 + width), z: z * (1 + width) });
  }
  const base = disc.color;
  const shade = (t: number): ColorMsg => ({ r: base.r * t, g: base.g * t, b: base.b * t, a: base.a });
  for (let i = 0; i < STEPS; i++) {
    const j = (i + 1) % STEPS;
    disc.points.push(inner[i], outer[i], inner[j], outer[i], outer[j], inner[j]);
    if (ctrl.interaction_mode === InteractionMode.ROTATE_AXIS) {
      const t = 0.6 + 0.4 * (i % 2);
      disc.colors.push(shade(t), shade(t));
    } else if (ctrl.interaction_mode === InteractionMode.MOVE_ROTATE) {
      const t = Math.floor(i / 3) % 2 ? 0.6 : 1;
      disc.colors.push(shade(t), shade(t));
    }
  }
  return disc;
}

// A menu's control without markers: its text, above the marker, facing the
// view
function makeViewFacingButton(im: InteractiveMarkerMsg, ctrl: ControlMsg, text: string): MarkerMsg {
  ctrl.orientation_mode = OrientationMode.VIEW_FACING;
  ctrl.independent_marker_orientation = false;
  const button = emptyMarker();
  const base = 0.25 * im.scale;
  button.type = MarkerType.TEXT_VIEW_FACING;
  button.scale = { x: base, y: base, z: base };
  button.color = { r: 1, g: 1, b: 1, a: 1 };
  button.pose.position = { x: base * -0.1, y: 0, z: 1.2 * im.scale + base * -0.1 };
  button.text = text;
  return button;
}

function completeControl(im: InteractiveMarkerMsg, ctrl: ControlMsg): void {
  ctrl.orientation = quat(ctrl.orientation);
  if (ctrl.markers.length === 0) {
    switch (ctrl.interaction_mode) {
      case InteractionMode.MOVE_AXIS:
        ctrl.markers.push(makeArrow(im, ctrl, 1), makeArrow(im, ctrl, -1));
        break;
      case InteractionMode.MOVE_PLANE:
      case InteractionMode.ROTATE_AXIS:
      case InteractionMode.MOVE_ROTATE:
        ctrl.markers.push(makeDisc(im, ctrl));
        break;
      case InteractionMode.MENU:
        ctrl.markers.push(makeViewFacingButton(im, ctrl, im.description));
        break;
      default:
        break;
    }
  }
  for (const m of ctrl.markers) {
    m.scale = { x: m.scale.x || 1, y: m.scale.y || 1, z: m.scale.z || 1 };
    m.ns = im.name;
    m.pose.orientation = quat(m.pose.orientation);
  }
}

// Controls of the same name: _u0, _u1... added, as the feedback names them
function uniqueControlNames(im: InteractiveMarkerMsg): void {
  const names = new Set<string>();
  let n = 0;
  for (const ctrl of im.controls) {
    let name = ctrl.name;
    while (names.has(name)) {
      name = `${ctrl.name}_u${n++}`;
    }
    ctrl.name = name;
    names.add(name);
  }
}

// A marker as interactive_markers' client completes it: a scale (1 if 0), its
// controls' orientations, their default markers if they have none. The poses
// of the markers of a control without a frame are in the control's, as RViz
// places them: at the marker, turned as its orientation mode says.
export function autoComplete(value: unknown): InteractiveMarkerMsg {
  const im = interactiveMarker(value);
  if (im.controls.length === 0) {
    return im;
  }
  if (!(im.scale > 0)) {
    im.scale = 1;
  }
  for (const ctrl of im.controls) {
    completeControl(im, ctrl);
  }
  uniqueControlNames(im);
  return im;
}

// The description, above the marker and facing the view, as RViz shows it
export function makeTitle(im: InteractiveMarkerMsg): ControlMsg {
  const title = emptyMarker();
  title.type = MarkerType.TEXT_VIEW_FACING;
  title.scale = { x: im.scale * 0.15, y: im.scale * 0.15, z: im.scale * 0.15 };
  title.color = { r: 1, g: 1, b: 1, a: 1 };
  title.pose.position.z = im.scale * 1.4;
  title.text = im.description;
  const ctrl = control({});
  ctrl.name = '';
  ctrl.interaction_mode = InteractionMode.NONE;
  ctrl.orientation_mode = OrientationMode.VIEW_FACING;
  ctrl.always_visible = true;
  ctrl.markers.push(title);
  completeControl(im, ctrl);
  return ctrl;
}

// ── Menus ──

export interface MenuNode {
  id: number;
  title: string;
  // FEEDBACK, else what RViz would run
  commandType: number;
  children: MenuNode[];
}

// The entries as a tree, in their order: parent_id 0 at the top, as those
// whose parent is not there
export function menuTree(entries: MenuEntryMsg[]): MenuNode[] {
  const nodes = new Map<number, MenuNode>();
  for (const entry of entries) {
    nodes.set(entry.id, { id: entry.id, title: entry.title, commandType: entry.command_type, children: [] });
  }
  const roots: MenuNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parent = entry.parent_id !== 0 ? nodes.get(entry.parent_id) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── The server ──

export interface ServerTopics {
  namespace: string;
  update: string;
  feedback: string;
  service: string;
}

// Of the update topic chosen (/basic_controls/update), or of the namespace
// itself (/basic_controls)
export function serverTopics(topic: string): ServerTopics {
  const namespace = topic
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/update(_full)?$/, '');
  return {
    namespace,
    update: `${namespace}/update`,
    feedback: `${namespace}/feedback`,
    service: `${namespace}/get_interactive_markers`,
  };
}

export type UpdateVerdict = 'apply' | 'ignore' | 'reset';

// The order of a server's updates, against the markers asked for
// (get_interactive_markers, as of its sequence number): the updates after
// them are applied in order, those before ignored; one missed (dropped on the
// way, or the server restarted) has the markers asked for again ('reset').
export class UpdateSequence {
  private state: 'idle' | 'asking' | 'running' = 'idle';
  private last = 0;
  private serverId: string | null = null;
  private queue: UpdateMsg[] = [];

  get running(): boolean {
    return this.state === 'running';
  }

  // The sequence number of the markers shown, null if not running
  get latest(): number | null {
    return this.state === 'running' ? this.last : null;
  }

  // The markers were asked for: updates wait for them
  asked(): void {
    this.state = 'asking';
    this.queue = [];
    this.serverId = null;
  }

  // The markers came, as of sequenceNumber: the updates that came since, to
  // apply after them; null if one is missing (ask again)
  answered(sequenceNumber: number): UpdateMsg[] | null {
    this.state = 'running';
    this.last = sequenceNumber;
    const queued = this.queue;
    this.queue = [];
    const apply: UpdateMsg[] = [];
    for (const u of queued) {
      const verdict = this.verdict(u);
      if (verdict === 'reset') {
        this.state = 'idle';
        return null;
      }
      if (verdict === 'apply') {
        apply.push(u);
      }
    }
    return apply;
  }

  // The markers could not be asked for: updates are ignored until asked again
  stop(): void {
    this.state = 'idle';
    this.queue = [];
  }

  // A message on the update topic
  receive(u: UpdateMsg): UpdateVerdict {
    if (this.state === 'idle') {
      return 'ignore';
    }
    if (this.state === 'asking') {
      this.queue.push(u);
      return 'ignore';
    }
    const verdict = this.verdict(u);
    if (verdict === 'reset') {
      this.state = 'idle';
    }
    return verdict;
  }

  private verdict(u: UpdateMsg): UpdateVerdict {
    if (this.serverId !== null && u.server_id !== this.serverId) {
      return 'reset';
    }
    if (u.type === UpdateKind.KEEP_ALIVE) {
      // As of the server's latest update: the same as ours, else one missed
      if (u.seq_num < this.last && this.serverId === null) {
        // Before the markers asked for: from before them
        return 'ignore';
      }
      this.serverId = u.server_id;
      return u.seq_num === this.last ? 'ignore' : 'reset';
    }
    if (u.seq_num <= this.last) {
      // Included in the markers asked for; once updates came, a server
      // counting again: restarted
      return this.serverId === null ? 'ignore' : u.seq_num === this.last ? 'ignore' : 'reset';
    }
    if (u.seq_num > this.last + 1) {
      return 'reset';
    }
    this.serverId = u.server_id;
    this.last = u.seq_num;
    return 'apply';
  }
}

// What people did to a marker, for its server: the pose in the marker's
// frame, the point pressed if any
export function feedback(
  clientId: string,
  im: { name: string; header: HeaderMsg },
  controlName: string,
  eventType: number,
  current: PoseMsg,
  options: { menuEntryId?: number; mousePoint?: Vec3 | null } = {},
): FeedbackMsg {
  return {
    header: { frame_id: im.header.frame_id, stamp: { sec: 0, nanosec: 0 } },
    client_id: clientId,
    marker_name: im.name,
    control_name: controlName,
    event_type: eventType,
    pose: current,
    menu_entry_id: options.menuEntryId ?? 0,
    mouse_point: options.mousePoint ?? { x: 0, y: 0, z: 0 },
    mouse_point_valid: !!options.mousePoint,
  };
}
