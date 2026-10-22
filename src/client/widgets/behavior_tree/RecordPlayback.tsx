// The behavior tree inspector's rosbags: recording its log on the robot
// (ros2 bag record, by the server, as the Rosbags widget records), and
// playing one back in the widget. Their parts are the Rosbags widget's
// (../rosbags).

import { useState } from 'react';

import type { BehaviorTreePlaybackState } from '../../../shared/protocol.ts';
import { connection, type BehaviorTreePlaybackRequest } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { CloseIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { newBagPath, optionsSummary } from '../rosbags/model.ts';
import { BagPathField, FALLBACK_CAPABILITIES, loadRecordOptions, PlaybackControls, RecordOptionsFields, saveRecordOptions } from '../rosbags/parts.tsx';

export { baseName } from '../rosbags/model.ts';

// As the page last heard it, and when
export type Playback = BehaviorTreePlaybackState & { at: number };

// Where the playback is now: where it was, and since then at its speed
export function playbackTime(playback: Playback): number {
  return playback.playing ? Math.min(playback.end, playback.time + (Date.now() - playback.at) * playback.speed) : playback.time;
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
  const [path, setPath] = useState(() => newBagPath(folder, 'behavior_tree'));
  const [options, setOptions] = useState(loadRecordOptions);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const recorded = await connection.recordBehaviorTree(topic, path.trim(), options);
      saveRecordOptions(options);
      notify(`Recording ${topic} into ${recorded}`);
      onRecording(recorded ?? path);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <Modal title="Record the tree’s log" onClose={onClose} wide>
      <form
        className="modal-body bag-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="dialog-message">
          A rosbag of <code>{topic}</code>, recorded on the robot (ros2 bag record) until you stop it: to play back here, or
          with the ROS tools. The Rosbags widget lists it, and stops it too.
        </p>
        <BagPathField path={path} onChange={setPath} error={error} />
        <details className="bag-advanced">
          <summary>
            Advanced <span className="bag-advanced-summary">{optionsSummary(options, FALLBACK_CAPABILITIES.defaultStorage)}</span>
          </summary>
          <RecordOptionsFields options={options} capabilities={null} onChange={setOptions} />
        </details>
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
  const { start, end, playing, speed, error } = playback;
  return (
    <PlaybackControls
      className="bt-playback"
      playing={playing}
      position={playbackTime(playback) - start}
      duration={end - start}
      rate={speed}
      disabled={end === 0}
      error={error}
      onPlay={(next) => onControl({ playing: next })}
      onSeek={(position) => onControl({ time: start + position })}
      onRate={(rate) => onControl({ speed: rate })}
    >
      <button type="button" className="icon-button" title="Back to the live log" aria-label="Back to the live log" onClick={onClose}>
        <CloseIcon width={16} height={16} />
      </button>
    </PlaybackControls>
  );
}
