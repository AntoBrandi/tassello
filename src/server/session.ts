// One WebSocket connection, i.e. one open dashboard page: dispatches its
// messages and owns what it started (teleop streams, subscriptions), released
// when it closes.

import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import {
  FRAME_HEADER_BYTES,
  type ClientMessage,
  type GridStyle,
  type ImageTransport,
  type ServerMessage,
} from '../shared/protocol.ts';
import type { PluginSession } from './api.ts';
import type { Arm, ArmWatcher } from './arm.ts';
import type { BehaviorTreeFiles } from './behavior_tree_files.ts';
import type { BehaviorTreePlayback } from './behavior_tree_playback.ts';
import type { BehaviorTrees } from './behavior_trees.ts';
import type { CommandRunner } from './commands.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { Consumer, EncodedFrame, FrameSink, StreamState } from './frame_stream.ts';
import type { Networking } from './networking.ts';
import { checkRequest, deviceOfAddress } from './networking_format.ts';
import type { Poses } from './poses.ts';
import type { Paths } from './paths.ts';
import type { PluginHost } from './plugins.ts';
import type { Ros } from './ros.ts';
import type { Rosout } from './rosout.ts';
import type { FrameStreams } from './streams.ts';
import type { SystemdServices } from './systemd.ts';
import type { Teleop } from './teleop.ts';
import type { Terminals, TerminalView } from './terminals.ts';
import type { Tf } from './tf.ts';
import type { Topics } from './topics.ts';
import { errorMessage, toJson } from './util.ts';

export interface SessionServices {
  teleop: Teleop;
  streams: FrameStreams;
  tf: Tf;
  paths: Paths;
  topics: Topics;
  poses: Poses;
  commands: CommandRunner;
  systemd: SystemdServices;
  arm: Arm;
  ros: Ros;
  rosout: Rosout;
  diagnostics: Diagnostics;
  terminals: Terminals;
  networking: Networking;
  behaviorTrees: BehaviorTrees;
  behaviorTreeFiles: BehaviorTreeFiles;
  plugins: PluginHost;
  hostname: string;
}

// The same error is reported to the page at most this often: a teleop widget
// publishing on an invalid topic would otherwise report it 10 times a second
const ERROR_REPEAT_MS = 5000;
const TRANSPORTS: ImageTransport[] = ['auto', 'raw', 'compressed'];
const GRID_STYLES: GridStyle[] = ['map', 'costmap'];
// Jog speeds, rad/s or m/s: the arm's own limits are lower
const MAX_JOINT_SPEED = 5;
const MAX_CARTESIAN_SPEED = 0.5;

// Message fields, checked: the page is trusted to be ours, not to be right
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function number(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function velocity(value: unknown): number {
  return number(value, -100, 100, 0);
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${field} must be a list of strings`);
  }
  return value.map((v: string) => v.trim()).filter(Boolean);
}

// A terminal's name, chosen by the page
const TERMINAL_NAME = /^[\w-]{1,64}$/;

function subscriptionId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('Invalid subscription id');
  }
  return value;
}

export class Session implements FrameSink, PluginSession {
  readonly id = randomUUID();
  private readonly ws: WebSocket;
  private readonly services: SessionServices;
  // Every subscription, by id: what ends it
  private readonly subscriptions = new Map<number, () => void>();
  // Those that stream frames, to acknowledge them
  private readonly consumers = new Map<number, Consumer>();
  // The arm subscriptions, for their jogs
  private readonly arms = new Map<number, ArmWatcher>();
  // The behavior tree playbacks, for their controls
  private readonly playbacks = new Map<number, BehaviorTreePlayback>();
  // The terminals, for what is typed in them
  private readonly terminals = new Map<number, TerminalView>();
  // The page is one of the dashboard's own (see ownPage): only those open
  // terminals and change the networks
  private readonly ownPage: boolean;
  // The server's address the page reached: the interface it comes through
  private readonly localAddress: string | null;
  private lastError = { message: '', at: 0 };

  constructor(ws: WebSocket, services: SessionServices, ownPage: boolean, localAddress: string | null) {
    this.ws = ws;
    this.services = services;
    this.ownPage = ownPage;
    this.localAddress = localAddress;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.onMessage(data.toString());
      }
    });
    this.send({ type: 'hello', clientId: this.id, hostname: services.hostname, time: Date.now() });
    this.send({ type: 'commands', states: services.commands.snapshot() });
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendStreamStatus(id: number, state: StreamState, message: string): void {
    this.send({ type: 'stream.status', id, state, message });
  }

  sendFrame(id: number, frame: EncodedFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const meta = frame.meta ? Buffer.from(JSON.stringify(frame.meta)) : Buffer.alloc(0);
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(id, 0);
    header.writeUInt8(frame.format, 4);
    header.writeUInt16BE(Math.min(frame.width, 0xffff), 5);
    header.writeUInt16BE(Math.min(frame.height, 0xffff), 7);
    header.writeUInt16BE(meta.length, 9);
    this.ws.send(Buffer.concat([header, meta, frame.data]));
  }

  // The connection closed
  close(): void {
    this.services.teleop.release(this.id);
    for (const end of this.subscriptions.values()) {
      end();
    }
    this.subscriptions.clear();
    this.consumers.clear();
    this.arms.clear();
    this.playbacks.clear();
    this.terminals.clear();
  }

  private reportError(message: string): void {
    const now = Date.now();
    if (message === this.lastError.message && now - this.lastError.at < ERROR_REPEAT_MS) {
      return;
    }
    this.lastError = { message, at: now };
    this.send({ type: 'error', message });
  }

  private onMessage(text: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      this.reportError('Malformed message');
      return;
    }
    try {
      this.dispatch(message);
    } catch (e) {
      this.reportError(errorMessage(e));
    }
  }

  private dispatch(message: ClientMessage): void {
    const { services } = this;
    switch (message.type) {
      case 'twist':
        services.teleop.command(this.id, {
          type: 'twist',
          topic: string(message.topic, 'topic'),
          stamped: message.stamped === true,
          frameId: typeof message.frameId === 'string' ? message.frameId : '',
          linear: { x: velocity(message.linear?.x), y: velocity(message.linear?.y) },
          angular: { z: velocity(message.angular?.z) },
        });
        return;

      case 'image.subscribe': {
        const id = subscriptionId(message.id);
        this.addConsumer(
          id,
          services.streams.image(this, id, {
            topic: string(message.topic, 'topic'),
            transport: TRANSPORTS.includes(message.transport) ? message.transport : 'auto',
            maxFps: number(message.maxFps, 0.1, 60, 10),
            quality: Math.round(number(message.quality, 1, 100, 75)),
            maxWidth: Math.round(number(message.maxWidth, 0, 8192, 0)),
          }),
        );
        return;
      }

      case 'grid.subscribe': {
        const id = subscriptionId(message.id);
        this.addConsumer(
          id,
          services.streams.grid(this, id, {
            topic: string(message.topic, 'topic'),
            style: GRID_STYLES.includes(message.style) ? message.style : 'map',
            maxFps: number(message.maxFps, 0.1, 30, 1),
          }),
        );
        return;
      }

      case 'tf.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.tf.watch(
            string(message.targetFrame, 'targetFrame'),
            string(message.sourceFrame, 'sourceFrame'),
            number(message.rate, 0.1, 50, 10),
            (result) => this.send({ type: 'tf', id, ...result }),
          ),
        );
        return;
      }

      case 'path.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.paths.watch(string(message.topic, 'topic'), (path) => this.send({ type: 'path', id, ...path })),
        );
        return;
      }

      case 'topic.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.topics.watch(string(message.topic, 'topic'), {
            minIntervalMs: 1000 / number(message.maxRate, 0.1, 100, 10),
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
            onMessage: (messageType, content) => this.send({ type: 'message', id, messageType, message: content }),
          }),
        );
        return;
      }

      case 'bt.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.behaviorTrees.watch(string(message.topic, 'topic'), optionalString(message.tree), {
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
            onTree: (tree) => this.send({ type: 'bt.tree', id, ...tree }),
            onUpdate: (update) => this.send({ type: 'bt', id, ...update }),
            onRecording: (recording) => this.send({ type: 'bt.recording', id, recording }),
          }),
        );
        return;
      }

      case 'bt.record':
        this.answer(
          message.id,
          services.behaviorTrees.record(
            string(message.topic, 'topic'),
            message.path === null ? null : string(message.path, 'path'),
          ),
        );
        return;

      case 'bt.playback': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        const playback = services.behaviorTrees.play(
          string(message.bag, 'bag'),
          optionalString(message.topic),
          optionalString(message.tree),
          {
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
            onTree: (tree) => this.send({ type: 'bt.tree', id, ...tree }),
            onUpdate: (update) => this.send({ type: 'bt', id, ...update }),
            onPlayback: (state) => this.send({ type: 'bt.playback.state', id, ...state }),
          },
        );
        this.playbacks.set(id, playback);
        this.subscriptions.set(id, () => playback.close());
        return;
      }

      case 'bt.playback.control':
        this.playbacks.get(subscriptionId(message.id))?.control({
          playing: typeof message.playing === 'boolean' ? message.playing : undefined,
          speed: typeof message.speed === 'number' ? message.speed : undefined,
          time: typeof message.time === 'number' ? message.time : undefined,
        });
        return;

      case 'bt.file.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        const libraries = Array.isArray(message.libraries) ? strings(message.libraries, 'libraries') : [];
        this.subscriptions.set(
          id,
          services.behaviorTreeFiles.watch(string(message.path, 'path'), libraries, {
            onFile: (file) => this.send({ type: 'bt.file', id, ...file }),
            onModels: (models) => this.send({ type: 'bt.models', id, ...models }),
          }),
        );
        return;
      }

      case 'bt.file.save':
        if (typeof message.text !== 'string') {
          throw new Error('text must be a string');
        }
        this.answer(
          message.id,
          services.behaviorTreeFiles.save(
            string(message.path, 'path'),
            message.text,
            typeof message.base === 'string' ? message.base : null,
            message.create === true,
          ),
        );
        return;

      case 'rosout.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.rosout.watch(string(message.topic, 'topic'), {
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
            onUpdate: (update) => this.send({ type: 'rosout', id, ...update }),
          }),
        );
        return;
      }

      case 'diagnostics.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.diagnostics.watch(string(message.topic, 'topic'), {
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
            onUpdate: (update) => this.send({ type: 'diagnostics', id, ...update }),
          }),
        );
        return;
      }

      case 'terminal.open': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        if (!this.ownPage) {
          // e.g. another site's page, which a browser lets reach the robot
          this.sendStreamStatus(id, 'error', 'Terminals open in the dashboard’s own pages only');
          return;
        }
        if (typeof message.terminal !== 'string' || !TERMINAL_NAME.test(message.terminal)) {
          throw new Error('Invalid terminal name');
        }
        const point = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
        const view = services.terminals.open(
          {
            terminal: message.terminal,
            command: optionalString(message.command),
            folder: optionalString(message.folder) || '~',
            cols: number(message.cols, 2, 1000, 80),
            rows: number(message.rows, 1, 500, 24),
            started: point(message.started),
            offset: point(message.offset),
          },
          {
            onOutput: (output) => this.send({ type: 'terminal.output', id, ...output }),
            onExit: (exit) => this.send({ type: 'terminal.exit', id, ...exit }),
            onStatus: (state, text) => this.sendStreamStatus(id, state, text),
          },
        );
        this.terminals.set(id, view);
        this.subscriptions.set(id, () => view.close());
        return;
      }

      case 'terminal.input':
        if (typeof message.data === 'string') {
          this.terminals.get(subscriptionId(message.id))?.input(message.data);
        }
        return;

      case 'terminal.resize':
        this.terminals
          .get(subscriptionId(message.id))
          ?.resize(number(message.cols, 2, 1000, 80), number(message.rows, 1, 500, 24));
        return;

      case 'terminal.ack':
        if (typeof message.started === 'number' && typeof message.offset === 'number') {
          this.terminals.get(subscriptionId(message.id))?.ack(message.started, message.offset);
        }
        return;

      case 'terminal.restart':
        this.terminals.get(subscriptionId(message.id))?.restart();
        return;

      case 'network.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.networking.watch((state) =>
            this.send({
              type: 'network',
              id,
              ...state,
              via: deviceOfAddress(state.devices, this.localAddress),
              canChange: this.ownPage,
            }),
          ),
        );
        return;
      }

      case 'network.action':
        this.answer(
          message.id,
          this.ownPage
            ? Promise.resolve(message.request).then((request) => services.networking.act(checkRequest(request)))
            : Promise.reject(new Error('The networks are changed from the dashboard’s own pages only')),
        );
        return;

      case 'arm.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        const watcher = services.arm.watch(
          {
            controllers: strings(message.controllers, 'controllers'),
            jointStatesTopic: string(message.jointStatesTopic, 'jointStatesTopic'),
            descriptionTopic: optionalString(message.descriptionTopic),
            calibrationTopic: optionalString(message.calibrationTopic),
          },
          (update) => this.send({ type: 'arm', id, ...update }),
        );
        this.arms.set(id, watcher);
        this.subscriptions.set(id, () => watcher.dispose());
        return;
      }

      case 'arm.jog': {
        const watcher = this.arms.get(subscriptionId(message.id));
        if (!watcher) {
          throw new Error('Jog of an unknown arm subscription');
        }
        const joints: Record<string, number> = {};
        for (const [name, speed] of Object.entries(message.joints ?? {})) {
          joints[name] = number(speed, -MAX_JOINT_SPEED, MAX_JOINT_SPEED, 0);
        }
        const axis = (value: unknown) => number(value, -MAX_CARTESIAN_SPEED, MAX_CARTESIAN_SPEED, 0);
        watcher.input({
          joints,
          cartesian: { x: axis(message.cartesian?.x), y: axis(message.cartesian?.y), z: axis(message.cartesian?.z) },
          ik: {
            group: optionalString(message.ik?.group),
            link: optionalString(message.ik?.link),
            frameId: optionalString(message.ik?.frameId),
          },
        });
        return;
      }

      case 'ros.publish':
        services.ros.publish(string(message.topic, 'topic'), string(message.messageType, 'messageType'), message.message);
        return;

      case 'ros.call':
        this.answer(
          message.id,
          services.ros.call(
            string(message.service, 'service'),
            string(message.serviceType, 'serviceType'),
            message.request,
            number(message.timeoutMs, 1, 60_000, 5000),
          ),
        );
        return;

      case 'plugin.request':
        this.answer(
          message.id,
          services.plugins.request(string(message.plugin, 'plugin'), string(message.method, 'method'), message.params, this),
        );
        return;

      case 'plugin.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        const plugin = string(message.plugin, 'plugin');
        const stream = string(message.stream, 'stream');
        let close: () => void;
        try {
          close = services.plugins.open(plugin, stream, message.params, (data) => this.send({ type: 'plugin.data', id, data }), this);
        } catch (e) {
          this.sendStreamStatus(id, 'error', errorMessage(e));
          return;
        }
        this.subscriptions.set(id, () => {
          try {
            close();
          } catch (e) {
            this.reportError(`${plugin}'s stream ${stream} did not close: ${errorMessage(e)}`);
          }
        });
        return;
      }

      case 'unsubscribe':
        this.unsubscribe(message.id);
        return;

      case 'frame.ack': {
        const consumer = this.consumers.get(message.id);
        if (consumer) {
          services.streams.ack(consumer);
        }
        return;
      }

      case 'pose': {
        const [x, y, yaw] = [message.x, message.y, message.yaw];
        if (![x, y, yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) {
          throw new Error('A pose needs finite x, y and yaw');
        }
        services.poses.publish({
          type: 'pose',
          topic: string(message.topic, 'topic'),
          covariance: message.covariance === true,
          frameId: string(message.frameId, 'frameId'),
          x,
          y,
          yaw,
        });
        return;
      }

      case 'services.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.systemd.watch(string(message.pattern, 'pattern'), (update) =>
            this.send({ type: 'services', id, ...update }),
          ),
        );
        return;
      }

      case 'service.action': {
        const { id } = message;
        services.systemd.act(string(message.unit, 'unit'), message.scope, message.verb).then(
          () => this.send({ type: 'service.result', id, error: null }),
          (e: unknown) => this.send({ type: 'service.result', id, error: errorMessage(e) }),
        );
        return;
      }

      case 'logs.subscribe': {
        const id = subscriptionId(message.id);
        this.unsubscribe(id);
        this.subscriptions.set(
          id,
          services.systemd.logs(string(message.unit, 'unit'), message.scope, (text, reset) =>
            this.send({ type: 'logs', id, text, reset }),
          ),
        );
        return;
      }

      case 'command.run':
        services.commands
          .run(string(message.panelId, 'panelId'), string(message.widgetId, 'widgetId'))
          .catch((e: unknown) => this.reportError(errorMessage(e)));
        return;

      case 'command.stop':
        services.commands.stop(string(message.panelId, 'panelId'), string(message.widgetId, 'widgetId'));
        return;

      default:
        throw new Error(`Unknown message type "${(message as { type?: unknown }).type}"`);
    }
  }

  // The result of the request id, once known: what it resolves with, or why
  // it failed
  private answer(id: unknown, result: Promise<unknown>): void {
    const requestId = subscriptionId(id);
    result.then(
      (value) => this.send({ type: 'result', id: requestId, ok: true, value: value === undefined ? null : toJson(value) }),
      (e: unknown) => this.send({ type: 'result', id: requestId, ok: false, error: errorMessage(e) }),
    );
  }

  private addConsumer(id: number, consumer: Consumer): void {
    this.unsubscribe(id);
    this.consumers.set(id, consumer);
    this.subscriptions.set(id, () => this.services.streams.unsubscribe(consumer));
  }

  private unsubscribe(id: number): void {
    this.subscriptions.get(id)?.();
    this.subscriptions.delete(id);
    this.consumers.delete(id);
    this.arms.delete(id);
    this.playbacks.delete(id);
    this.terminals.delete(id);
  }
}
