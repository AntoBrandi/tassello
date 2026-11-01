// The Robot Viewer's view: a three.js scene of displays (display.ts), in a
// fixed frame, seen in 3D (orbited) or from above in 2D (panned). It follows
// TF in the fixed frame for its displays, which it loads, configures and frees
// as the widget's list of them changes; one that throws shows its error, the
// others carry on.
//
// Drag to orbit (3D) or pan (2D), right drag (two fingers) to pan, scroll
// (pinch) to zoom; but on what a display made pickable (its interactive
// markers), whose handlers have the pointer then. Rendered on demand, not in
// a loop: a still view costs nothing.

import {
  Box3,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Raycaster,
  Scene,
  Sphere,
  Texture,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, type CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { DisplayInstance } from '../../../shared/panel.ts';
import type { Pose3D, TfFramesUpdate } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import type { RegisteredDisplay } from '../types.ts';
import {
  normalizeFrame,
  type Display,
  type DisplayClass,
  type DisplayContext,
  type DisplayNote,
  type DisplayStatusLevel,
  type FrameState,
  type MenuItem,
  type PickEvent,
  type PickHandlers,
  type Pose,
  type ViewCamera,
  type ViewMode,
} from './display.ts';
import { effectiveFixedFrame } from './model.ts';

// TF updates a second: what moves in the fixed frame, e.g. the robot in odom
const TF_RATE = 15;
// The view's radius until a display gives what to focus on
const DEFAULT_SCALE = 0.5;
// The 2D camera, this far above what it looks at
const ORTHO_HEIGHT = 200;
// A press that moves less, in CSS pixels, is a click
const CLICK_SLOP = 4;
// A touch held this long without moving asks for the menu, in ms
const LONG_PRESS_MS = 550;

// A display of the widget's list, as the view gives it
export interface ViewerDisplay {
  instance: DisplayInstance;
  // undefined if its type is not registered, e.g. its plugin is missing
  definition: RegisteredDisplay | undefined;
  // Its properties' values
  config: Record<string, unknown>;
}

export interface DisplayState {
  id: string;
  name: string;
  level: DisplayStatusLevel;
  message: string;
  notes: DisplayNote[];
}

// What the widget shows around the view
export interface ViewerState {
  // The TF frames' names
  frames: string[];
  // The frame the view is in, and what Auto stands for
  fixedFrame: string;
  autoFrame: string;
  // Why the frames have no poses, e.g. the fixed frame does not exist
  frameError: string | null;
  // The enabled displays, in their order
  displays: DisplayState[];
}

interface Slot {
  id: string;
  name: string;
  definition: RegisteredDisplay;
  config: Record<string, unknown>;
  // The config as JSON, to tell its changes
  key: string;
  display: Display | null;
  gone: boolean;
  level: DisplayStatusLevel;
  message: string;
  notes: DisplayNote[];
  attached: Map<Object3D, string>;
  cleanups: Set<() => void>;
  suggestion: string | null;
  pickables: Map<Object3D, PickHandlers>;
}

// An object made pickable, by its display
interface Pick {
  slot: Slot;
  object: Object3D;
  handlers: PickHandlers;
}

// The pointer, taken by a pick: pressed (button 0), or right pressed for its
// menu (button 2)
interface Drag {
  pick: Pick;
  pointerId: number;
  button: number;
  startX: number;
  startY: number;
  moved: boolean;
  longPress: number;
  // As pressed: where, on what
  pressed: PickEvent;
}

// Each display's class, loaded once for every viewer: by its definition's
// load, which plugins' defaults keep
const classes = new Map<RegisteredDisplay['load'], Promise<DisplayClass<Record<string, unknown>>>>();

function loadClass(definition: RegisteredDisplay): Promise<DisplayClass<Record<string, unknown>>> {
  let loaded = classes.get(definition.load);
  if (!loaded) {
    loaded = Promise.resolve().then(() => definition.load());
    classes.set(definition.load, loaded);
    // Tried again by the next viewer, e.g. after a network error
    loaded.catch(() => classes.delete(definition.load));
  }
  return loaded;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toPose(pose: Pose3D): Pose {
  return {
    position: new Vector3(pose[0], pose[1], pose[2]),
    quaternion: new Quaternion(pose[3], pose[4], pose[5], pose[6]).normalize(),
  };
}

// Frees what a display leaves in its root: geometries, materials and their
// textures, labels' elements (which CSS2DObject removes only when itself
// removed from the scene)
function free(root: Object3D): void {
  root.traverse((object) => {
    const { geometry, material } = object as Partial<Mesh>;
    geometry?.dispose();
    for (const m of material ? (Array.isArray(material) ? material : [material]) : []) {
      for (const value of Object.values(m as Material)) {
        if (value instanceof Texture) {
          value.dispose();
        }
      }
      (m as Material).dispose();
    }
    // A flag, not instanceof: a plugin's labels may be of its own copy
    if ((object as { isCSS2DObject?: boolean }).isCSS2DObject) {
      (object as CSS2DObject).element.remove();
    }
  });
}

// Drawn: it, and what it is in
function shown(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (!current.visible) {
      return false;
    }
  }
  return true;
}

export class Viewer {
  private readonly container: HTMLElement;
  private readonly onState: (state: ViewerState) => void;
  private readonly renderer: WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new Scene();
  // ROS's z up is three.js's y up
  private readonly world = new Group();
  private readonly grid: GridHelper;
  private readonly perspective = new PerspectiveCamera(40, 1, 0.01, 100);
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, ORTHO_HEIGHT * 5);
  private readonly orbit: OrbitControls;
  private readonly pan: OrbitControls;
  private view: ViewMode = '3d';
  private readonly slots = new Map<string, Slot>();
  // The enabled displays' ids, in their order, and those of unknown types
  private order: string[] = [];
  private unknown = new Map<string, { name: string; type: string }>();
  // The frame chosen ('' for Auto), and the one the view is in
  private chosenFrame = '';
  private fixedFrame = '';
  private autoFrame = '';
  private frames = new Map<string, FrameState>();
  private frameList: { name: string; parent: string | null }[] = [];
  private frameError: string | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private scale = DEFAULT_SCALE;
  private userMoved = false;
  private renderQueued = 0;
  private stateKey = '';
  private disposed = false;
  // While the displays' onRender run: their render() is this frame
  private rendering = false;
  private readonly observer: ResizeObserver;
  private readonly raycaster = new Raycaster();
  private hovered: Pick | null = null;
  private drag: Drag | null = null;
  // The latest mouse move, checked for what it is over once a frame
  private hoverEvent: PointerEvent | null = null;
  // Where the mouse is over the view, no button pressed: what it is over
  // changes as the view moves too
  private mouse: PointerEvent | null = null;
  private orbiting = false;
  private hoverQueued = 0;
  private menu: { element: HTMLElement; slot: Slot } | null = null;

  constructor(container: HTMLElement, onState: (state: ViewerState) => void) {
    this.container = container;
    this.onState = onState;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.labels.domElement.className = 'robot-labels';
    container.append(this.labels.domElement);

    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);
    this.scene.add(new HemisphereLight(0xffffff, 0x404652, 2.2));
    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(3, 6, 4);
    const fill = new DirectionalLight(0xffffff, 0.9);
    fill.position.set(-4, 2, -3);
    this.scene.add(sun, fill);
    this.grid = new GridHelper(4, 40, 0x8b95a7, 0x8b95a7);
    for (const material of Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]) {
      material.transparent = true;
      material.opacity = 0.22;
    }
    this.scene.add(this.grid);

    this.perspective.position.set(1.2, 0.9, 1.2);
    this.orbit = new OrbitControls(this.perspective, this.renderer.domElement);
    this.orbit.target.set(0, 0.25, 0);
    // From above, ROS's x to the right and y up
    this.ortho.up.set(0, 0, -1);
    this.ortho.position.set(0, ORTHO_HEIGHT, 0);
    this.pan = new OrbitControls(this.ortho, this.renderer.domElement);
    this.pan.enableRotate = false;
    this.pan.screenSpacePanning = true;
    this.pan.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.pan.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };
    this.pan.minZoom = 0.002;
    this.pan.maxZoom = 500;
    for (const controls of [this.orbit, this.pan]) {
      controls.enableDamping = true;
      controls.addEventListener('change', () => {
        this.render();
        if (this.mouse && !this.orbiting && !this.drag) {
          this.queueHover(this.mouse);
        }
      });
      controls.addEventListener('start', () => {
        this.userMoved = true;
        this.orbiting = true;
      });
      controls.addEventListener('end', () => {
        this.orbiting = false;
      });
    }
    this.pan.enabled = false;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    // Before the controls' own, on the canvas: a press on a pickable object
    // does not reach them
    container.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('pointercancel', this.onPointerCancel);
    container.addEventListener('pointerleave', this.onPointerLeave);
    container.addEventListener('contextmenu', this.onContextMenu);
    this.raycaster.params.Points.threshold = 0.02;
    this.subscribeFrames();
  }

  // The widget's displays, in their order: those enabled are created (their
  // class loaded first), configured again when their config changes, and
  // freed when disabled or removed
  setDisplays(displays: ViewerDisplay[]): void {
    const enabled = displays.filter((d) => d.instance.enabled);
    for (const slot of [...this.slots.values()]) {
      const kept = enabled.find((d) => d.instance.id === slot.id);
      if (!kept || kept.definition?.load !== slot.definition.load) {
        this.removeSlot(slot);
      }
    }
    this.unknown = new Map();
    for (const { instance, definition, config } of enabled) {
      const name = instance.name.trim() || definition?.name || instance.type;
      if (!definition) {
        this.unknown.set(instance.id, { name, type: instance.type });
        continue;
      }
      const key = JSON.stringify(config);
      const slot = this.slots.get(instance.id);
      if (!slot) {
        this.createSlot(instance.id, name, definition, config, key);
      } else {
        slot.name = name;
        if (slot.key !== key) {
          const previous = slot.config;
          slot.config = config;
          slot.key = key;
          if (slot.display) {
            this.call(slot, () => slot.display!.configure(config, previous));
          }
        }
      }
    }
    this.order = enabled.map((d) => d.instance.id);
    this.updateFixedFrame();
    this.render();
    this.emit();
  }

  // '' for Auto
  setFixedFrame(frame: string): void {
    this.chosenFrame = normalizeFrame(frame);
    this.updateFixedFrame();
  }

  setView(view: ViewMode): void {
    if (view === this.view) {
      return;
    }
    const halfFov = ((this.perspective.fov / 2) * Math.PI) / 180;
    if (view === '2d') {
      const target = this.orbit.target.clone();
      const distance = this.perspective.position.distanceTo(target);
      this.pan.target.copy(target);
      this.ortho.position.set(target.x, target.y + ORTHO_HEIGHT, target.z);
      this.ortho.zoom = 1 / Math.max(1e-3, distance * Math.tan(halfFov));
      this.ortho.updateProjectionMatrix();
    } else {
      const target = this.pan.target.clone();
      const distance = 1 / (this.ortho.zoom * Math.tan(halfFov));
      const direction = this.perspective.position.clone().sub(this.orbit.target).normalize();
      this.orbit.target.copy(target);
      this.perspective.position.copy(target).addScaledVector(direction, distance);
      this.fitDepth(distance);
    }
    this.view = view;
    this.orbit.enabled = view === '3d';
    this.pan.enabled = view === '2d';
    this.controls().update();
    for (const slot of this.slots.values()) {
      if (slot.display) {
        this.call(slot, () => slot.display!.onViewChange());
      }
    }
    this.render();
  }

  // The view back to what the displays focus on (the robot)
  resetView(): void {
    this.userMoved = false;
    this.fit();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.renderQueued);
    cancelAnimationFrame(this.hoverQueued);
    this.unsubscribeFrames?.();
    this.observer.disconnect();
    this.closeMenu();
    this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('pointercancel', this.onPointerCancel);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    this.container.removeEventListener('contextmenu', this.onContextMenu);
    for (const slot of [...this.slots.values()]) {
      this.removeSlot(slot);
    }
    this.orbit.dispose();
    this.pan.dispose();
    this.grid.dispose();
    this.renderer.dispose();
    // Browsers allow few WebGL contexts: free it now, not when collected
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private controls(): OrbitControls {
    return this.view === '2d' ? this.pan : this.orbit;
  }

  private camera(): PerspectiveCamera | OrthographicCamera {
    return this.view === '2d' ? this.ortho : this.perspective;
  }

  // ── Displays ──

  private createSlot(id: string, name: string, definition: RegisteredDisplay, config: Record<string, unknown>, key: string): void {
    const slot: Slot = {
      id,
      name,
      definition,
      config,
      key,
      display: null,
      gone: false,
      level: 'waiting',
      message: 'Loading…',
      notes: [],
      attached: new Map(),
      cleanups: new Set(),
      suggestion: null,
      pickables: new Map(),
    };
    this.slots.set(id, slot);
    loadClass(definition).then(
      (DisplayType) => {
        if (slot.gone) {
          return;
        }
        slot.level = 'ok';
        slot.message = '';
        try {
          const display = new DisplayType(this.contextOf(slot));
          slot.display = display;
          this.world.add(display.root);
          display.configure(slot.config, null);
        } catch (e) {
          this.fail(slot, e);
        }
        this.render();
        this.emit();
      },
      (e: unknown) => {
        if (!slot.gone) {
          this.fail(slot, new Error(`It could not be loaded: ${errorMessage(e)}`));
        }
      },
    );
  }

  private removeSlot(slot: Slot): void {
    slot.gone = true;
    this.slots.delete(slot.id);
    const { display } = slot;
    if (display) {
      try {
        display.dispose();
      } catch (e) {
        console.error(`Display ${slot.name}:`, e);
      }
    }
    for (const cleanup of [...slot.cleanups]) {
      cleanup();
    }
    slot.attached.clear();
    if (this.menu?.slot === slot) {
      this.closeMenu();
    }
    if (display) {
      display.root.removeFromParent();
      free(display.root);
    }
    if (slot.suggestion && !this.disposed) {
      slot.suggestion = null;
      this.updateFixedFrame();
    }
    this.render();
  }

  // A display's hook, which may throw: its error, not the viewer's
  private call(slot: Slot, hook: () => void): void {
    try {
      hook();
    } catch (e) {
      this.fail(slot, e);
    }
  }

  private fail(slot: Slot, e: unknown): void {
    console.error(`Display ${slot.name}:`, e);
    slot.level = 'error';
    slot.message = errorMessage(e);
    this.emit();
  }

  private contextOf(slot: Slot): DisplayContext {
    const viewer = this;
    return {
      get fixedFrame() {
        return viewer.fixedFrame;
      },
      get view() {
        return viewer.view;
      },
      get scale() {
        return viewer.scale;
      },
      get pixelRatio() {
        return viewer.renderer.getPixelRatio();
      },
      get frames() {
        return viewer.frames;
      },
      pose: (frame) => this.pose(frame),
      attach: (object, frame) => {
        if (slot.gone) {
          return () => {};
        }
        slot.attached.set(object, normalizeFrame(frame));
        this.place(object, frame);
        return () => {
          if (slot.attached.get(object) === normalizeFrame(frame)) {
            slot.attached.delete(object);
          }
        };
      },
      track: (cleanup) => this.track(slot, cleanup),
      render: () => this.render(),
      fit: () => {
        this.updateScale();
        if (!this.userMoved) {
          this.fit();
        }
      },
      setStatus: (level, message) => {
        if (!slot.gone && (slot.level !== level || slot.message !== message)) {
          slot.level = level;
          slot.message = message;
          this.emit();
        }
      },
      setNotes: (notes) => {
        if (!slot.gone && JSON.stringify(notes) !== JSON.stringify(slot.notes)) {
          slot.notes = notes;
          this.emit();
        }
      },
      suggestFixedFrame: (frame) => {
        const suggestion = frame ? normalizeFrame(frame) : null;
        if (!slot.gone && suggestion !== slot.suggestion) {
          slot.suggestion = suggestion;
          this.updateFixedFrame();
        }
      },
      camera: () => this.viewCamera(),
      pickable: (object, handlers) => {
        if (slot.gone) {
          return () => {};
        }
        slot.pickables.set(object, handlers);
        return this.track(slot, () => {
          if (slot.pickables.get(object) === handlers) {
            slot.pickables.delete(object);
            this.forgetPick(object);
          }
        });
      },
      showMenu: (x, y, items) => {
        if (!slot.gone) {
          this.showMenu(slot, x, y, items);
        }
      },
    };
  }

  // Calls cleanup when the slot goes, unless the returned function was called
  // first (which calls it)
  private track(slot: Slot, cleanup: () => void): () => void {
    let done = false;
    const run = () => {
      if (!done) {
        done = true;
        slot.cleanups.delete(run);
        cleanup();
      }
    };
    if (slot.gone) {
      run();
    } else {
      slot.cleanups.add(run);
    }
    return run;
  }

  // ── TF ──

  private pose(frame: string): Pose | null {
    const name = normalizeFrame(frame);
    if (!this.fixedFrame) {
      return null;
    }
    if (name === this.fixedFrame) {
      return { position: new Vector3(), quaternion: new Quaternion() };
    }
    const pose = this.frames.get(name)?.pose;
    return pose ? { position: pose.position.clone(), quaternion: pose.quaternion.clone() } : null;
  }

  // An attached object: at its frame's pose, hidden while it is not known
  private place(object: Object3D, frame: string): void {
    const pose = this.pose(frame);
    object.visible = pose !== null;
    if (pose) {
      object.position.copy(pose.position);
      object.quaternion.copy(pose.quaternion);
    }
  }

  private placeAll(): void {
    for (const slot of this.slots.values()) {
      for (const [object, frame] of slot.attached) {
        this.place(object, frame);
      }
    }
  }

  private subscribeFrames(): void {
    this.unsubscribeFrames?.();
    this.unsubscribeFrames = connection.subscribeTfFrames({ fixedFrame: this.fixedFrame, rate: TF_RATE }, (update) =>
      this.onFrames(update),
    );
  }

  private onFrames(update: TfFramesUpdate): void {
    if (update.fixedFrame !== this.fixedFrame) {
      return;
    }
    const list = update.frames.map(({ name, parent }) => ({ name, parent }));
    if (JSON.stringify(list) !== JSON.stringify(this.frameList)) {
      this.frameList = list;
      // Auto may stand for another frame now
      if (this.updateFixedFrame()) {
        return;
      }
    }
    this.frames = new Map(
      update.frames.map((frame) => [
        frame.name,
        { name: frame.name, parent: frame.parent, pose: frame.pose ? toPose(frame.pose) : null, ageMs: frame.ageMs },
      ]),
    );
    this.frameError = update.error;
    this.placeAll();
    for (const slot of this.slots.values()) {
      if (slot.display) {
        this.call(slot, () => slot.display!.onTransforms());
      }
    }
    this.render();
    this.emit();
  }

  // Works out the fixed frame; true if it changed: the poses were of the
  // former, the displays are told
  private updateFixedFrame(): boolean {
    const suggestions = this.order.map((id) => this.slots.get(id)?.suggestion ?? null);
    this.autoFrame = effectiveFixedFrame('', suggestions, this.frameList);
    const fixedFrame = this.chosenFrame || this.autoFrame;
    if (fixedFrame === this.fixedFrame) {
      this.emit();
      return false;
    }
    this.fixedFrame = fixedFrame;
    this.frames = new Map([...this.frames].map(([name, frame]) => [name, { ...frame, pose: null }]));
    this.frameError = null;
    this.subscribeFrames();
    this.placeAll();
    for (const slot of this.slots.values()) {
      if (slot.display) {
        this.call(slot, () => slot.display!.onFixedFrameChange());
      }
    }
    this.render();
    this.emit();
    return true;
  }

  // ── View ──

  private focusSphere(): Sphere | null {
    const box = new Box3();
    for (const slot of this.slots.values()) {
      let object: Object3D | null = null;
      try {
        object = slot.display?.focus() ?? null;
      } catch (e) {
        this.fail(slot, e);
      }
      if (object) {
        // Its parents too: placed by TF since the last frame drawn, e.g.
        // the robot just found in the fixed frame
        object.updateWorldMatrix(true, true);
        box.expandByObject(object);
      }
    }
    return box.isEmpty() ? null : box.getBoundingSphere(new Sphere());
  }

  private updateScale(): void {
    const sphere = this.focusSphere();
    this.scale = sphere ? Math.max(0.05, sphere.radius) : DEFAULT_SCALE;
  }

  private fit(): void {
    const sphere = this.focusSphere() ?? new Sphere(new Vector3(0, DEFAULT_SCALE / 2, 0), DEFAULT_SCALE);
    const radius = Math.max(0.05, sphere.radius);
    this.scale = radius;
    if (this.view === '2d') {
      const aspect = this.ortho.right / this.ortho.top;
      this.pan.target.copy(sphere.center);
      this.ortho.position.set(sphere.center.x, sphere.center.y + ORTHO_HEIGHT, sphere.center.z);
      this.ortho.zoom = Math.min(1, aspect) / (radius * 1.15);
      this.ortho.updateProjectionMatrix();
      this.pan.update();
    } else {
      const distance = (radius / Math.sin(((this.perspective.fov / 2) * Math.PI) / 180)) * 1.05;
      // From the front left, above: ROS (1, 0.8, 0.7)
      const direction = new Vector3(1, 0.7, -0.8).normalize();
      this.perspective.position.copy(sphere.center).addScaledVector(direction, distance);
      this.orbit.target.copy(sphere.center);
      this.fitDepth(distance);
      this.orbit.update();
    }
    this.render();
  }

  private fitDepth(distance: number): void {
    this.perspective.near = Math.max(1e-3, distance / 100);
    this.perspective.far = Math.max(100, distance * 100);
    this.perspective.updateProjectionMatrix();
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
    const aspect = width / height;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.ortho.left = -aspect;
    this.ortho.right = aspect;
    this.ortho.updateProjectionMatrix();
    this.render();
  }

  // On demand: while the camera glides to a stop (damping), frames keep coming
  private render(): void {
    if (this.disposed || this.rendering) {
      return;
    }
    this.renderQueued ||= requestAnimationFrame(() => {
      this.renderQueued = 0;
      const gliding = this.controls().update();
      const camera = this.camera();
      this.rendering = true;
      for (const slot of this.slots.values()) {
        if (slot.display) {
          this.call(slot, () => slot.display!.onRender());
        }
      }
      this.rendering = false;
      this.renderer.render(this.scene, camera);
      this.labels.render(this.scene, camera);
      if (gliding) {
        this.render();
      }
    });
  }

  // ── Pointer ──

  private toFixed(point: Vector3): Vector3 {
    return this.world.worldToLocal(point.clone());
  }

  private toFixedDirection(direction: Vector3): Vector3 {
    return direction.clone().applyQuaternion(this.world.quaternion.clone().invert()).normalize();
  }

  private viewCamera(): ViewCamera {
    const camera = this.camera();
    camera.updateMatrixWorld();
    this.world.updateMatrixWorld();
    const up = new Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new Quaternion()));
    return {
      position: this.toFixed(camera.getWorldPosition(new Vector3())),
      direction: this.toFixedDirection(camera.getWorldDirection(new Vector3())),
      up: this.toFixedDirection(up),
      orthographic: this.view === '2d',
    };
  }

  // The ray through the pointer, in the scene
  private pointerRay(event: MouseEvent): Ray {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    const camera = this.camera();
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray;
  }

  private pickEvent(event: PointerEvent | MouseEvent, button: number, point: Vector3 | null, object: Object3D | null): PickEvent {
    const sceneRay = this.pointerRay(event);
    this.world.updateMatrixWorld();
    const rect = this.container.getBoundingClientRect();
    return {
      ray: new Ray(this.toFixed(sceneRay.origin), this.toFixedDirection(sceneRay.direction)),
      point,
      object,
      button,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pointerType: (event as PointerEvent).pointerType ?? 'mouse',
    };
  }

  // The nearest pickable object under the pointer, shown: what of it was hit,
  // and where (in the fixed frame)
  private pickAt(event: MouseEvent): { pick: Pick; object: Object3D; point: Vector3 } | null {
    const objects: Object3D[] = [];
    for (const slot of this.slots.values()) {
      objects.push(...slot.pickables.keys());
    }
    if (objects.length === 0) {
      return null;
    }
    this.scene.updateMatrixWorld();
    this.pointerRay(event);
    for (const hit of this.raycaster.intersectObjects(objects, true)) {
      if (!shown(hit.object)) {
        continue;
      }
      for (let object: Object3D | null = hit.object; object; object = object.parent) {
        for (const slot of this.slots.values()) {
          const handlers = slot.pickables.get(object);
          if (handlers) {
            return { pick: { slot, object, handlers }, object: hit.object, point: this.toFixed(hit.point) };
          }
        }
      }
    }
    return null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.menu?.element.contains(event.target as Node)) {
      return;
    }
    this.closeMenu();
    if (this.drag) {
      // Another finger, while one drags: not the controls'
      event.stopPropagation();
      return;
    }
    if (event.button !== 0 && event.button !== 2) {
      return;
    }
    const hit = this.pickAt(event);
    if (!hit) {
      return;
    }
    const { pick } = hit;
    const pickEvent = this.pickEvent(event, event.button, hit.point, hit.object);
    if (event.button === 2) {
      if (!pick.handlers.menu) {
        return;
      }
    } else {
      let taken = false;
      this.call(pick.slot, () => {
        taken = pick.handlers.press?.(pickEvent) === true;
      });
      if (!taken) {
        return;
      }
    }
    event.stopPropagation();
    event.preventDefault();
    const drag: Drag = {
      pick,
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      longPress: 0,
      pressed: pickEvent,
    };
    if (event.button === 0 && event.pointerType !== 'mouse' && pick.handlers.menu) {
      drag.longPress = window.setTimeout(() => {
        if (this.drag === drag && !drag.moved) {
          this.endDrag();
          this.call(pick.slot, () => pick.handlers.release?.(pickEvent, false));
          this.call(pick.slot, () => pick.handlers.menu?.(pickEvent));
        }
      }, LONG_PRESS_MS);
    }
    this.drag = drag;
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone
    }
    this.setHovered(pick, pickEvent);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag) {
      if (event.pointerId !== drag.pointerId) {
        return;
      }
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > CLICK_SLOP) {
        drag.moved = true;
        clearTimeout(drag.longPress);
      }
      if (drag.moved && drag.button === 0) {
        const pickEvent = this.pickEvent(event, 0, null, null);
        this.call(drag.pick.slot, () => drag.pick.handlers.drag?.(pickEvent));
      }
      return;
    }
    // A mouse over the view, not dragging it: what it is over, once a frame
    if (event.pointerType !== 'mouse' || event.buttons !== 0) {
      return;
    }
    this.mouse = event;
    this.queueHover(event);
  };

  private queueHover(event: PointerEvent): void {
    this.hoverEvent = event;
    this.hoverQueued ||= requestAnimationFrame(() => {
      this.hoverQueued = 0;
      const latest = this.hoverEvent;
      this.hoverEvent = null;
      if (latest && !this.drag && !this.disposed) {
        const hit = this.pickAt(latest);
        this.setHovered(hit?.pick ?? null, this.pickEvent(latest, 0, hit?.point ?? null, hit?.object ?? null));
      }
    });
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    this.endDrag();
    const pickEvent = this.pickEvent(event, drag.button, null, null);
    const { slot, handlers } = drag.pick;
    if (drag.button === 2) {
      if (!drag.moved) {
        const menuEvent = { ...pickEvent, point: drag.pressed.point, object: drag.pressed.object };
        this.call(slot, () => handlers.menu?.(menuEvent));
      }
    } else {
      this.call(slot, () => handlers.release?.(pickEvent, !drag.moved));
    }
    if (event.pointerType === 'mouse') {
      const hit = this.pickAt(event);
      this.setHovered(hit?.pick ?? null, this.pickEvent(event, 0, hit?.point ?? null, hit?.object ?? null));
    } else {
      this.setHovered(null, pickEvent);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    this.endDrag();
    const pickEvent = this.pickEvent(event, drag.button, null, null);
    if (drag.button === 0) {
      this.call(drag.pick.slot, () => drag.pick.handlers.release?.(pickEvent, false));
    }
    this.setHovered(null, pickEvent);
  };

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') {
      this.mouse = null;
    }
    if (!this.drag && event.pointerType === 'mouse') {
      this.setHovered(null, this.pickEvent(event, 0, null, null));
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    // The page's own menu, never over the view
    event.preventDefault();
  };

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    this.drag = null;
    clearTimeout(drag.longPress);
    try {
      this.renderer.domElement.releasePointerCapture(drag.pointerId);
    } catch {
      // Released already
    }
  }

  private setHovered(pick: Pick | null, event: PickEvent): void {
    const previous = this.hovered;
    if (previous?.object === pick?.object && previous?.handlers === pick?.handlers) {
      return;
    }
    this.hovered = pick;
    if (previous) {
      this.call(previous.slot, () => previous.handlers.hover?.(false, event));
    }
    if (pick) {
      this.call(pick.slot, () => pick.handlers.hover?.(true, event));
    }
    this.renderer.domElement.style.cursor = pick ? (pick.handlers.cursor ?? 'pointer') : '';
  }

  // A pickable object is no longer: not hovered, nor dragged
  private forgetPick(object: Object3D): void {
    if (this.drag?.pick.object === object) {
      this.endDrag();
    }
    if (this.hovered?.object === object) {
      this.hovered = null;
      this.renderer.domElement.style.cursor = '';
    }
  }

  // ── Menu ──

  private showMenu(slot: Slot, x: number, y: number, items: MenuItem[]): void {
    this.closeMenu();
    if (items.length === 0) {
      return;
    }
    const element = document.createElement('div');
    element.className = 'robot-menu';
    element.setAttribute('role', 'menu');
    this.menu = { element, slot };
    this.container.append(element);
    // A submenu replaces the list, with the way back on top
    const open = (list: MenuItem[], parents: MenuItem[]) => {
      element.replaceChildren();
      const parent = parents.at(-1);
      if (parent) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'robot-menu-back';
        back.textContent = `‹ ${parent.label}`;
        back.addEventListener('click', () => open(parents.length > 1 ? parents.at(-2)!.children! : items, parents.slice(0, -1)));
        element.append(back);
      }
      for (const item of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'robot-menu-item';
        button.setAttribute('role', 'menuitem');
        button.disabled = item.disabled === true;
        const label = document.createElement('span');
        label.textContent = item.label;
        button.append(label);
        if (item.children?.length) {
          const more = document.createElement('span');
          more.className = 'robot-menu-more';
          more.textContent = '›';
          button.append(more);
          button.addEventListener('click', () => open(item.children!, [...parents, item]));
        } else {
          button.addEventListener('click', () => {
            this.closeMenu();
            this.call(slot, () => item.select?.());
          });
        }
        element.append(button);
      }
      this.placeMenu(element, x, y);
      (element.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus({ preventScroll: true });
    };
    open(items, []);
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    window.addEventListener('keydown', this.onMenuKey, true);
  }

  // Within the view, however small
  private placeMenu(element: HTMLElement, x: number, y: number): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    element.style.maxHeight = `${Math.max(60, height - 8)}px`;
    const { offsetWidth: w, offsetHeight: h } = element;
    element.style.left = `${Math.max(4, Math.min(x, width - w - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y, height - h - 4))}px`;
  }

  private closeMenu(): void {
    if (!this.menu) {
      return;
    }
    this.menu.element.remove();
    this.menu = null;
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    window.removeEventListener('keydown', this.onMenuKey, true);
  }

  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (this.menu && !this.menu.element.contains(event.target as Node)) {
      this.closeMenu();
    }
  };

  private readonly onMenuKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeMenu();
    }
  };

  private emit(): void {
    const displays: DisplayState[] = [];
    for (const id of this.order) {
      const slot = this.slots.get(id);
      const unknown = this.unknown.get(id);
      if (slot) {
        displays.push({ id, name: slot.name, level: slot.level, message: slot.message, notes: slot.notes });
      } else if (unknown) {
        displays.push({
          id,
          name: unknown.name,
          level: 'error',
          message: `No display "${unknown.type}": is its plugin installed?`,
          notes: [],
        });
      }
    }
    const state: ViewerState = {
      frames: this.frameList.map((frame) => frame.name),
      fixedFrame: this.fixedFrame,
      autoFrame: this.autoFrame,
      frameError: this.frameError,
      displays,
    };
    const key = JSON.stringify(state);
    if (key !== this.stateKey && !this.disposed) {
      this.stateKey = key;
      this.onState(state);
    }
  }
}
