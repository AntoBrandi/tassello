// The Robot Viewer's view: a three.js scene of displays (display.ts), in a
// fixed frame, seen in 3D (orbited) or from above in 2D (panned). It follows
// TF in the fixed frame for its displays, which it loads, configures and frees
// as the widget's list of them changes; one that throws shows its error, the
// others carry on.
//
// Drag to orbit (3D) or pan (2D), right drag (two fingers) to pan, scroll
// (pinch) to zoom. Rendered on demand, not in a loop: a still view costs
// nothing.

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
  Scene,
  Sphere,
  Texture,
  TOUCH,
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
  type Pose,
  type ViewMode,
} from './display.ts';
import { effectiveFixedFrame } from './model.ts';

// TF updates a second: what moves in the fixed frame, e.g. the robot in odom
const TF_RATE = 15;
// The view's radius until a display gives what to focus on
const DEFAULT_SCALE = 0.5;
// The 2D camera, this far above what it looks at
const ORTHO_HEIGHT = 200;

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
  private readonly observer: ResizeObserver;

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
      controls.addEventListener('change', () => this.render());
      controls.addEventListener('start', () => {
        this.userMoved = true;
      });
    }
    this.pan.enabled = false;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
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
    this.unsubscribeFrames?.();
    this.observer.disconnect();
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
      track: (cleanup) => {
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
      },
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
    };
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
    if (this.disposed) {
      return;
    }
    this.renderQueued ||= requestAnimationFrame(() => {
      this.renderQueued = 0;
      const gliding = this.controls().update();
      const camera = this.camera();
      this.renderer.render(this.scene, camera);
      this.labels.render(this.scene, camera);
      if (gliding) {
        this.render();
      }
    });
  }

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
