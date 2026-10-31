// The robot in 3D, from its description (URDF) and joint states, as the Robot
// Model widget drew it: a moving joint shows, its child link taking the
// highlight colour, and an arrow at the joint giving the direction of the
// motion. Its root link is placed in the fixed frame by TF, and is what Auto
// stands for: the robot alone, where its joint states put its links.

import { Box3, Group, MeshBasicMaterial, MeshPhongMaterial, Quaternion, Sphere, Vector3, type Material, type Mesh, type Object3D } from 'three';
import type { URDFJoint, URDFLink, URDFRobot } from 'urdf-loader';

import { Display, type DisplayContext, type DisplayNote } from '../display.ts';
import type { RobotModelDisplayConfig } from './index.ts';
import { childLink, disposeObject, linkMeshes, loadRobot, straightArrow, turnArrow } from './urdf.ts';

const STRING = 'std_msgs/msg/String';
const JOINT_STATE = 'sensor_msgs/msg/JointState';
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

interface JointStateMessage {
  header: { stamp: { sec: number; nanosec: number } };
  name: string[];
  position: number[];
  velocity: number[];
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

export class RobotModelDisplay extends Display<RobotModelDisplayConfig> {
  // Where TF puts the robot's root link
  private readonly holder = new Group();
  private robot: URDFRobot | null = null;
  private description = '';
  private unsubscribeDescription: (() => void) | null = null;
  private unsubscribeJoints: (() => void) | null = null;
  // Why the robot is not shown, or not where it should be
  private problem: { level: 'waiting' | 'error'; message: string } | null = null;
  private jointsProblem: string | null = null;
  private loading: { loaded: number; total: number } | null = null;
  private failedMeshes: string[] = [];
  private moving: JointMotion[] = [];
  // Where each joint is in its parent link, before any motion
  private readonly origins = new Map<string, { position: Vector3; quaternion: Quaternion }>();
  private readonly states = new Map<string, JointState>();
  private readonly arrows = new Map<string, Arrow>();
  // The materials of the highlighted meshes, to restore
  private readonly originals = new Map<Mesh, Material | Material[]>();
  private readonly highlightMaterial = new MeshPhongMaterial({ color: HIGHLIGHT, emissive: 0x5c2e00, shininess: 40 });
  // Drawn over everything: the arrow of a joint inside the robot still shows
  private readonly arrowMaterial = new MeshBasicMaterial({ color: HIGHLIGHT, depthTest: false, transparent: true, opacity: 0.95 });
  private highlight = true;
  // Whether TF placed the robot since it loaded, or since the fixed frame
  // changed: the view fits it then
  private placed = false;
  private motionKey = '';
  private readonly timer: number;

  constructor(context: DisplayContext) {
    super(context);
    this.root.add(this.holder);
    // Ends the motion of joints whose states stopped coming
    this.timer = window.setInterval(() => this.updateMotion(performance.now()), 100);
  }

  configure(config: RobotModelDisplayConfig, previous: RobotModelDisplayConfig | null): void {
    if (config.descriptionTopic !== previous?.descriptionTopic) {
      this.subscribeDescription(config.descriptionTopic.trim());
    }
    if (config.jointStatesTopic !== previous?.jointStatesTopic) {
      this.subscribeJoints(config.jointStatesTopic.trim());
    }
    if (config.highlightMotion !== previous?.highlightMotion) {
      this.highlight = config.highlightMotion;
      this.updateMotion(performance.now());
    }
  }

  onTransforms(): void {
    this.updateStatus();
  }

  onFixedFrameChange(): void {
    this.placed = false;
    this.updateStatus();
  }

  focus(): Object3D | null {
    return this.robot && this.holder.visible ? this.robot : null;
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.clear();
    this.highlightMaterial.dispose();
    this.arrowMaterial.dispose();
  }

  private subscribeDescription(topic: string): void {
    this.unsubscribeDescription?.();
    this.unsubscribeDescription = null;
    this.description = '';
    this.clear();
    if (!topic) {
      this.problem = { level: 'error', message: 'No robot description topic: set one in edit mode' };
      this.updateStatus();
      return;
    }
    this.problem = { level: 'waiting', message: 'Connecting…' };
    this.updateStatus();
    const unsubscribe = this.connection.subscribeTopic(
      { topic, maxRate: 1 },
      {
        status: (state, message) => {
          // Until the robot is shown: later, it stays as it was
          if (state !== 'streaming' && !this.robot) {
            this.problem = { level: state, message };
            this.updateStatus();
          }
        },
        message: (messageType, message) => {
          if (messageType !== STRING) {
            this.problem = { level: 'error', message: `${topic} is a ${messageType}, not a ${STRING}` };
            this.updateStatus();
            return;
          }
          this.load(topic, (message as { data?: unknown }).data);
        },
      },
    );
    this.unsubscribeDescription = this.context.track(unsubscribe);
  }

  private load(topic: string, urdf: unknown): void {
    if (typeof urdf !== 'string') {
      this.problem = { level: 'error', message: `${topic} has no URDF` };
      this.updateStatus();
      return;
    }
    // The same description again, e.g. after a reconnection
    if (urdf === this.description) {
      return;
    }
    this.description = urdf;
    this.clear();
    this.placed = false;
    let loaded;
    try {
      loaded = loadRobot(
        urdf,
        (done, total) => {
          if (this.description === urdf) {
            this.loading = { loaded: done, total };
            this.updateNotes();
          }
        },
        () => this.render(),
      );
    } catch (e) {
      this.problem = { level: 'error', message: `Invalid robot description: ${e instanceof Error ? e.message : e}` };
      this.updateStatus();
      return;
    }
    const { robot } = loaded;
    for (const [name, joint] of Object.entries(robot.joints)) {
      this.origins.set(name, { position: joint.position.clone(), quaternion: joint.quaternion.clone() });
    }
    this.robot = robot;
    this.holder.add(robot);
    this.problem = null;
    // The robot's root link: where it is, and the view's frame on Auto
    this.attach(this.holder, robot.urdfName);
    this.context.suggestFixedFrame(robot.urdfName);
    this.updateStatus();
    this.render();
    loaded.meshes.then((failed) => {
      if (this.robot === robot) {
        this.loading = null;
        this.failedMeshes = failed;
        this.updateNotes();
        this.context.fit();
        this.render();
      }
    });
  }

  private subscribeJoints(topic: string): void {
    this.unsubscribeJoints?.();
    this.unsubscribeJoints = null;
    this.jointsProblem = null;
    this.updateNotes();
    if (!topic) {
      return;
    }
    const unsubscribe = this.connection.subscribeTopic(
      { topic, maxRate: 20 },
      {
        status: (state, message) => {
          this.jointsProblem = state === 'streaming' ? null : message;
          this.updateNotes();
        },
        message: (messageType, message) => {
          if (messageType !== JOINT_STATE) {
            this.jointsProblem = `${topic} is a ${messageType}, not a ${JOINT_STATE}`;
            this.updateNotes();
            return;
          }
          const { header, name, position, velocity } = message as JointStateMessage;
          this.setJointStates(
            name,
            position,
            velocity.length === name.length ? velocity : undefined,
            header.stamp.sec + header.stamp.nanosec * 1e-9,
          );
        },
      },
    );
    this.unsubscribeJoints = this.context.track(unsubscribe);
  }

  private updateStatus(): void {
    if (this.problem) {
      this.setStatus(this.problem.level, this.problem.message);
    } else if (this.robot && !this.pose(this.robot.urdfName)) {
      this.setStatus('warn', this.missingFrame(this.robot.urdfName));
    } else {
      this.setStatus('ok');
      if (this.robot && !this.placed) {
        this.placed = true;
        this.context.fit();
      }
    }
  }

  private updateNotes(): void {
    const notes: DisplayNote[] = [];
    if (this.highlight) {
      for (const joint of this.moving) {
        notes.push({
          text: `${joint.velocity >= 0 ? '+' : '−'} ${joint.name} ${Math.abs(joint.velocity).toFixed(2)} ${joint.unit}`,
          tone: 'accent',
        });
      }
    }
    if (this.loading && this.loading.loaded < this.loading.total) {
      notes.push({ text: `Loading meshes ${this.loading.loaded}/${this.loading.total}`, tone: 'info' });
    }
    if (this.jointsProblem && this.robot) {
      notes.push({ text: `Joints still: ${this.jointsProblem}`, tone: 'warn' });
    }
    if (this.failedMeshes.length > 0) {
      notes.push({ text: `${this.failedMeshes.length} mesh(es) could not be loaded`, tone: 'warn' });
    }
    this.setNotes(notes);
  }

  private clear(): void {
    for (const name of [...this.arrows.keys()]) {
      this.removeArrow(name);
    }
    for (const [mesh, material] of this.originals) {
      mesh.material = material;
    }
    this.originals.clear();
    if (this.robot) {
      this.holder.remove(this.robot);
      disposeObject(this.robot, new Set([this.highlightMaterial, this.arrowMaterial]));
      this.robot = null;
      this.context.suggestFixedFrame(null);
    }
    this.origins.clear();
    this.states.clear();
    this.motionKey = '';
    this.moving = [];
    this.loading = null;
    this.failedMeshes = [];
    this.updateNotes();
    this.render();
  }

  // Joint states (sensor_msgs/JointState): poses the robot, and tells which
  // joints move, from their velocity or, when not given, the change of their
  // position since the previous message. stamp: the message's, in seconds;
  // more accurate than when it arrived, which the network jitters.
  private setJointStates(names: string[], positions: number[], velocities?: number[], stamp = 0): void {
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
    this.render();
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
      this.render();
    }
    const key = moving.map((m) => `${m.name} ${m.velocity.toFixed(2)}`).join();
    if (key !== this.motionKey) {
      this.motionKey = key;
      this.moving = moving;
      this.updateNotes();
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
    const radius = this.context.scale;
    const size = Math.min(radius * 0.4, Math.max(radius * 0.08, linkRadius * 1.15));
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
      disposeObject(arrow.object, new Set([this.arrowMaterial]));
      this.arrows.delete(name);
    }
  }
}
