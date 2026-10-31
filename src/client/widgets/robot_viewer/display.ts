// A display of the Robot Viewer, as RViz's: what draws one kind of thing in its
// 3D view, e.g. the robot model or a laser scan. Tassello's displays and the
// plugins' extend Display, given by tassello/viewer, and are registered by a
// definition (defineDisplay, see ../types.ts) whose properties people edit in
// the side panel, as a widget's.
//
// A display puts its three.js objects in its root, which the viewer places in
// the fixed frame, with ROS's axes: x forward, y left, z up. It reaches the
// robot through `connection` (topics, grids, points, plugins' streams) and
// places what it draws by TF: `pose`, `place` and `attach` give a frame's pose
// in the fixed frame, as the viewer keeps it (about 15 times a second).
//
//   export class PoseDisplay extends Display<PoseConfig> {
//     private readonly arrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(), 0.5, 0xff0000);
//     constructor(context: DisplayContext) {
//       super(context);
//       this.root.add(this.arrow);
//     }
//     configure(config: PoseConfig, previous: PoseConfig | null) {
//       if (config.topic === previous?.topic) return;
//       this.unsubscribe?.();
//       this.unsubscribe = this.subscribeTopic<PoseStamped>(config.topic, { types: [POSE_STAMPED] }, (message) => {
//         this.attach(this.arrow, message.header.frame_id);
//         this.render();
//       });
//     }
//   }
//
// The viewer frees, with the display, its root and what is in it (geometries,
// materials, textures, labels), and what it tracks (its subscriptions):
// dispose() is for the rest, e.g. timers.

import { Group, type Object3D, type Quaternion, type Vector3 } from 'three';

import { connection, type Connection } from '../../connection.ts';

export type ViewMode = '3d' | '2d';

// 'waiting' and 'error' while it has nothing to show: the viewer says why in
// its middle if no display has anything to show, else in a note
export type DisplayStatusLevel = 'ok' | 'waiting' | 'warn' | 'error';

export interface DisplayNote {
  text: string;
  // 'info' at the top right, e.g. what is loading; 'accent' in the highlight
  // colour, e.g. the moving joints; 'warn' as problems
  tone?: 'info' | 'accent' | 'warn';
}

// In the fixed frame, with ROS's axes
export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

export interface FrameState {
  name: string;
  // null for the root of a tree
  parent: string | null;
  // In the fixed frame; null if not connected to it
  pose: Pose | null;
  // Since its transform from its parent arrived, in ms; null if static
  ageMs: number | null;
}

// What the viewer gives each of its displays
export interface DisplayContext {
  // The frame the view is in, which everything is placed in by TF
  readonly fixedFrame: string;
  readonly view: ViewMode;
  // The radius, in meters, of what the view fits on Reset (the robot), which
  // helpers are sized after; 0.5 until known
  readonly scale: number;
  // The device pixels of a CSS pixel, as the viewer renders them: points
  // sized in pixels are this much larger
  readonly pixelRatio: number;
  // Every TF frame, by name
  readonly frames: ReadonlyMap<string, FrameState>;
  // The pose of a frame in the fixed frame, null if not known
  pose(frame: string): Pose | null;
  // Keeps object at the frame's pose, hidden while it is not known, until
  // the returned function is called or the display goes
  attach(object: Object3D, frame: string): () => void;
  // Calls cleanup when the display goes, unless the returned function was
  // called first (which calls it)
  track(cleanup: () => void): () => void;
  // Draws the view again: after changing objects
  render(): void;
  // What the display focuses on (focus()) changed: the view fits it, unless
  // people moved the view
  fit(): void;
  setStatus(level: DisplayStatusLevel, message: string): void;
  setNotes(notes: DisplayNote[]): void;
  // The frame the view should be in when its fixed frame is Auto: the robot
  // model's root link. null: none
  suggestFixedFrame(frame: string | null): void;
}

export type DisplayClass<C> = new (context: DisplayContext) => Display<C>;

export function normalizeFrame(frame: string): string {
  return frame.trim().replace(/^\/+/, '');
}

export abstract class Display<C = Record<string, unknown>> {
  // Its objects, in the fixed frame. Freed with it.
  readonly root = new Group();
  protected readonly context: DisplayContext;
  protected readonly connection: Connection = connection;

  constructor(context: DisplayContext) {
    this.context = context;
  }

  // Its properties' values: when it starts, then whenever they change, with
  // those it had (previous): subscribe, or subscribe again, and draw
  abstract configure(config: C, previous: C | null): void;

  // The frames' poses were updated: the objects attached were placed
  onTransforms(): void {}

  // The fixed frame changed: what the server placed in the former (points),
  // ask for again
  onFixedFrameChange(): void {}

  // The view changed between 3D and 2D (context.view)
  onViewChange(): void {}

  // What the view fits on Reset, if anything: the robot
  focus(): Object3D | null {
    return null;
  }

  // Frees what is neither in its root nor tracked, e.g. timers
  dispose(): void {}

  protected get fixedFrame(): string {
    return this.context.fixedFrame;
  }

  protected pose(frame: string): Pose | null {
    return this.context.pose(frame);
  }

  // Puts object at the frame's pose now; false if it is not known
  protected place(object: Object3D, frame: string): boolean {
    const pose = this.context.pose(frame);
    if (pose) {
      object.position.copy(pose.position);
      object.quaternion.copy(pose.quaternion);
    }
    return pose !== null;
  }

  protected attach(object: Object3D, frame: string): () => void {
    return this.context.attach(object, frame);
  }

  protected render(): void {
    this.context.render();
  }

  protected setStatus(level: DisplayStatusLevel, message = ''): void {
    this.context.setStatus(level, message);
  }

  protected setNotes(notes: DisplayNote[]): void {
    this.context.setNotes(notes);
  }

  // Why a frame has no pose: for a status
  protected missingFrame(frame: string): string {
    const name = normalizeFrame(frame);
    if (!this.fixedFrame) {
      return 'No fixed frame';
    }
    return this.context.frames.has(name)
      ? `No transform from "${name}" to "${this.fixedFrame}"`
      : `Frame "${name}" does not exist`;
  }

  // A topic's messages, as JSON, at most maxRate a second (10 by default),
  // until the returned function is called or the display goes. Its status is
  // the display's (unless status is false): waiting, an error, or ok once a
  // message of one of the types (any if none given) came.
  protected subscribeTopic<T>(
    topic: string,
    { maxRate = 10, types, status = true }: { maxRate?: number; types?: string[]; status?: boolean },
    onMessage: (message: T, messageType: string) => void,
  ): () => void {
    const unsubscribe = this.connection.subscribeTopic(
      { topic, maxRate },
      {
        status: (state, message) => {
          if (status && state !== 'streaming') {
            this.setStatus(state, message);
          }
        },
        message: (messageType, message) => {
          if (types && !types.includes(messageType)) {
            if (status) {
              this.setStatus('error', `${topic} is a ${messageType}, not a ${types.join(' or ')}`);
            }
            return;
          }
          if (status) {
            this.setStatus('ok');
          }
          onMessage(message as T, messageType);
        },
      },
    );
    return this.context.track(unsubscribe);
  }
}
