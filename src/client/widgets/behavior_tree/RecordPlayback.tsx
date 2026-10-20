// The behavior tree inspector's rosbags: recording its log on the robot
// (ros2 bag record, by the server), and playing one back in the widget.

import { useEffect, useId, useRef, useState } from 'react';

import type { BehaviorTreePlaybackState } from '../../../shared/protocol.ts';
import { connection, type BehaviorTreePlaybackRequest } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import { CloseIcon, PauseIcon, PlayIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';

// As the page last heard it, and when
export type Playback = BehaviorTreePlaybackState & { at: number };

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
// Seeks sent while the slider is dragged, at most this often
const SEEK_MS = 120;

// Where the playback is now: where it was, and since then at its speed
export function playbackTime(playback: Playback): number {
  return playback.playing ? Math.min(playback.end, playback.time + (Date.now() - playback.at) * playback.speed) : playback.time;
}

// 1:05, 1:02:09
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// The last part of a path
export function baseName(path: string): string {
  return path.replace(/\/+$/, '').replace(/^.*\//, '') || path;
}

// <folder>/behavior_tree_2026-10-20_14-03-27: sorted by time
function newBagPath(folder: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${folder.trim().replace(/\/+$/, '') || '~'}/behavior_tree_${date}_${time}`;
}

export function RecordDialog({
  topic,
  folder,
  onRecording,
  onClose,
}: {
  topic: string;
  folder: string;
  onRecording: (path: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [path, setPath] = useState(() => newBagPath(folder));
  const [browsing, setBrowsing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const recorded = await connection.recordBehaviorTree(topic, path.trim());
      notify(`Recording ${topic} into ${recorded}`);
      onRecording(recorded ?? path);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <>
      <Modal title="Record the tree’s log" onClose={onClose} wide>
        <form
          className="modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <p className="dialog-message">
            A rosbag of <code>{topic}</code>, recorded on the robot (ros2 bag record) until you stop it: to play back here, or
            with the ROS tools.
          </p>
          <div className="field">
            <label className="field-label" htmlFor={id}>
              Into
            </label>
            <div className="bt-record-path">
              <input id={id} value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} autoFocus />
              <button type="button" className="button" onClick={() => setBrowsing(true)}>
                Browse…
              </button>
            </div>
            <p className="field-help">A new folder, which the recording makes: /…, ~/…</p>
            {error && <p className="field-help error">{error}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={starting || !path.trim()}>
              {starting ? 'Starting…' : 'Record'}
            </button>
          </div>
        </form>
      </Modal>
      {browsing && (
        <FileBrowser
          kind="folder"
          start={path.replace(/\/[^/]*$/, '') || '~'}
          onChoose={(chosen) => {
            setBrowsing(false);
            setPath(`${chosen.replace(/\/+$/, '')}/${baseName(path)}`);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}

export function PlaybackBar({
  playback,
  onControl,
  onClose,
}: {
  playback: Playback;
  onControl: (request: BehaviorTreePlaybackRequest) => void;
  onClose: () => void;
}) {
  // Where the slider is dragged, and the seek to send
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const lastSeek = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const send = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current !== null) {
      lastSeek.current = Date.now();
      onControl({ time: pending.current });
      pending.current = null;
    }
  };
  const seek = (time: number) => {
    setDraft(time);
    pending.current = time;
    const wait = lastSeek.current + SEEK_MS - Date.now();
    if (wait <= 0) {
      send();
    } else {
      timer.current ??= setTimeout(send, wait);
    }
  };
  const release = () => {
    send();
    setDraft(null);
  };

  const { start, end, playing, speed, error } = playback;
  const time = draft ?? playbackTime(playback);
  const speeds = SPEEDS.includes(speed) ? SPEEDS : [...SPEEDS, speed].sort((a, b) => a - b);
  return (
    <div className="bt-playback">
      <button
        type="button"
        className="icon-button"
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={end === 0}
        onClick={() => onControl({ playing: !playing })}
      >
        {playing ? <PauseIcon width={16} height={16} /> : <PlayIcon width={16} height={16} />}
      </button>
      {error ? (
        <span className="bt-playback-error" title={error}>
          {error}
        </span>
      ) : (
        <>
          <input
            type="range"
            aria-label="Where the playback is"
            min={start}
            max={Math.max(end, start + 1)}
            step="any"
            value={time}
            disabled={end === 0}
            onChange={(e) => seek(Number(e.target.value))}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={() => draft !== null && release()}
          />
          <span className="bt-playback-time">
            {elapsed(time - start)} / {elapsed(end - start)}
          </span>
          <select
            aria-label="Speed"
            title="Speed"
            value={speed}
            onChange={(e) => onControl({ speed: Number(e.target.value) })}
          >
            {speeds.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </>
      )}
      <button type="button" className="icon-button" title="Back to the live log" aria-label="Back to the live log" onClick={onClose}>
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}
