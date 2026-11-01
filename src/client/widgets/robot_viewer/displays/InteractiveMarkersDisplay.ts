// Interactive markers (visualization_msgs/InteractiveMarker), as RViz's
// display shows them: those of an interactive marker server, asked for
// (<ns>/get_interactive_markers) then kept up to date by its updates
// (<ns>/update), where TF puts their frames, with their descriptions above
// them. Their controls are dragged to move or turn them (along an axis, in a
// plane, around an axis, freely in 3D), clicked (buttons), and their menus
// opened (a menu control's click, a right click, a long touch): the server
// is told on <ns>/feedback, as by RViz.

import { Group, Matrix4, MeshLambertMaterial, Quaternion, type Object3D, type Ray, Vector3 } from 'three';

import { Display, normalizeFrame, type DisplayContext, type MenuItem, type PickEvent, type PickHandlers } from '../display.ts';
import {
  autoComplete,
  feedback,
  FeedbackEvent,
  GET_MARKERS_TYPE,
  header,
  InteractionMode,
  makeTitle,
  MenuCommand,
  menuTree,
  OrientationMode,
  serverTopics,
  update,
  UpdateSequence,
  FEEDBACK_TYPE,
  UPDATE_TYPE,
  type ControlMsg,
  type FeedbackMsg,
  type InteractiveMarkerMsg,
  type InteractiveMarkerPoseMsg,
  type MenuNode,
  type PoseMsg,
  type ServerTopics,
  type UpdateMsg,
  type Vec3,
} from '../interactive_markers.ts';
import type { InteractiveMarkersDisplayConfig } from './index.ts';
import { controlAxis, controlFrame, MarkerDrag } from './interaction.ts';
import { markerObject, PLACEHOLDER, type MarkerObject, type MarkerResources } from './markers.ts';
import { axesObject } from './shapes.ts';
import { disposeObject, loadMeshResource } from './urdf.ts';

// The control's markers brighter, as RViz's: hovered, dragged
const HOVER = 0.3;
const ACTIVE = 0.5;
// The pose, to the server while dragged, at most this often (ms)
const FEEDBACK_INTERVAL_MS = 50;
// Between two feedback messages, at least (ms): servers keep one at a time
// (their subscription's depth is 1), so that a click's, sent with its
// release, would be lost
const FEEDBACK_GAP_MS = 50;
// Of the updates: a drag's poses come back as fast as they are sent
const UPDATE_RATE = 50;
const CALL_TIMEOUT_MS = 3000;
// The server asked again for its markers, after it did not answer
const RETRY_MS = 2000;
// And while it answers: servers send no keep alive, and a restarted server's
// first update is lost while it is discovered, so only its sequence number,
// asked for, tells it restarted (or that updates were missed)
const VERIFY_MS = 5000;
const ONE = new Vector3(1, 1, 1);

const DRAGGED_MODES: ReadonlySet<number> = new Set([
  InteractionMode.MOVE_AXIS,
  InteractionMode.MOVE_PLANE,
  InteractionMode.ROTATE_AXIS,
  InteractionMode.MOVE_ROTATE,
  InteractionMode.MOVE_3D,
  InteractionMode.ROTATE_3D,
  InteractionMode.MOVE_ROTATE_3D,
]);
const TURNING_MODES: ReadonlySet<number> = new Set([InteractionMode.ROTATE_AXIS, InteractionMode.ROTATE_3D]);

interface ControlView {
  message: ControlMsg;
  orientation: Quaternion;
  // Its markers, in the control's frame: at the marker, turned as its
  // orientation mode says
  group: Group;
  markers: MarkerObject[];
  // What makes it pickable no more
  release: (() => void) | null;
}

interface MarkerView {
  // Completed (autoComplete)
  message: InteractiveMarkerMsg;
  frame: string;
  // Where TF puts its frame; its pose in it
  holder: Group;
  position: Vector3;
  quaternion: Quaternion;
  controls: ControlView[];
  axes: Object3D | null;
  menu: MenuNode[];
  // Markers of types not drawn
  unsupported: number;
  detach: () => void;
  // While dragged, its updates wait for the drag to end
  dragging: boolean;
  pending: InteractiveMarkerMsg | null;
}

interface DragState {
  view: MarkerView;
  control: ControlView;
  drag: MarkerDrag | null;
  // Where it was pressed, in the marker's frame
  point: Vec3 | null;
  moved: boolean;
  lastSent: number;
  unsent: boolean;
  timer: number;
}

function poseOf(view: MarkerView | null): PoseMsg {
  if (!view) {
    return { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
  }
  const { position: p, quaternion: q } = view;
  return { position: { x: p.x, y: p.y, z: p.z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class InteractiveMarkersDisplay extends Display<InteractiveMarkersDisplayConfig> {
  private config: InteractiveMarkersDisplayConfig | null = null;
  private topics: ServerTopics | null = null;
  protected readonly markers = new Map<string, MarkerView>();
  private readonly sequence = new UpdateSequence();
  // Who the server is told did it: this viewer
  private readonly clientId = `tassello/${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  private unsubscribe: (() => void) | null = null;
  // Of the topic chosen: answers to a former one are dropped
  private session = 0;
  private asking = false;
  private retryTimer = 0;
  private verifyTimer = 0;
  // The feedback publisher made, ahead of the first press
  private feedbackReady = false;
  // Feedback waiting for its turn, in order
  private readonly outbox: FeedbackMsg[] = [];
  private lastFeedbackAt = 0;
  private outboxTimer = 0;
  private topicError: string | null = null;
  private topicWaiting: string | null = null;
  private serverError: string | null = null;
  private dragState: DragState | null = null;
  private hasViewFacing = false;
  // Mesh resources, loaded once for the display's markers
  private readonly meshes = new Map<string, Promise<Object3D>>();
  private readonly placeholder = new MeshLambertMaterial();
  private readonly loadingMeshes = new Set<string>();
  private readonly failedMeshes = new Set<string>();
  private readonly resources: MarkerResources = {
    mesh: (url) => {
      let mesh = this.meshes.get(url);
      if (!mesh) {
        this.loadingMeshes.add(url);
        mesh = loadMeshResource(url, this.placeholder);
        // Whether or not a marker still waits for it
        mesh.then(
          () => {
            this.loadingMeshes.delete(url);
            this.updateNotes();
          },
          (error: unknown) => {
            console.warn(`Interactive marker mesh ${url}:`, error);
            this.loadingMeshes.delete(url);
            this.failedMeshes.add(url);
            this.updateNotes();
          },
        );
        this.meshes.set(url, mesh);
        this.updateNotes();
      }
      return mesh;
    },
    loaded: () => this.render(),
  };

  constructor(context: DisplayContext) {
    super(context);
    this.placeholder.userData[PLACEHOLDER] = true;
  }

  configure(config: InteractiveMarkersDisplayConfig, previous: InteractiveMarkersDisplayConfig | null): void {
    this.config = config;
    if (config.topic.trim() !== previous?.topic.trim()) {
      this.connect(config.topic.trim());
    } else if (
      config.showDescriptions !== previous.showDescriptions ||
      config.showAxes !== previous.showAxes ||
      config.interactive !== previous.interactive
    ) {
      for (const view of [...this.markers.values()]) {
        this.upsert(view.message);
      }
    }
    this.render();
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.updateStatus();
  }

  // Turns the view facing controls to the camera, in their markers' frames
  onRender(): void {
    if (!this.hasViewFacing) {
      return;
    }
    const camera = this.context.camera();
    for (const view of this.markers.values()) {
      if (!view.holder.visible) {
        continue;
      }
      const inverse = view.holder.quaternion.clone().invert();
      const direction = camera.direction.clone().applyQuaternion(inverse);
      const up = camera.up.clone().applyQuaternion(inverse);
      for (const control of view.controls) {
        const { orientation_mode: mode, independent_marker_orientation: independent } = control.message;
        if (mode === OrientationMode.VIEW_FACING && !independent) {
          control.group.quaternion.copy(controlFrame(mode, view.quaternion, control.orientation, { direction, up }));
        }
      }
    }
  }

  dispose(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.verifyTimer);
    clearTimeout(this.outboxTimer);
    // What was done last, e.g. a release, told now
    for (const message of this.outbox.splice(0)) {
      this.publishFeedback(message);
    }
    if (this.dragState) {
      clearTimeout(this.dragState.timer);
    }
    for (const mesh of this.meshes.values()) {
      mesh.then((object) => disposeObject(object, new Set()), () => {});
    }
    this.placeholder.dispose();
  }

  // ── The server ──

  private connect(topic: string): void {
    this.session++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.verifyTimer);
    this.asking = false;
    this.sequence.stop();
    for (const view of [...this.markers.values()]) {
      this.removeView(view);
    }
    this.topicError = null;
    this.topicWaiting = null;
    this.serverError = null;
    this.failedMeshes.clear();
    this.topics = null;
    this.feedbackReady = false;
    this.outbox.length = 0;
    clearTimeout(this.outboxTimer);
    this.outboxTimer = 0;
    this.updateNotes();
    if (!topic) {
      this.setStatus('error', 'No topic: set one in edit mode');
      return;
    }
    const topics = serverTopics(topic);
    this.topics = topics;
    const session = this.session;
    const unsubscribe = this.connection.subscribeTopic(
      { topic: topics.update, maxRate: UPDATE_RATE },
      {
        status: (state, message) => {
          if (session !== this.session || state === 'streaming') {
            return;
          }
          this.topicError = state === 'error' ? message : null;
          this.topicWaiting = state === 'waiting' ? message : null;
          this.updateStatus();
        },
        message: (messageType, message) => {
          if (session !== this.session) {
            return;
          }
          if (messageType !== UPDATE_TYPE) {
            this.topicError = `${topics.update} is a ${messageType}, not a ${UPDATE_TYPE}`;
            this.updateStatus();
            return;
          }
          this.topicError = null;
          this.topicWaiting = null;
          this.onUpdate(update(message));
        },
      },
    );
    this.unsubscribe = this.context.track(() => {
      if (session === this.session) {
        this.session++;
      }
      unsubscribe();
    });
    this.ask();
    this.updateStatus();
  }

  // All the server's markers, as of its latest update. Verifying, those
  // shown are kept if it is still at their sequence number.
  private ask(verify = false): void {
    const topics = this.topics;
    if (this.asking || !topics) {
      return;
    }
    clearTimeout(this.retryTimer);
    clearTimeout(this.verifyTimer);
    const shown = verify ? this.sequence.latest : null;
    this.asking = true;
    this.sequence.asked();
    const session = this.session;
    this.connection
      .callService<{ sequence_number?: number; markers?: unknown[] }>(topics.service, GET_MARKERS_TYPE, {}, CALL_TIMEOUT_MS)
      .then(
        (response) => {
          if (session !== this.session) {
            return;
          }
          this.asking = false;
          this.serverError = null;
          this.prepareFeedback(topics);
          const sequenceNumber = Number(response?.sequence_number ?? 0);
          const pending = this.sequence.answered(sequenceNumber);
          if (sequenceNumber !== shown) {
            this.replaceAll((response?.markers ?? []).map(autoComplete));
          }
          if (pending === null) {
            this.ask();
            return;
          }
          for (const u of pending) {
            this.apply(u);
          }
          this.updateStatus();
          this.render();
          this.verifyTimer = window.setTimeout(() => this.verify(), VERIFY_MS);
        },
        (e: unknown) => {
          if (session !== this.session) {
            return;
          }
          this.asking = false;
          this.sequence.stop();
          this.serverError = errorText(e);
          this.updateStatus();
          this.retryTimer = window.setTimeout(() => this.ask(), RETRY_MS);
        },
      );
  }

  private verify(): void {
    if (this.dragState) {
      this.verifyTimer = window.setTimeout(() => this.verify(), VERIFY_MS);
    } else {
      this.ask(true);
    }
  }

  private onUpdate(message: UpdateMsg): void {
    const verdict = this.sequence.receive(message);
    if (verdict === 'reset' || (!this.sequence.running && !this.asking)) {
      // Updates were missed, the server restarted, or it is here now
      this.ask();
      return;
    }
    if (verdict === 'apply') {
      this.apply(message);
      this.updateStatus();
      this.render();
    }
  }

  private apply(message: UpdateMsg): void {
    for (const m of message.markers) {
      this.upsert(autoComplete(m));
    }
    for (const p of message.poses) {
      this.setPose(p);
    }
    for (const name of message.erases) {
      const view = this.markers.get(name);
      if (view) {
        this.removeView(view);
      }
    }
  }

  private replaceAll(messages: InteractiveMarkerMsg[]): void {
    const names = new Set(messages.map((m) => m.name));
    for (const view of [...this.markers.values()]) {
      if (!names.has(view.message.name) && !view.dragging) {
        this.removeView(view);
      }
    }
    for (const message of messages) {
      this.upsert(message);
    }
  }

  // The robot's publisher of feedback is made on its first message, which
  // is often lost while the server discovers it: a keep alive for no marker
  // (which servers ignore) makes it now, so that the first press is not lost
  private prepareFeedback(topics: ServerTopics): void {
    if (this.feedbackReady) {
      return;
    }
    this.feedbackReady = this.connection.publish(
      topics.feedback,
      FEEDBACK_TYPE,
      feedback(this.clientId, { name: '', header: header({}) }, '', FeedbackEvent.KEEP_ALIVE, poseOf(null)),
    );
  }

  private feedback(view: MarkerView, control: ControlView, eventType: number, options: { menuEntryId?: number; mousePoint?: Vec3 | null } = {}): void {
    const message = feedback(this.clientId, view.message, control.message.name, eventType, poseOf(view), options);
    const last = this.outbox.at(-1);
    if (
      eventType === FeedbackEvent.POSE_UPDATE &&
      last?.event_type === FeedbackEvent.POSE_UPDATE &&
      last.marker_name === message.marker_name
    ) {
      // The latest pose stands for those not sent yet
      this.outbox[this.outbox.length - 1] = message;
    } else {
      this.outbox.push(message);
    }
    this.flushFeedback();
  }

  private flushFeedback(): void {
    if (this.outboxTimer) {
      return;
    }
    while (this.outbox.length > 0) {
      const wait = this.lastFeedbackAt + FEEDBACK_GAP_MS - performance.now();
      if (wait > 0) {
        this.outboxTimer = window.setTimeout(() => {
          this.outboxTimer = 0;
          this.flushFeedback();
        }, wait);
        return;
      }
      this.publishFeedback(this.outbox.shift()!);
    }
  }

  private publishFeedback(message: FeedbackMsg): void {
    this.lastFeedbackAt = performance.now();
    if (this.topics) {
      this.connection.publish(this.topics.feedback, FEEDBACK_TYPE, message);
    }
  }

  // ── The markers ──

  // A marker, new or anew; while dragged, after the drag
  private upsert(message: InteractiveMarkerMsg): void {
    const existing = this.markers.get(message.name);
    if (existing?.dragging) {
      existing.pending = message;
      return;
    }
    if (existing) {
      this.removeView(existing);
    }
    if (message.controls.length === 0) {
      return;
    }
    const holder = new Group();
    this.root.add(holder);
    const { position: p, orientation: q } = message.pose;
    const view: MarkerView = {
      message,
      frame: normalizeFrame(message.header.frame_id),
      holder,
      position: new Vector3(p.x, p.y, p.z),
      quaternion: new Quaternion(q.x, q.y, q.z, q.w).normalize(),
      controls: [],
      axes: null,
      menu: menuTree(message.menu_entries),
      unsupported: 0,
      detach: () => {},
      dragging: false,
      pending: null,
    };
    view.detach = this.attach(holder, view.frame);
    this.markers.set(message.name, view);
    const controls = [...message.controls];
    if (this.config?.showDescriptions !== false && message.description.trim()) {
      controls.push(makeTitle(message));
    }
    for (const control of controls) {
      view.controls.push(this.createControl(view, control));
    }
    if (this.config?.showAxes) {
      view.axes = axesObject(message.scale, message.scale * 0.05);
      holder.add(view.axes);
    }
    this.layout(view);
    this.hasViewFacing = [...this.markers.values()].some((v) =>
      v.controls.some((c) => c.message.orientation_mode === OrientationMode.VIEW_FACING),
    );
    this.updateNotes();
  }

  private createControl(view: MarkerView, message: ControlMsg): ControlView {
    const group = new Group();
    view.holder.add(group);
    const { x, y, z, w } = message.orientation;
    const control: ControlView = {
      message,
      orientation: new Quaternion(x, y, z, w).normalize(),
      group,
      markers: [],
      release: null,
    };
    this.layoutControl(view, control);
    for (const marker of message.markers) {
      const object = markerObject(marker, this.resources);
      if (!object) {
        view.unsupported++;
        continue;
      }
      if (marker.header.frame_id.trim()) {
        this.placeInControl(view, control, object.object, normalizeFrame(marker.header.frame_id));
      }
      group.add(object.object);
      control.markers.push(object);
    }
    const interactive = this.config?.interactive !== false;
    const menu = view.menu.length > 0;
    if (interactive && control.markers.length > 0 && (message.interaction_mode !== InteractionMode.NONE || menu)) {
      control.release = this.pickable(group, this.handlers(view, control));
    }
    return control;
  }

  // A marker with a frame of its own: where TF puts it now, in the control's
  // frame (else as if it had none)
  private placeInControl(view: MarkerView, control: ControlView, object: Object3D, frame: string): void {
    const markerFrame = this.pose(frame);
    const viewFrame = this.pose(view.frame);
    if (!markerFrame || !viewFrame) {
      return;
    }
    const controlInFixed = new Matrix4()
      .compose(viewFrame.position, viewFrame.quaternion, ONE)
      .multiply(new Matrix4().compose(control.group.position, control.group.quaternion, ONE));
    const markerInFixed = new Matrix4()
      .compose(markerFrame.position, markerFrame.quaternion, ONE)
      .multiply(new Matrix4().compose(object.position, object.quaternion, ONE));
    controlInFixed.invert().multiply(markerInFixed).decompose(object.position, object.quaternion, new Vector3());
  }

  // The controls where the marker is, turned as their modes say
  private layout(view: MarkerView): void {
    for (const control of view.controls) {
      this.layoutControl(view, control);
    }
    if (view.axes) {
      view.axes.position.copy(view.position);
      view.axes.quaternion.copy(view.quaternion);
    }
  }

  private layoutControl(view: MarkerView, control: ControlView): void {
    const { orientation_mode: mode, independent_marker_orientation: independent } = control.message;
    control.group.position.copy(view.position);
    if (mode === OrientationMode.VIEW_FACING) {
      if (independent) {
        control.group.quaternion.copy(view.quaternion);
      }
      // Else turned to the camera as it is drawn (onRender)
      return;
    }
    control.group.quaternion.copy(mode === OrientationMode.FIXED ? new Quaternion() : view.quaternion);
  }

  private setPose(message: InteractiveMarkerPoseMsg): void {
    const view = this.markers.get(message.name);
    // While dragged: the poses are those it was dragged through, sent back
    if (!view || view.dragging) {
      return;
    }
    const frame = normalizeFrame(message.header.frame_id);
    if (frame && frame !== view.frame) {
      view.detach();
      view.frame = frame;
      view.message.header = message.header;
      view.detach = this.attach(view.holder, frame);
    }
    const { position: p, orientation: q } = message.pose;
    view.position.set(p.x, p.y, p.z);
    view.quaternion.set(q.x, q.y, q.z, q.w).normalize();
    view.message.pose = message.pose;
    this.layout(view);
  }

  private removeView(view: MarkerView): void {
    if (this.dragState?.view === view) {
      clearTimeout(this.dragState.timer);
      this.dragState = null;
    }
    for (const control of view.controls) {
      control.release?.();
      for (const marker of control.markers) {
        marker.dispose();
      }
    }
    if (view.axes) {
      disposeObject(view.axes, new Set());
    }
    view.detach();
    view.holder.removeFromParent();
    if (this.markers.get(view.message.name) === view) {
      this.markers.delete(view.message.name);
    }
  }

  // ── Interaction ──

  private highlight(control: ControlView, amount: number): void {
    for (const marker of control.markers) {
      marker.highlight(amount);
    }
    this.render();
  }

  // The marker's frame, from the fixed frame
  private toMarkerFrame(view: MarkerView): Matrix4 {
    return new Matrix4().compose(view.holder.position, view.holder.quaternion, ONE).invert();
  }

  private handlers(view: MarkerView, control: ControlView): PickHandlers {
    const mode = control.message.interaction_mode;
    const dragged = DRAGGED_MODES.has(mode);
    return {
      cursor: dragged ? (TURNING_MODES.has(mode) ? 'grab' : 'move') : 'pointer',
      hover: (hovered) => {
        if (this.dragState?.control !== control) {
          this.highlight(control, hovered ? HOVER : 0);
        }
      },
      press: (event) => {
        if (mode === InteractionMode.NONE) {
          // The view moves; its menu by a right click
          return false;
        }
        const toMarker = this.toMarkerFrame(view);
        const point = event.point?.clone().applyMatrix4(toMarker) ?? null;
        const state: DragState = {
          view,
          control,
          drag: null,
          point: point && { x: point.x, y: point.y, z: point.z },
          moved: false,
          lastSent: 0,
          unsent: false,
          timer: 0,
        };
        if (mode === InteractionMode.MENU) {
          this.dragState = state;
          return true;
        }
        if (dragged && point) {
          const camera = this.context.camera();
          const inverse = view.holder.quaternion.clone().invert();
          const direction = camera.direction.clone().applyQuaternion(inverse);
          const up = camera.up.clone().applyQuaternion(inverse);
          const frame = controlFrame(control.message.orientation_mode, view.quaternion, control.orientation, { direction, up });
          state.drag = new MarkerDrag({
            mode,
            pose: { position: view.position, quaternion: view.quaternion },
            axis: controlAxis(frame, control.orientation),
            grab: point,
            view: direction,
          });
          view.dragging = true;
        }
        this.dragState = state;
        this.highlight(control, ACTIVE);
        this.feedback(view, control, FeedbackEvent.MOUSE_DOWN, { mousePoint: state.point });
        return true;
      },
      drag: (event) => {
        const state = this.dragState;
        if (state?.control !== control || !state.drag) {
          return;
        }
        const ray: Ray = event.ray.clone().applyMatrix4(this.toMarkerFrame(view));
        const pose = state.drag.move(ray, event.ctrlKey || event.metaKey || event.shiftKey);
        if (!pose) {
          return;
        }
        view.position.copy(pose.position);
        view.quaternion.copy(pose.quaternion);
        view.message.pose = poseOf(view);
        this.layout(view);
        this.render();
        state.moved = true;
        this.sendPose(state);
      },
      release: (event, clicked) => {
        const state = this.dragState;
        if (state?.control !== control) {
          return;
        }
        this.dragState = null;
        clearTimeout(state.timer);
        this.highlight(control, event.pointerType === 'mouse' ? HOVER : 0);
        if (mode === InteractionMode.MENU) {
          if (clicked) {
            this.openMenu(view, control, event, state.point);
          }
          return;
        }
        if (state.unsent) {
          this.feedback(view, control, FeedbackEvent.POSE_UPDATE);
        }
        if (mode === InteractionMode.BUTTON && clicked) {
          this.feedback(view, control, FeedbackEvent.BUTTON_CLICK, { mousePoint: state.point });
        }
        this.feedback(view, control, FeedbackEvent.MOUSE_UP, { mousePoint: state.point });
        view.dragging = false;
        const pending = view.pending;
        view.pending = null;
        if (pending) {
          // Where it was dragged to: the server has it
          if (state.moved) {
            pending.pose = poseOf(view);
          }
          this.upsert(pending);
          this.render();
        }
      },
      menu:
        view.menu.length > 0
          ? (event) => {
              const point = event.point?.clone().applyMatrix4(this.toMarkerFrame(view));
              this.openMenu(view, control, event, point ? { x: point.x, y: point.y, z: point.z } : null);
            }
          : undefined,
    };
  }

  // The pose, to the server: now, else as soon as it may
  private sendPose(state: DragState): void {
    const now = performance.now();
    const wait = state.lastSent + FEEDBACK_INTERVAL_MS - now;
    if (wait <= 0) {
      clearTimeout(state.timer);
      state.timer = 0;
      state.lastSent = now;
      state.unsent = false;
      this.feedback(state.view, state.control, FeedbackEvent.POSE_UPDATE);
      return;
    }
    state.unsent = true;
    state.timer ||= window.setTimeout(() => {
      state.timer = 0;
      if (this.dragState === state && state.unsent) {
        this.sendPose(state);
      }
    }, wait);
  }

  private openMenu(view: MarkerView, control: ControlView, event: PickEvent, point: Vec3 | null): void {
    const items = (nodes: MenuNode[]): MenuItem[] =>
      nodes.map((node) => ({
        label: node.title.trim() || '(untitled)',
        children: node.children.length > 0 ? items(node.children) : undefined,
        // rosrun and roslaunch entries run where RViz runs: not here
        disabled: node.children.length === 0 && node.commandType !== MenuCommand.FEEDBACK,
        select: () => this.feedback(view, control, FeedbackEvent.MENU_SELECT, { menuEntryId: node.id, mousePoint: point }),
      }));
    this.showMenu(event.x, event.y, items(view.menu));
  }

  // ── Status ──

  private updateStatus(): void {
    const topics = this.topics;
    if (!topics) {
      return;
    }
    if (this.topicError) {
      this.setStatus('error', this.topicError);
      return;
    }
    if (!this.sequence.running) {
      this.setStatus(
        'waiting',
        this.serverError
          ? `Waiting for the interactive marker server ${topics.namespace || '/'}: ${this.serverError}`
          : (this.topicWaiting ?? `Waiting for the interactive marker server ${topics.namespace || '/'}`),
      );
      return;
    }
    if (this.markers.size === 0) {
      this.setStatus('waiting', `No interactive markers on ${topics.namespace || '/'}`);
      return;
    }
    const lost = [...this.markers.values()].filter((view) => !this.pose(view.frame));
    if (lost.length > 0) {
      const more = lost.length > 1 ? ` (and ${lost.length - 1} more marker${lost.length > 2 ? 's' : ''})` : '';
      this.setStatus('warn', `${this.missingFrame(lost[0].frame)}${more}`);
      return;
    }
    this.setStatus('ok');
  }

  private updateNotes(): void {
    const notes: { text: string; tone: 'info' | 'warn' }[] = [];
    if (this.loadingMeshes.size > 0) {
      notes.push({ text: `Loading ${this.loadingMeshes.size} marker mesh(es)`, tone: 'info' });
    }
    if (this.failedMeshes.size > 0) {
      notes.push({ text: `${this.failedMeshes.size} marker mesh(es) could not be loaded`, tone: 'warn' });
    }
    const unsupported = [...this.markers.values()].reduce((sum, view) => sum + view.unsupported, 0);
    if (unsupported > 0) {
      notes.push({ text: `${unsupported} marker(s) of a type not drawn`, tone: 'warn' });
    }
    this.setNotes(notes);
  }
}
