// The robot model's 3D view: the URDF and its meshes, posed by the joint
// states. A moving joint shows: its child link takes the highlight colour, and
// an arrow at the joint gives the direction of the motion (an arc around a
// revolute joint's axis, a straight arrow along a prismatic one's). The links'
// frames, the robot's TF frames, can be shown as axes (x red, y green, z blue).

import {
  Box3,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
  AxesHelper,
  type Material,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import URDFLoader, { type URDFJoint, type URDFLink, type URDFRobot } from 'urdf-loader';

const HIGHLIGHT = 0xf59e0b;
// Slower than this, a joint is still: rad/s for revolute joints, m/s for
// prismatic ones. Above encoder noise.
const STILL = { rotary: 0.02, linear: 0.002 };
// A joint stays shown as moving this long after it last moved: no flicker
// between joint states, nor when it slows down to turn back
const HOLD_MS = 400;

export interface JointMotion {
  name: string;
  velocity: number;
  unit: 'rad/s' | 'm/s';
}

interface JointState {
  position: number;
  // Of the message, in ms: its stamp, else when it arrived
  time: number;
  velocity: number;
  // Of the last motion: the arrow and the motion list keep them while the
  // joint is still shown as moving
  sign: number;
  motionVelocity: number;
  movingUntil: number;
}

interface Arrow {
  object: Object3D;
  sign: number;
}

// package:// is resolved by URDFLoader.packages; a file:// path into a ROS
// package's share directory (xacro's $(find ...)) is mapped to its package
function meshUrl(url: string): string {
  const shared = /^file:\/\/.*\/share\/([^/]+)\/(.+)$/.exec(url);
  return shared ? `/api/packages/${shared[1]}/${shared[2]}` : url;
}

type MeshDone = (mesh: Object3D, error?: Error) => void;

function loadMesh(url: string, manager: LoadingManager, material: Material, done: MeshDone): void {
  const fail = (error: unknown) => done(null as unknown as Object3D, error instanceof Error ? error : new Error(String(error)));
  const extension = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (extension === 'stl') {
    new STLLoader(manager).load(url, (geometry) => done(new Mesh(geometry, material)), undefined, fail);
  } else if (extension === 'dae') {
    // Collada meshes carry their own materials
    new ColladaLoader(manager).load(
      url,
      (collada) => (collada ? done(collada.scene) : fail(new Error(`Invalid Collada file ${url}`))),
      undefined,
      fail,
    );
  } else if (extension === 'obj') {
    new OBJLoader(manager).load(
      url,
      (group) => {
        group.traverse((child) => {
          if (child instanceof Mesh) {
            child.material = material;
          }
        });
        done(group);
      },
      undefined,
      fail,
    );
  } else {
    fail(new Error(`No loader for ${url}`));
  }
}

// As ROS's URDF parser (and so RViz) does, unlike urdf-loader: a material
// defined with its colour in one link's visual, then named alone in others,
// e.g. <material name="black"/>, has that colour everywhere
function resolveMaterials(urdf: string): Document {
  const document = new DOMParser().parseFromString(urdf, 'text/xml');
  const defined = new Map<string, Element>();
  for (const material of document.querySelectorAll('material[name]')) {
    if (material.children.length > 0 && !defined.has(material.getAttribute('name')!)) {
      defined.set(material.getAttribute('name')!, material);
    }
  }
  for (const material of document.querySelectorAll('material[name]')) {
    const definition = defined.get(material.getAttribute('name')!);
    if (material.children.length === 0 && definition) {
      for (const child of definition.children) {
        material.append(child.cloneNode(true));
      }
    }
  }
  return document;
}

function isJoint(object: Object3D): object is URDFJoint {
  return (object as URDFJoint).isURDFJoint === true;
}

function childLink(joint: URDFJoint): URDFLink | undefined {
  return joint.children.find((child) => (child as URDFLink).isURDFLink) as URDFLink | undefined;
}

// The meshes of the link itself: not those of the links below its joints, nor
// the viewer's own helpers
function linkMeshes(link: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  const visit = (object: Object3D) => {
    for (const child of object.children) {
      if (isJoint(child) || child.userData.helper) {
        continue;
      }
      if (child instanceof Mesh) {
        meshes.push(child);
      }
      visit(child);
    }
  };
  visit(link);
  return meshes;
}

// An arc of a circle in the xy plane, turning counterclockwise about +z
function turnArrow(radius: number, material: Material): Object3D {
  const arrow = new Group();
  const tube = radius * 0.07;
  const arc = 1.5 * Math.PI;
  arrow.add(new Mesh(new TorusGeometry(radius, tube, 8, 48, arc), material));
  const head = new Mesh(new ConeGeometry(tube * 2.8, tube * 7, 16), material);
  // Its +y along the arc's tangent at its end
  const tangent = new Vector3(-Math.sin(arc), Math.cos(arc), 0);
  head.position.set(radius * Math.cos(arc), radius * Math.sin(arc), 0).addScaledVector(tangent, tube * 3);
  head.rotation.z = arc;
  arrow.add(head);
  return arrow;
}

// Along +z, from the joint
function straightArrow(length: number, material: Material): Object3D {
  const arrow = new Group();
  // Built along +y, then turned to +z
  const shape = new Group();
  shape.rotation.x = Math.PI / 2;
  const shaft = new Mesh(new CylinderGeometry(length * 0.05, length * 0.05, length * 0.7, 12), material);
  shaft.position.y = length * 0.35;
  const head = new Mesh(new ConeGeometry(length * 0.14, length * 0.3, 16), material);
  head.position.y = length * 0.85;
  shape.add(shaft, head);
  arrow.add(shape);
  return arrow;
}

function dispose(object: Object3D, keep: Set<Material>): void {
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!keep.has(material)) {
          material.dispose();
        }
      }
    }
  });
}

export class RobotViewer {
  private readonly container: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  // ROS's z up is three.js's y up
  private readonly world = new Group();
  private readonly onMotion: (moving: JointMotion[]) => void;
  private robot: URDFRobot | null = null;
  // Where each joint is in its parent link, before any motion
  private readonly origins = new Map<string, { position: Vector3; quaternion: Quaternion }>();
  private readonly states = new Map<string, JointState>();
  private readonly arrows = new Map<string, Arrow>();
  // The materials of the highlighted meshes, to restore
  private readonly originals = new Map<Mesh, Material | Material[]>();
  private readonly highlightMaterial = new MeshPhongMaterial({ color: HIGHLIGHT, emissive: 0x5c2e00, shininess: 40 });
  // Drawn over everything: the arrow of a joint inside the robot still shows
  private readonly arrowMaterial = new MeshBasicMaterial({ color: HIGHLIGHT, depthTest: false, transparent: true, opacity: 0.95 });
  private frameHelpers: (AxesHelper | CSS2DObject)[] = [];
  private showFrames = false;
  private highlight = true;
  // The robot's bounding radius, which the helpers are sized after
  private radius = 0.5;
  private userMoved = false;
  private motionKey = '';
  private renderQueued = 0;
  private readonly observer: ResizeObserver;
  private readonly timer: number;

  constructor(container: HTMLElement, onMotion: (moving: JointMotion[]) => void) {
    this.container = container;
    this.onMotion = onMotion;
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
    const grid = new GridHelper(4, 40, 0x8b95a7, 0x8b95a7);
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
      material.transparent = true;
      material.opacity = 0.22;
    }
    this.scene.add(grid);

    this.camera.position.set(1.2, 0.9, 1.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.25, 0);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    // Ends the motion of joints whose states stopped coming
    this.timer = window.setInterval(() => this.updateMotion(performance.now()), 100);
  }

  // Resolves with the meshes that could not be loaded, once all the others are
  load(urdf: string, onProgress: (loaded: number, total: number) => void): Promise<string[]> {
    this.clear();
    const manager = new LoadingManager();
    const loader = new URDFLoader(manager);
    loader.parseCollision = false;
    loader.packages = (name: string) => `/api/packages/${encodeURIComponent(name)}`;
    const failed: string[] = [];
    let meshes = 0;
    loader.loadMeshCb = (url, meshManager, material, done) => {
      meshes++;
      loadMesh(meshUrl(url), meshManager, material, (mesh, error) => {
        if (error) {
          failed.push(url);
        }
        done(mesh, error);
        this.requestRender();
      });
    };
    const robot = loader.parse(resolveMaterials(urdf));
    if (Object.keys(robot.links).length === 0) {
      throw new Error('it has no links');
    }
    for (const [name, joint] of Object.entries(robot.joints)) {
      this.origins.set(name, { position: joint.position.clone(), quaternion: joint.quaternion.clone() });
    }
    this.robot = robot;
    this.world.add(robot);
    const ready = () => {
      if (!this.userMoved) {
        this.fit();
      }
      this.addFrames();
      this.requestRender();
      return failed;
    };
    if (meshes === 0) {
      return Promise.resolve(ready());
    }
    return new Promise((resolve) => {
      manager.onProgress = (_url, loaded, total) => onProgress(loaded, total);
      manager.onLoad = () => resolve(ready());
      manager.onError = () => {
        // Reported by the mesh's own callback; onLoad still comes
      };
    });
  }

  // Joint states (sensor_msgs/JointState): poses the robot, and tells which
  // joints move, from their velocity or, when not given, the change of their
  // position since the previous message. stamp: the message's, in seconds;
  // more accurate than when it arrived, which the network jitters.
  setJointStates(names: string[], positions: number[], velocities?: number[], stamp = 0): void {
    const robot = this.robot;
    if (!robot) {
      return;
    }
    const now = performance.now();
    const time = stamp > 0 ? stamp * 1000 : now;
    names.forEach((name, i) => {
      const joint = robot.joints[name];
      const position = positions[i];
      if (!joint || joint.jointType === 'fixed' || !Number.isFinite(position)) {
        return;
      }
      joint.setJointValue(position);
      const previous = this.states.get(name);
      let velocity = velocities?.[i];
      if (previous) {
        let delta = position - previous.position;
        if (joint.jointType === 'continuous') {
          delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        }
        const dt = (time - previous.time) / 1000;
        // Same stamp twice, or a clock jump (a simulation restarting)
        const derived = dt > 0 && dt < 2 ? delta / dt : previous.velocity;
        // Some drivers leave the velocity at 0, or out
        if (velocity === undefined || !Number.isFinite(velocity) || Math.abs(derived) > Math.abs(velocity)) {
          velocity = derived;
        }
      }
      velocity = Number.isFinite(velocity) ? (velocity as number) : 0;
      const moving = Math.abs(velocity) > (joint.jointType === 'prismatic' ? STILL.linear : STILL.rotary);
      this.states.set(name, {
        position,
        time,
        velocity,
        sign: moving ? Math.sign(velocity) : (previous?.sign ?? 1),
        motionVelocity: moving ? velocity : (previous?.motionVelocity ?? 0),
        movingUntil: moving ? now + HOLD_MS : (previous?.movingUntil ?? 0),
      });
    });
    this.updateMotion(now);
    this.requestRender();
  }

  setShowFrames(show: boolean): void {
    this.showFrames = show;
    for (const helper of this.frameHelpers) {
      helper.visible = show;
    }
    this.requestRender();
  }

  setHighlight(highlight: boolean): void {
    this.highlight = highlight;
    this.updateMotion(performance.now());
  }

  // The camera back to the whole robot
  resetView(): void {
    this.userMoved = false;
    this.fit();
  }

  dispose(): void {
    cancelAnimationFrame(this.renderQueued);
    window.clearInterval(this.timer);
    this.observer.disconnect();
    this.controls.dispose();
    this.clear();
    this.highlightMaterial.dispose();
    this.arrowMaterial.dispose();
    this.renderer.dispose();
    // Browsers allow few WebGL contexts: free it now, not when collected
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private clear(): void {
    for (const name of [...this.arrows.keys()]) {
      this.removeArrow(name);
    }
    for (const [mesh, material] of this.originals) {
      mesh.material = material;
    }
    this.originals.clear();
    this.removeFrames();
    if (this.robot) {
      this.world.remove(this.robot);
      dispose(this.robot, new Set([this.highlightMaterial, this.arrowMaterial]));
      this.robot = null;
    }
    this.origins.clear();
    this.states.clear();
    this.motionKey = '';
    this.onMotion([]);
  }

  private fit(): void {
    const box = new Box3().setFromObject(this.world);
    const sphere = box.isEmpty() ? new Sphere(new Vector3(0, 0.25, 0), 0.5) : box.getBoundingSphere(new Sphere());
    this.radius = Math.max(0.05, sphere.radius);
    const distance = (this.radius / Math.sin(((this.camera.fov / 2) * Math.PI) / 180)) * 1.05;
    // From the robot's front left, above: ROS (1, 0.8, 0.7)
    const direction = new Vector3(1, 0.7, -0.8).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.requestRender();
  }

  private addFrames(): void {
    this.removeFrames();
    const robot = this.robot;
    if (!robot) {
      return;
    }
    const size = Math.min(0.25, Math.max(0.02, this.radius * 0.12));
    for (const [name, link] of Object.entries(robot.links)) {
      const axes = new AxesHelper(size);
      for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) {
        material.depthTest = false;
      }
      axes.renderOrder = 10;
      axes.userData.helper = true;
      const element = document.createElement('div');
      element.className = 'robot-frame-label';
      element.textContent = name;
      const label = new CSS2DObject(element);
      // Up and right of the frame's origin
      label.center.set(-0.05, 1.1);
      label.userData.helper = true;
      link.add(axes, label);
      this.frameHelpers.push(axes, label);
    }
    this.setShowFrames(this.showFrames);
  }

  private removeFrames(): void {
    for (const helper of this.frameHelpers) {
      helper.removeFromParent();
      if (helper instanceof CSS2DObject) {
        // CSS2DObject removes its element only when itself removed from the
        // scene, not with the robot
        helper.element.remove();
      } else {
        helper.dispose();
      }
    }
    this.frameHelpers = [];
  }

  private updateMotion(now: number): void {
    const robot = this.robot;
    if (!robot) {
      return;
    }
    const moving: JointMotion[] = [];
    let changed = false;
    for (const [name, state] of this.states) {
      const joint = robot.joints[name];
      const on = this.highlight && now < state.movingUntil;
      changed = this.setMoving(joint, on, state.sign) || changed;
      if (on) {
        moving.push({ name, velocity: state.motionVelocity, unit: joint.jointType === 'prismatic' ? 'm/s' : 'rad/s' });
      }
    }
    if (changed) {
      this.requestRender();
    }
    const key = moving.map((m) => `${m.name} ${m.velocity.toFixed(2)}`).join();
    if (key !== this.motionKey) {
      this.motionKey = key;
      this.onMotion(moving);
    }
  }

  // Shows the joint as moving or not; true if that changed anything
  private setMoving(joint: URDFJoint, on: boolean, sign: number): boolean {
    const name = joint.urdfName;
    const arrow = this.arrows.get(name);
    const link = childLink(joint);
    if (!on) {
      if (!arrow) {
        return false;
      }
      this.removeArrow(name);
      for (const mesh of link ? linkMeshes(link) : []) {
        mesh.material = this.originals.get(mesh) ?? mesh.material;
        this.originals.delete(mesh);
      }
      return true;
    }
    if (arrow?.sign === sign) {
      return false;
    }
    if (arrow) {
      // Turned back: the arrow too
      this.removeArrow(name);
    } else {
      for (const mesh of link ? linkMeshes(link) : []) {
        this.originals.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(() => this.highlightMaterial)
          : this.highlightMaterial;
      }
    }
    this.arrows.set(name, { object: this.createArrow(joint, link, sign), sign });
    return true;
  }

  // In the joint's parent link, where the joint is before it moves: the arrow
  // stays put while the child link turns
  private createArrow(joint: URDFJoint, link: URDFLink | undefined, sign: number): Object3D {
    const origin = this.origins.get(joint.urdfName);
    const holder = new Group();
    holder.position.copy(origin?.position ?? joint.position);
    holder.quaternion.copy(origin?.quaternion ?? joint.quaternion);
    // Around the link: a wheel's arc circles the wheel
    const box = new Box3();
    for (const mesh of link ? linkMeshes(link) : []) {
      box.expandByObject(mesh);
    }
    const linkRadius = box.isEmpty() ? 0 : box.getBoundingSphere(new Sphere()).radius;
    const size = Math.min(this.radius * 0.4, Math.max(this.radius * 0.08, linkRadius * 1.15));
    const arrow =
      joint.jointType === 'prismatic'
        ? straightArrow(size * 1.6, this.arrowMaterial)
        : turnArrow(size, this.arrowMaterial);
    // Its z along the joint's axis, the other way when moving backwards
    const axis = joint.axis.clone().normalize().multiplyScalar(sign < 0 ? -1 : 1);
    arrow.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), axis);
    holder.add(arrow);
    holder.traverse((object) => {
      object.userData.helper = true;
      object.renderOrder = 20;
    });
    joint.parent?.add(holder);
    return holder;
  }

  private removeArrow(name: string): void {
    const arrow = this.arrows.get(name);
    if (arrow) {
      arrow.object.removeFromParent();
      dispose(arrow.object, new Set([this.arrowMaterial]));
      this.arrows.delete(name);
    }
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.renderer.setSize(width, height);
    this.labels.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // On demand, not in a loop: a still robot costs nothing. While the camera
  // glides to a stop (damping), frames keep coming.
  private requestRender(): void {
    this.renderQueued ||= requestAnimationFrame(() => {
      this.renderQueued = 0;
      const gliding = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      if (gliding) {
        this.requestRender();
      }
    });
  }
}
