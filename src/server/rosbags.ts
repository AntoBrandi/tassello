// The robot's rosbags, for the Rosbags widgets and the behavior tree
// inspectors: the bags of the folders the pages follow (rosbag.ts), the
// recordings going on (ros2 bag record), and the playback (ros2 bag play),
// one at a time, paused, sped up and sought through its player's services.
// They are the server's, not a page's: every page sees them, any stops them.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BagsUpdate } from '../shared/protocol.ts';
import {
  playbackPosition,
  type BagCapabilities,
  type BagInfo,
  type BagsRequest,
  type Playback,
  type PlayRequest,
  type Recording,
  type RecordRequest,
} from '../shared/rosbag.ts';
import type { Ros } from './ros.ts';
import { bagInfo, bagPath, folderSize, listBags, newBagFolder, type BagCache } from './rosbag.ts';
import { pluginNames } from './rosbag_format.ts';
import { ros2BagList, Ros2Bag } from './rosbag_process.ts';
import { errorMessage, type Logger } from './util.ts';

export type BagsWatcher = (update: Omit<BagsUpdate, 'type' | 'id'>) => void;

// How often a followed folder is read again
const LIST_MS = 2000;
// How often the recordings' sizes are
const SIZE_MS = 1000;
const CALL_TIMEOUT_MS = 3000;
// ros2 bag play's node
const PLAYER = '/rosbag2_player';
// What a bag's folder may hold to be deleted as one: its metadata, its files,
// SQLite's journals
const BAG_CONTENT = /^metadata\.yaml$|\.(mcap|db3)(\.zstd)?$|\.db3-(wal|shm|journal)$/i;

class FolderWatch {
  readonly watchers = new Set<BagsWatcher>();
  readonly folder: string;
  bags: BagInfo[] | null = null;
  error: string | null = null;
  timer: NodeJS.Timeout | null = null;
  reading = false;
  // What each watcher was sent last
  readonly sent = new Map<BagsWatcher, string>();

  constructor(folder: string) {
    this.folder = folder;
  }
}

interface RecordingEntry {
  recording: Recording;
  // null while it starts
  process: Ros2Bag | null;
}

export class Rosbags {
  private readonly ros: Ros;
  private readonly logger: Logger;
  private readonly distro = process.env.ROS_DISTRO ?? '';
  // By folder
  private readonly recordings = new Map<string, RecordingEntry>();
  private playback: { state: Playback; process: Ros2Bag | null } | null = null;
  private controls: Promise<unknown> = Promise.resolve();
  private readonly folders = new Map<string, FolderWatch>();
  private readonly cache: BagCache = new Map();
  private readonly listeners = new Set<() => void>();
  private capabilities: BagCapabilities | null = null;
  private capabilitiesAsked = false;
  private sizeTimer: NodeJS.Timeout | null = null;

  constructor(ros: Ros, logger: Logger) {
    this.ros = ros;
    this.logger = logger;
  }

  // The bags of a folder, the recordings and the playback, again whenever
  // they change, until the returned function is called
  watch(folder: string, watcher: BagsWatcher): () => void {
    let location: string;
    try {
      location = bagPath(folder || '~');
    } catch (e) {
      watcher({ folder, bags: null, error: errorMessage(e), recordings: this.recordingList(), playback: this.playbackState(), capabilities: this.capabilities });
      return () => {};
    }
    this.askCapabilities();
    let watch = this.folders.get(location);
    if (!watch) {
      watch = new FolderWatch(location);
      this.folders.set(location, watch);
      const created = watch;
      created.timer = setInterval(() => void this.read(created), LIST_MS);
      void this.read(created);
    }
    const shared = watch;
    shared.watchers.add(watcher);
    this.send(shared, watcher);
    return () => {
      shared.watchers.delete(watcher);
      shared.sent.delete(watcher);
      if (shared.watchers.size === 0) {
        if (shared.timer) {
          clearInterval(shared.timer);
        }
        this.folders.delete(location);
      }
    };
  }

  // Called whenever a recording or the playback starts, stops or changes
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // The recording into that folder, if it records
  recording(folder: string): Recording | null {
    const entry = this.recordings.get(folder);
    return entry?.process ? entry.recording : null;
  }

  // What a page asks (see BagsRequest); deleting from the dashboard's own
  // pages only, as the File Manager does
  act(request: BagsRequest, ownPage: boolean): Promise<unknown> {
    switch (request.action) {
      case 'record': {
        const { action: _, ...record } = request;
        return this.record(record, 'rosbags');
      }
      case 'stop':
        return this.stop(request.path);
      case 'delete':
        if (!ownPage) {
          return Promise.reject(new Error('Rosbags are deleted from the dashboard’s own pages only'));
        }
        return this.delete(request.paths);
      case 'play': {
        const { action: _, ...play } = request;
        return this.play(play);
      }
      case 'stop-playback':
        return this.stopPlayback().then(() => null);
      default:
        return this.control(request);
    }
  }

  // Records into a new folder: resolves once ros2 bag record records
  async record(request: RecordRequest, by: Recording['by']): Promise<Recording> {
    const location = bagPath(request.path.trim().replace(/(.)\/+$/, '$1'));
    if (this.recordings.has(location)) {
      throw new Error(`${location} is being recorded already`);
    }
    const entry: RecordingEntry = { recording: { ...request, path: location, since: 0, size: 0, by }, process: null };
    this.recordings.set(location, entry);
    try {
      await newBagFolder(location);
      entry.process = await Ros2Bag.record(entry.recording, this.distro);
    } catch (e) {
      this.recordings.delete(location);
      throw e;
    }
    const process = entry.process;
    entry.recording.since = Date.now();
    void process.done.then((exit) => {
      if (this.recordings.get(location) === entry) {
        this.recordings.delete(location);
        if (!exit.stopped) {
          this.logger.warn(`Recording into ${location} stopped: ${exit.reason}`);
        }
        this.changed();
      }
    });
    const what = request.all ? 'all topics' : [...request.topics, ...(request.regex ? [`topics matching ${request.regex}`] : [])].join(', ');
    this.logger.info(`Recording ${what} into ${location}`);
    this.changed();
    this.sizeTimer ??= setInterval(() => void this.measure(), SIZE_MS);
    return entry.recording;
  }

  // Stops the recording into that folder, completing its bag: resolves with
  // the folder, null if it was not recording
  async stop(folder: string): Promise<string | null> {
    const location = bagPath(folder);
    const entry = this.recordings.get(location);
    if (!entry?.process) {
      return null;
    }
    this.recordings.delete(location);
    this.changed();
    await entry.process.stop();
    this.logger.info(`Recorded into ${location}`);
    this.refresh();
    return location;
  }

  // Bags only: their folders must hold nothing else
  async delete(paths: string[]): Promise<string[]> {
    const deleted: string[] = [];
    try {
      for (const input of paths) {
        const location = bagPath(input);
        if (this.recordings.has(location)) {
          throw new Error(`${path.basename(location)} is being recorded: stop it first`);
        }
        if (this.playback?.process && this.playback.state.state !== 'ended' && this.playback.state.path === location) {
          throw new Error(`${path.basename(location)} is being played: stop it first`);
        }
        await bagInfo(location);
        if ((await fs.stat(location)).isDirectory()) {
          const entries = await fs.readdir(location, { withFileTypes: true });
          const other = entries.find((entry) => !entry.isFile() || !BAG_CONTENT.test(entry.name));
          if (other) {
            throw new Error(`${path.basename(location)} holds ${other.name}, which is not of a rosbag: delete it with the File Manager`);
          }
        }
        await fs.rm(location, { recursive: true, force: true });
        this.cache.delete(location);
        deleted.push(location);
        this.logger.info(`Rosbag deleted: ${location}`);
      }
    } finally {
      if (deleted.length > 0) {
        this.refresh();
      }
    }
    return deleted;
  }

  // ros2 bag play, one bag at a time: resolves once it plays
  async play(request: PlayRequest): Promise<Playback> {
    if (this.playback?.process && this.playback.state.state !== 'ended') {
      throw new Error(`${path.basename(this.playback.state.path)} is being played: stop it first`);
    }
    const location = bagPath(request.path);
    if (this.recordings.has(location)) {
      throw new Error(`${path.basename(location)} is being recorded: stop it first`);
    }
    const info = await bagInfo(location);
    const duration = info.duration ?? 0;
    const state: Playback = {
      ...request,
      path: location,
      state: 'starting',
      start: info.start ?? 0,
      duration,
      position: Math.min(duration, request.startOffset * 1000),
      at: Date.now(),
      error: null,
    };
    const playback: { state: Playback; process: Ros2Bag | null } = { state, process: null };
    this.playback = playback;
    this.changed();
    try {
      playback.process = await Ros2Bag.play({ ...request, path: location });
    } catch (e) {
      Object.assign(state, { state: 'ended', error: errorMessage(e), at: Date.now() });
      this.changed();
      throw new Error(`Cannot play ${location}: ${errorMessage(e)}`);
    }
    const process = playback.process;
    if (this.playback !== playback) {
      // Stopped while it started
      await process.stop();
      throw new Error(`The playback of ${path.basename(location)} was stopped`);
    }
    Object.assign(state, { state: request.startPaused ? 'paused' : 'playing', at: Date.now() });
    void process.done.then((exit) => {
      if (this.playback !== playback) {
        return;
      }
      const position = state.loop ? playbackPosition(state, Date.now()) : state.duration;
      Object.assign(state, {
        state: 'ended',
        position: exit.code === 0 ? state.duration : position,
        at: Date.now(),
        error: exit.code === 0 || exit.stopped ? null : exit.reason,
      });
      this.changed();
    });
    this.logger.info(`Playing ${location}`);
    this.changed();
    return state;
  }

  // The recordings completed and the playback stopped, as the server stops
  async stopAll(): Promise<void> {
    const processes = [...this.recordings.values()].flatMap((entry) => entry.process ?? []);
    this.recordings.clear();
    if (this.playback?.process) {
      processes.push(this.playback.process);
    }
    this.playback = null;
    if (this.sizeTimer) {
      clearInterval(this.sizeTimer);
    }
    for (const watch of this.folders.values()) {
      if (watch.timer) {
        clearInterval(watch.timer);
      }
    }
    await Promise.all(processes.map((process) => process.stop()));
  }

  private async stopPlayback(): Promise<void> {
    const playback = this.playback;
    this.playback = null;
    this.changed();
    if (playback?.process && !playback.process.exited) {
      await playback.process.stop();
      this.logger.info(`Stopped playing ${playback.state.path}`);
    }
  }

  // One after the other: each reckons where the playback is from the one
  // before, a seek and a rate sent together too
  private control(request: Extract<BagsRequest, { action: 'pause' | 'resume' | 'seek' | 'rate' }>): Promise<null> {
    const run = this.controls.then(() => this.apply(request));
    this.controls = run.catch(() => {});
    return run;
  }

  // Through ros2 bag play's services
  private async apply(request: Extract<BagsRequest, { action: 'pause' | 'resume' | 'seek' | 'rate' }>): Promise<null> {
    const playback = this.playback;
    const state = playback?.state;
    if (!playback?.process || !state || state.state === 'ended' || state.state === 'starting') {
      throw new Error('No bag is being played');
    }
    const call = (service: string, type: string, message: unknown) =>
      this.ros.call(`${PLAYER}/${service}`, `rosbag2_interfaces/srv/${type}`, message, CALL_TIMEOUT_MS) as Promise<{ success?: boolean }>;
    // Where it is as asked: a first call waits for the service's discovery
    const asked = { position: playbackPosition(state, Date.now()), at: Date.now() };
    switch (request.action) {
      case 'pause':
        await call('pause', 'Pause', {});
        Object.assign(state, asked, { state: 'paused' });
        break;
      case 'resume':
        await call('resume', 'Resume', {});
        Object.assign(state, { position: playbackPosition(state, Date.now()), at: Date.now(), state: 'playing' });
        break;
      case 'rate': {
        const answer = await call('set_rate', 'SetRate', { rate: request.rate });
        if (answer.success === false) {
          throw new Error(`The player refused the rate ${request.rate}`);
        }
        Object.assign(state, asked, { rate: request.rate });
        break;
      }
      case 'seek': {
        const position = Math.min(state.duration, request.position);
        const ns = BigInt(Math.round((state.start + position) * 1e6));
        const answer = await call('seek', 'Seek', { time: { sec: Number(ns / 1_000_000_000n), nanosec: Number(ns % 1_000_000_000n) } });
        if (answer.success === false) {
          throw new Error('The player refused to seek there');
        }
        Object.assign(state, { position, at: Date.now() });
        break;
      }
    }
    if (this.playback === playback) {
      this.changed();
    }
    return null;
  }

  private recordingList(): Recording[] {
    return [...this.recordings.values()].flatMap((entry) => (entry.process ? [entry.recording] : []));
  }

  private playbackState(): Playback | null {
    return this.playback ? { ...this.playback.state } : null;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
    for (const watch of this.folders.values()) {
      this.sendAll(watch);
    }
  }

  // The folders read again now
  private refresh(): void {
    for (const watch of this.folders.values()) {
      void this.read(watch);
    }
  }

  private async read(watch: FolderWatch): Promise<void> {
    if (watch.reading) {
      return;
    }
    watch.reading = true;
    try {
      watch.bags = await listBags(watch.folder, this.cache);
      watch.error = null;
    } catch (e) {
      watch.error = errorMessage(e);
    } finally {
      watch.reading = false;
    }
    this.sendAll(watch);
  }

  private async measure(): Promise<void> {
    const entries = [...this.recordings.values()].filter((entry) => entry.process);
    if (entries.length === 0 && this.recordings.size === 0 && this.sizeTimer) {
      clearInterval(this.sizeTimer);
      this.sizeTimer = null;
      return;
    }
    let changed = false;
    for (const entry of entries) {
      const size = await folderSize(entry.recording.path);
      if (size !== entry.recording.size) {
        entry.recording.size = size;
        changed = true;
      }
    }
    if (changed) {
      for (const watch of this.folders.values()) {
        this.sendAll(watch);
      }
    }
  }

  private update(watch: FolderWatch): Omit<BagsUpdate, 'type' | 'id'> {
    const bags =
      watch.bags?.map((bag) => {
        const recording = this.recording(bag.path);
        if (!recording) {
          return bag;
        }
        // Its files are being written: what it has so far
        const topics = bag.topics.length ? bag.topics : recording.topics.map((name) => ({ name, type: '', count: null }));
        return { ...bag, recording: true, size: recording.size, topics, problem: null };
      }) ?? null;
    return {
      folder: watch.folder,
      bags,
      error: watch.error,
      recordings: this.recordingList(),
      playback: this.playbackState(),
      capabilities: this.capabilities,
    };
  }

  private send(watch: FolderWatch, watcher: BagsWatcher): void {
    const update = this.update(watch);
    const text = JSON.stringify(update);
    if (watch.sent.get(watcher) !== text) {
      watch.sent.set(watcher, text);
      watcher(update);
    }
  }

  private sendAll(watch: FolderWatch): void {
    for (const watcher of watch.watchers) {
      this.send(watch, watcher);
    }
  }

  private askCapabilities(): void {
    if (this.capabilitiesAsked) {
      return;
    }
    this.capabilitiesAsked = true;
    void Promise.all([ros2BagList('storage'), ros2BagList('compressor')]).then(([storages, compressors]) => {
      const older = ['foxy', 'galactic', 'humble'].includes(this.distro.toLowerCase());
      const listed = pluginNames(storages);
      this.capabilities = {
        storages: listed.length ? listed : ['mcap', 'sqlite3'],
        compressors: pluginNames(compressors).length ? pluginNames(compressors) : ['zstd'],
        defaultStorage: older ? 'sqlite3' : 'mcap',
        distro: this.distro,
      };
      this.changed();
    });
  }
}
