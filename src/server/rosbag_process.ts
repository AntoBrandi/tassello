// ros2 bag, the robot's own tool, run by the server: record (into a new
// folder, until stopped) and play (a bag, onto the ROS graph). Stopped as
// Ctrl+C stops them, which completes a bag being recorded.

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

import type { PlayRequest, RecordRequest } from '../shared/rosbag.ts';
import { playArguments, recordArguments } from './rosbag_format.ts';
import { errorMessage, stripAnsi } from './util.ts';

// Waited for ros2 bag to say it runs; quiet, it is taken as running
const RECORD_START_MS = 8000;
const PLAY_START_MS = 3000;
// Then it is killed: a bag being recorded may lack its metadata
const STOP_TIMEOUT_MS = 10_000;
const RECORDING = /Subscribed to topic|Listening for topics|Recording\.\.\./;
const PLAYING = /Press SPACE|Adding keyboard callbacks|Set rate to|Playback until|Resuming play/;
const OUTPUT_LIMIT = 4000;

export interface BagExit {
  // 0: done (a playback played whole)
  code: number | null;
  // What it said last, or how it ended
  reason: string;
  // By stop()
  stopped: boolean;
}

export class Ros2Bag {
  // Settles once it exits
  readonly done: Promise<BagExit>;
  private readonly child: ChildProcess;
  private output = '';
  private stopping = false;
  private exit: BagExit | null = null;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.done = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        const lines = this.output.trim().split('\n').slice(-2).join(' ').trim();
        this.exit = { code, reason: (code !== 0 && lines) || `ros2 bag exited (${signal ?? code})`, stopped: this.stopping };
        resolve(this.exit);
      });
    });
  }

  // Resolves once it records, rejects with why it could not
  static record(request: RecordRequest, distro: string): Promise<Ros2Bag> {
    return Ros2Bag.start(recordArguments(request, distro), RECORDING, RECORD_START_MS, false);
  }

  // Resolves once it plays (or played a short bag whole), rejects with why
  // it could not
  static play(request: PlayRequest): Promise<Ros2Bag> {
    return Ros2Bag.start(playArguments(request), PLAYING, PLAY_START_MS, true);
  }

  private static start(args: string[], ready: RegExp, timeoutMs: number, quickExitOk: boolean): Promise<Ros2Bag> {
    return new Promise((resolve, reject) => {
      const child = spawn('ros2', args, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
      const bag = new Ros2Bag(child);
      let settled = false;
      const settle = (error: Error | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else {
            resolve(bag);
          }
        }
      };
      const timer = setTimeout(() => settle(null), timeoutMs);
      const onOutput = (chunk: Buffer) => {
        bag.output = (bag.output + stripAnsi(chunk.toString())).slice(-OUTPUT_LIMIT);
        if (ready.test(bag.output)) {
          settle(null);
        }
      };
      child.stdout?.on('data', onOutput);
      child.stderr?.on('data', onOutput);
      child.on('error', (e: NodeJS.ErrnoException) => {
        bag.output = e.code === 'ENOENT' ? 'ros2 not found: is ROS sourced?' : errorMessage(e);
        settle(new Error(bag.output));
      });
      void bag.done.then(({ code, reason }) => settle(code === 0 && quickExitOk ? null : new Error(reason)));
    });
  }

  get exited(): BagExit | null {
    return this.exit;
  }

  // As Ctrl+C does
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    this.child.kill('SIGINT');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    await this.done;
    clearTimeout(timer);
  }
}

// Of the robot's ROS: what ros2 bag list says, '' if it cannot run
export function ros2BagList(what: 'storage' | 'compressor'): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('ros2', ['bag', 'list', what], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', () => resolve(''));
    child.on('close', (code) => resolve(code === 0 ? output : ''));
  });
}
