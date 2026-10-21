// The page's WebSocket to the server (see src/shared/protocol.ts), reconnected
// whenever it drops. The subscriptions survive reconnections: they are renewed
// on every new connection.

import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  FRAME_HEADER_BYTES,
  IMAGE_FORMATS,
  type ArmSubscribe,
  type ArmUpdate,
  type BehaviorTreeFile,
  type BehaviorTreeFileSubscribe,
  type BehaviorTreeInfo,
  type BehaviorTreeModels,
  type BehaviorTreePlaybackControl,
  type BehaviorTreePlaybackState,
  type BehaviorTreePlaybackSubscribe,
  type BehaviorTreeRecording,
  type BehaviorTreeSaved,
  type BehaviorTreeSubscribe,
  type BehaviorTreeUpdate,
  type ClientMessage,
  type CommandState,
  type DiagnosticsSubscribe,
  type DiagnosticsUpdate,
  type GridSubscribe,
  type ImageSubscribe,
  type LogsSubscribe,
  type LogsUpdate,
  type PathSubscribe,
  type PathUpdate,
  type PluginSubscribe,
  type RosoutSubscribe,
  type RosoutUpdate,
  type ServerMessage,
  type ServiceScope,
  type ServicesSubscribe,
  type ServicesUpdate,
  type ServiceVerb,
  type StreamStatus,
  type TerminalExit,
  type TerminalOpen,
  type TerminalOutput,
  type TfSubscribe,
  type TfUpdate,
  type TopicSubscribe,
} from '../shared/protocol.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export type ImageOptions = Omit<ImageSubscribe, 'type' | 'id'>;
export type GridOptions = Omit<GridSubscribe, 'type' | 'id'>;
export type TfOptions = Omit<TfSubscribe, 'type' | 'id'>;
export type PathOptions = Omit<PathSubscribe, 'type' | 'id'>;
export type TopicOptions = Omit<TopicSubscribe, 'type' | 'id'>;
export type ServicesOptions = Omit<ServicesSubscribe, 'type' | 'id'>;
export type LogsOptions = Omit<LogsSubscribe, 'type' | 'id'>;
export type ArmOptions = Omit<ArmSubscribe, 'type' | 'id'>;
export type BehaviorTreeOptions = Omit<BehaviorTreeSubscribe, 'type' | 'id'>;
export type BehaviorTreePlaybackOptions = Omit<BehaviorTreePlaybackSubscribe, 'type' | 'id'>;
export type BehaviorTreePlaybackRequest = Omit<BehaviorTreePlaybackControl, 'type' | 'id'>;
export type BehaviorTreeFileOptions = Omit<BehaviorTreeFileSubscribe, 'type' | 'id'>;
export type RosoutOptions = Omit<RosoutSubscribe, 'type' | 'id'>;
export type DiagnosticsOptions = Omit<DiagnosticsSubscribe, 'type' | 'id'>;
export type TerminalOptions = Pick<TerminalOpen, 'terminal' | 'command' | 'folder'>;

export interface TopicHandlers {
  status: (state: StreamStatus['state'], message: string) => void;
  message: (messageType: string, message: unknown) => void;
}

export interface BehaviorTreeHandlers {
  status: (state: StreamStatus['state'], message: string) => void;
  // The tree's nodes; a reset update follows
  tree: (tree: BehaviorTreeInfo) => void;
  update: (update: BehaviorTreeUpdate) => void;
  // Live: the topic's recording, if any
  recording?: (recording: BehaviorTreeRecording['recording']) => void;
  // Played back: where the playback is
  playback?: (state: BehaviorTreePlaybackState) => void;
}

export interface BehaviorTreeFileHandlers {
  // Its text, again whenever it changes
  file: (file: BehaviorTreeFile) => void;
  // The nodes it can use
  models: (models: BehaviorTreeModels) => void;
}

export interface RosoutHandlers {
  status: (state: StreamStatus['state'], message: string) => void;
  // The messages, and the nodes of the graph when they change
  update: (update: RosoutUpdate) => void;
}

export interface DiagnosticsHandlers {
  status: (state: StreamStatus['state'], message: string) => void;
  // The statuses that changed, and their changes of level
  update: (update: DiagnosticsUpdate) => void;
}

export interface TerminalHandlers {
  // Its error, if it could not be opened
  status: (state: StreamStatus['state'], message: string) => void;
  output: (output: TerminalOutput) => void;
  exit: (exit: TerminalExit) => void;
  // What the page shows, asked on every connection: the terminal's size, and
  // the output it has
  shown: () => Pick<TerminalOpen, 'cols' | 'rows' | 'started' | 'offset'>;
}

// A frame's source size (see FRAME_HEADER_BYTES) and metadata, e.g. GridInfo
export interface FrameInfo {
  width: number;
  height: number;
  meta: unknown;
}

// Of a plugin's stream (PluginContext.stream on its server side)
export interface PluginStreamHandlers {
  data: (data: unknown) => void;
  // Its failure, e.g. no such plugin or stream: it is not retried until the
  // next connection
  status?: (state: StreamStatus['state'], message: string) => void;
}

export interface StreamHandlers {
  status: (state: StreamStatus['state'], message: string) => void;
  // The next frame is requested once the returned promise settles
  frame: (file: Blob, info: FrameInfo) => Promise<void> | void;
}

type Request =
  | Omit<ImageSubscribe, 'id'>
  | Omit<GridSubscribe, 'id'>
  | Omit<TfSubscribe, 'id'>
  | Omit<PathSubscribe, 'id'>
  | Omit<TopicSubscribe, 'id'>
  | Omit<ServicesSubscribe, 'id'>
  | Omit<LogsSubscribe, 'id'>
  | Omit<ArmSubscribe, 'id'>
  | Omit<PluginSubscribe, 'id'>
  | Omit<BehaviorTreeSubscribe, 'id'>
  | Omit<BehaviorTreePlaybackSubscribe, 'id'>
  | Omit<BehaviorTreeFileSubscribe, 'id'>
  | Omit<RosoutSubscribe, 'id'>
  | Omit<DiagnosticsSubscribe, 'id'>
  | Omit<TerminalOpen, 'id'>;

interface Subscription {
  // Or made anew on every connection
  request: Request | (() => Request);
  stream?: StreamHandlers;
  tf?: (update: TfUpdate) => void;
  path?: (update: PathUpdate) => void;
  topic?: TopicHandlers;
  services?: (update: ServicesUpdate) => void;
  logs?: (update: LogsUpdate) => void;
  arm?: (update: ArmUpdate) => void;
  plugin?: PluginStreamHandlers;
  behaviorTree?: BehaviorTreeHandlers;
  behaviorTreeFile?: BehaviorTreeFileHandlers;
  rosout?: RosoutHandlers;
  diagnostics?: DiagnosticsHandlers;
  terminal?: TerminalHandlers;
}

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 5000;
// A plugin's request answered later than this is reported lost
const REQUEST_TIMEOUT_MS = 10_000;
// A service call's, by default
const CALL_TIMEOUT_MS = 5000;
// Time for the answer to travel, on top of the server's own timeout
const RESULT_MARGIN_MS = 2000;
// Of ros2 bag record, to start or to complete the bag
const RECORD_TIMEOUT_MS = 20_000;
// What is typed or pasted in a terminal goes in messages of at most this many
// characters: the server takes messages of 1 MB at most
const TERMINAL_INPUT_CHUNK = 64 * 1024;

function commandKey(panelId: string, widgetId: string): string {
  return `${panelId}/${widgetId}`;
}

export class Connection {
  status: ConnectionStatus = 'connecting';
  // Given by the server on every connection
  clientId: string | null = null;
  hostname = '';
  // Server clock minus ours
  private clockOffsetMs = 0;

  private ws: WebSocket | null = null;
  private retryMs = MIN_RETRY_MS;
  private readonly statusListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly subscriptions = new Map<number, Subscription>();
  private nextId = 1;
  // Requests waiting for their result, by id
  private readonly results = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  // Requests waiting for their answer (service.result), by id
  private readonly requests = new Map<number, (error: string | null) => void>();
  private commands = new Map<string, CommandState>();
  private readonly commandListeners = new Set<() => void>();

  connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this.onMessage(JSON.parse(event.data) as ServerMessage);
      } else {
        this.onFrame(ws, event.data as ArrayBuffer);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      this.setStatus('closed');
      // Their answers went with the connection
      this.requests.forEach((answer) => answer('Disconnected from the robot'));
      this.requests.clear();
      this.results.forEach(({ reject }) => reject(new Error('Disconnected from the robot')));
      this.results.clear();
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    };
  }

  // false if not connected: the message is dropped, not queued
  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== 'open') {
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }

  onStatusChange = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  onServerMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  // Each returns the unsubscribe function
  subscribeImage(options: ImageOptions, handlers: StreamHandlers): () => void {
    return this.subscribe({ type: 'image.subscribe', ...options }, { stream: handlers });
  }

  subscribeGrid(options: GridOptions, handlers: StreamHandlers): () => void {
    return this.subscribe({ type: 'grid.subscribe', ...options }, { stream: handlers });
  }

  subscribeTf(options: TfOptions, callback: (update: TfUpdate) => void): () => void {
    return this.subscribe({ type: 'tf.subscribe', ...options }, { tf: callback });
  }

  subscribePath(options: PathOptions, callback: (update: PathUpdate) => void): () => void {
    return this.subscribe({ type: 'path.subscribe', ...options }, { path: callback });
  }

  subscribeTopic(options: TopicOptions, handlers: TopicHandlers): () => void {
    return this.subscribe({ type: 'topic.subscribe', ...options }, { topic: handlers });
  }

  subscribeServices(options: ServicesOptions, callback: (update: ServicesUpdate) => void): () => void {
    return this.subscribe({ type: 'services.subscribe', ...options }, { services: callback });
  }

  subscribeLogs(options: LogsOptions, callback: (update: LogsUpdate) => void): () => void {
    return this.subscribe({ type: 'logs.subscribe', ...options }, { logs: callback });
  }

  // A behavior tree's log: its tree, then its nodes' states as they change.
  // Renewed on every connection with the tree and a reset update.
  subscribeBehaviorTree(options: BehaviorTreeOptions, handlers: BehaviorTreeHandlers): () => void {
    return this.subscribe({ type: 'bt.subscribe', ...options }, { behaviorTree: handlers });
  }

  // Records a behavior tree's log into a rosbag, in the new folder path, or
  // stops recording it (null): resolves with the bag's folder
  recordBehaviorTree(topic: string, path: string | null): Promise<string | null> {
    const id = this.nextId++;
    const sent = this.send({ type: 'bt.record', id, topic, path });
    return this.result<string | null>(id, sent, RECORD_TIMEOUT_MS);
  }

  // A rosbag of a behavior tree's log played back, as a live one is followed;
  // returns the subscription's id, for its controls, and the unsubscribe
  // function. Renewed on every connection, from the start.
  subscribeBehaviorTreePlayback(
    options: BehaviorTreePlaybackOptions,
    handlers: BehaviorTreeHandlers,
  ): { id: number; unsubscribe: () => void } {
    const id = this.nextId;
    return { id, unsubscribe: this.subscribe({ type: 'bt.playback', ...options }, { behaviorTree: handlers }) };
  }

  // Plays, pauses, seeks or sets the speed of the playback id
  controlBehaviorTreePlayback(id: number, request: BehaviorTreePlaybackRequest): boolean {
    return this.send({ type: 'bt.playback.control', id, ...request });
  }

  // A behavior tree's XML file, to edit: its text, again whenever it changes,
  // and the nodes it can use. Renewed on every connection.
  subscribeBehaviorTreeFile(options: BehaviorTreeFileOptions, handlers: BehaviorTreeFileHandlers): () => void {
    return this.subscribe({ type: 'bt.file.subscribe', ...options }, { behaviorTreeFile: handlers });
  }

  // Saves a behavior tree's XML file, if still of the version base (null:
  // whatever it is), or as a new file (create)
  saveBehaviorTreeFile(path: string, text: string, base: string | null, create = false): Promise<BehaviorTreeSaved> {
    const id = this.nextId++;
    const sent = this.send({ type: 'bt.file.save', id, path, text, base, create });
    return this.result<BehaviorTreeSaved>(id, sent, REQUEST_TIMEOUT_MS);
  }

  // The ROS log (rcl_interfaces/msg/Log, /rosout): the messages the server
  // keeps, then the new ones, and the nodes of the graph. Renewed on every
  // connection with a reset update.
  subscribeRosout(options: RosoutOptions, handlers: RosoutHandlers): () => void {
    return this.subscribe({ type: 'rosout.subscribe', ...options }, { rosout: handlers });
  }

  // The robot's diagnostics (diagnostic_msgs/msg/DiagnosticArray, /diagnostics
  // or /diagnostics_agg): the statuses the server keeps and their latest
  // changes of level, then those that changed. Renewed on every connection
  // with a reset update.
  subscribeDiagnostics(options: DiagnosticsOptions, handlers: DiagnosticsHandlers): () => void {
    return this.subscribe({ type: 'diagnostics.subscribe', ...options }, { diagnostics: handlers });
  }

  // A terminal on the robot, by its name (see TerminalOpen): its output as it
  // comes, from what the page shows, which it is asked on every connection.
  // Returns the subscription's id, for what is typed in it, and the
  // unsubscribe function; the terminal lives on, without the page.
  subscribeTerminal(options: TerminalOptions, handlers: TerminalHandlers): { id: number; unsubscribe: () => void } {
    const id = this.nextId;
    const request = (): Omit<TerminalOpen, 'id'> => ({ type: 'terminal.open', ...options, ...handlers.shown() });
    return { id, unsubscribe: this.subscribe(request, { terminal: handlers }) };
  }

  // Typed or pasted in the terminal id; false if not connected: it is dropped
  terminalInput(id: number, data: string): boolean {
    for (let start = 0; start < data.length; ) {
      let end = Math.min(data.length, start + TERMINAL_INPUT_CHUNK);
      // Not half a character: each message is written to the terminal as UTF-8
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) {
        end--;
      }
      if (!this.send({ type: 'terminal.input', id, data: data.slice(start, end) })) {
        return false;
      }
      start = end;
    }
    return true;
  }

  resizeTerminal(id: number, cols: number, rows: number): boolean {
    return this.send({ type: 'terminal.resize', id, cols, rows });
  }

  // The page has written the output of the program started at started, up to
  // offset: the server sends more
  ackTerminal(id: number, started: number, offset: number): boolean {
    return this.send({ type: 'terminal.ack', id, started, offset });
  }

  // Hangs up the terminal's program if it runs, and starts it again
  restartTerminal(id: number): boolean {
    return this.send({ type: 'terminal.restart', id });
  }

  // Resolves with systemctl's error, or null once done
  serviceAction(unit: string, scope: ServiceScope, verb: ServiceVerb): Promise<string | null> {
    const id = this.nextId++;
    if (!this.send({ type: 'service.action', id, unit, scope, verb })) {
      return Promise.resolve('Not connected to the robot');
    }
    return new Promise((resolve) => this.requests.set(id, resolve));
  }

  // Publishes a message on a topic, e.g. publish('/chatter',
  // 'std_msgs/msg/String', { data: 'hi' }). false if not connected: the
  // message is dropped, not queued.
  publish(topic: string, messageType: string, message: unknown): boolean {
    return this.send({ type: 'ros.publish', topic, messageType, message });
  }

  // Calls a ROS service, e.g. callService('/reset', 'std_srvs/srv/Trigger',
  // {}): resolves with its response; rejects if the service does not exist or
  // answer within timeoutMs, or the page is not connected
  callService<T = unknown>(
    service: string,
    serviceType: string,
    request: unknown = {},
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.nextId++;
    const sent = this.send({ type: 'ros.call', id, service, serviceType, request, timeoutMs });
    return this.result<T>(id, sent, timeoutMs + RESULT_MARGIN_MS);
  }

  // A request to a plugin's server side (PluginContext.handle): resolves with
  // what its handler returns, rejects with what it throws
  request<T = unknown>(plugin: string, method: string, params: unknown = null, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    const sent = this.send({ type: 'plugin.request', id, plugin, method, params });
    return this.result<T>(id, sent, timeoutMs);
  }

  // A stream of a plugin's server side (PluginContext.stream), renewed on
  // every connection like the other subscriptions. Returns the unsubscribe
  // function.
  subscribePlugin(plugin: string, stream: string, params: unknown, handlers: PluginStreamHandlers): () => void {
    return this.subscribe({ type: 'plugin.subscribe', plugin, stream, params }, { plugin: handlers });
  }

  // Returns the subscription's id, for its jogs, and the unsubscribe function
  subscribeArm(options: ArmOptions, callback: (update: ArmUpdate) => void): { id: number; unsubscribe: () => void } {
    const id = this.nextId;
    return { id, unsubscribe: this.subscribe({ type: 'arm.subscribe', ...options }, { arm: callback }) };
  }

  onCommandsChange = (listener: () => void): (() => void) => {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  };

  // Now, on the server's clock
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  commandState(panelId: string, widgetId: string): CommandState | undefined {
    return this.commands.get(commandKey(panelId, widgetId));
  }

  private result<T>(id: number, sent: boolean, timeoutMs: number): Promise<T> {
    if (!sent) {
      return Promise.reject(new Error('Not connected to the robot'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.results.delete(id);
        reject(new Error('No answer from the robot'));
      }, timeoutMs);
      this.results.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private subscribe(request: Subscription['request'], handlers: Omit<Subscription, 'request'>): () => void {
    const id = this.nextId++;
    this.subscriptions.set(id, { request, ...handlers });
    this.send({ ...(typeof request === 'function' ? request() : request), id } as ClientMessage);
    return () => {
      this.subscriptions.delete(id);
      this.send({ type: 'unsubscribe', id });
    };
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener());
  }

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'hello':
        this.clientId = message.clientId;
        this.hostname = message.hostname;
        this.clockOffsetMs = message.time - Date.now();
        this.retryMs = MIN_RETRY_MS;
        this.setStatus('open');
        for (const [id, { request }] of this.subscriptions) {
          this.send({ ...(typeof request === 'function' ? request() : request), id } as ClientMessage);
        }
        break;
      case 'commands':
        this.commands = new Map(
          message.states.map((state) => [commandKey(state.panelId, state.widgetId), state]),
        );
        this.commandListeners.forEach((listener) => listener());
        break;
      case 'command':
        this.commands = new Map(this.commands).set(
          commandKey(message.state.panelId, message.state.widgetId),
          message.state,
        );
        this.commandListeners.forEach((listener) => listener());
        break;
      case 'stream.status': {
        const subscription = this.subscriptions.get(message.id);
        (
          subscription?.stream ??
          subscription?.topic ??
          subscription?.behaviorTree ??
          subscription?.rosout ??
          subscription?.diagnostics ??
          subscription?.terminal
        )?.status(message.state, message.message);
        subscription?.plugin?.status?.(message.state, message.message);
        break;
      }
      case 'message':
        this.subscriptions.get(message.id)?.topic?.message(message.messageType, message.message);
        break;
      case 'tf':
        this.subscriptions.get(message.id)?.tf?.(message);
        break;
      case 'path':
        this.subscriptions.get(message.id)?.path?.(message);
        break;
      case 'services':
        this.subscriptions.get(message.id)?.services?.(message);
        break;
      case 'logs':
        this.subscriptions.get(message.id)?.logs?.(message);
        break;
      case 'service.result':
        this.requests.get(message.id)?.(message.error);
        this.requests.delete(message.id);
        break;
      case 'arm':
        this.subscriptions.get(message.id)?.arm?.(message);
        break;
      case 'result': {
        const pending = this.results.get(message.id);
        this.results.delete(message.id);
        if (message.ok) {
          pending?.resolve(message.value);
        } else {
          pending?.reject(new Error(message.error));
        }
        break;
      }
      case 'plugin.data':
        this.subscriptions.get(message.id)?.plugin?.data(message.data);
        break;
      case 'bt.tree':
        this.subscriptions.get(message.id)?.behaviorTree?.tree(message);
        break;
      case 'bt':
        this.subscriptions.get(message.id)?.behaviorTree?.update(message);
        break;
      case 'bt.recording':
        this.subscriptions.get(message.id)?.behaviorTree?.recording?.(message.recording);
        break;
      case 'bt.playback.state':
        this.subscriptions.get(message.id)?.behaviorTree?.playback?.(message);
        break;
      case 'bt.file':
        this.subscriptions.get(message.id)?.behaviorTreeFile?.file(message);
        break;
      case 'bt.models':
        this.subscriptions.get(message.id)?.behaviorTreeFile?.models(message);
        break;
      case 'rosout':
        this.subscriptions.get(message.id)?.rosout?.update(message);
        break;
      case 'diagnostics':
        this.subscriptions.get(message.id)?.diagnostics?.update(message);
        break;
      case 'terminal.output':
        this.subscriptions.get(message.id)?.terminal?.output(message);
        break;
      case 'terminal.exit':
        this.subscriptions.get(message.id)?.terminal?.exit(message);
        break;
    }
    this.messageListeners.forEach((listener) => listener(message));
  }

  private onFrame(ws: WebSocket, data: ArrayBuffer): void {
    const header = new DataView(data, 0, FRAME_HEADER_BYTES);
    const id = header.getUint32(0);
    const handlers = this.subscriptions.get(id)?.stream;
    if (!handlers) {
      return;
    }
    const metaBytes = header.getUint16(9);
    const info: FrameInfo = {
      width: header.getUint16(5),
      height: header.getUint16(7),
      meta: metaBytes
        ? JSON.parse(new TextDecoder().decode(new Uint8Array(data, FRAME_HEADER_BYTES, metaBytes)))
        : null,
    };
    const file = new Blob([new Uint8Array(data, FRAME_HEADER_BYTES + metaBytes)], {
      type: IMAGE_FORMATS[header.getUint8(4)] ?? 'image/jpeg',
    });
    Promise.resolve()
      .then(() => handlers.frame(file, info))
      .catch(() => {})
      .finally(() => {
        // Not to the next connection, which knows nothing of this frame
        if (this.ws === ws && this.subscriptions.has(id)) {
          this.send({ type: 'frame.ack', id });
        }
      });
  }
}

export const connection = new Connection();

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(connection.onStatusChange, () => connection.status);
}

// The latest pose of source in target, null until the first arrives or when
// target or source is empty
export function useTf(target: string, source: string, rate = 10): TfUpdate | null {
  const [update, setUpdate] = useState<TfUpdate | null>(null);
  useEffect(() => {
    setUpdate(null);
    if (!target.trim() || !source.trim()) {
      return;
    }
    return connection.subscribeTf({ targetFrame: target.trim(), sourceFrame: source.trim(), rate }, setUpdate);
  }, [target, source, rate]);
  return update;
}

export interface TopicState<T> {
  // The latest message, as JSON (numeric arrays as arrays, 64 bit integers as
  // numbers), null until the first
  message: T | null;
  // e.g. std_msgs/msg/String
  messageType: string | null;
  status: StreamStatus['state'];
  // Why there is no message, if known
  error: string;
}

// The latest message of any topic, at most maxRate a second: e.g.
// useTopic<{ data: number }>('/battery_percentage').message?.data
export function useTopic<T = unknown>(topic: string, maxRate = 10): TopicState<T> {
  const [state, setState] = useState<TopicState<T>>({ message: null, messageType: null, status: 'waiting', error: '' });
  useEffect(() => {
    setState({ message: null, messageType: null, status: 'waiting', error: '' });
    if (!topic.trim()) {
      return;
    }
    return connection.subscribeTopic(
      { topic: topic.trim(), maxRate },
      {
        status: (status, error) => setState((previous) => ({ ...previous, status, error })),
        message: (messageType, message) =>
          setState({ message: message as T, messageType, status: 'streaming', error: '' }),
      },
    );
  }, [topic, maxRate]);
  return state;
}

export function useCommandState(panelId: string, widgetId: string): CommandState | undefined {
  return useSyncExternalStore(connection.onCommandsChange, () =>
    connection.commandState(panelId, widgetId),
  );
}
