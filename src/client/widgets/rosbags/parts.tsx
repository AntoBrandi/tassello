// What the rosbags' views share, the Rosbags widget's and the behavior tree
// inspector's: the controls of a playback, the field of a new bag's folder,
// and ros2 bag record's options, remembered by the page for the next
// recording.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  DEFAULT_RECORD_OPTIONS,
  STORAGE_PRESETS,
  type BagCapabilities,
  type CompressionMode,
  type RecordOptions,
} from '../../../shared/rosbag.ts';
import { FileBrowser } from '../../editor/FileInput.tsx';
import { PauseIcon, PlayIcon } from '../../icons.tsx';
import { baseName, DURATION_UNITS, elapsed, inUnit, SIZE_UNITS, storageLabel } from './model.ts';

const RATES = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
// Seeks sent while the slider is dragged, at most this often
const SEEK_MS = 120;
const OPTIONS_KEY = 'tassello.rosbags.recordOptions';

// What the robot's rosbag2 offers, until it says
export const FALLBACK_CAPABILITIES: BagCapabilities = {
  storages: ['mcap', 'sqlite3'],
  compressors: ['zstd'],
  defaultStorage: 'mcap',
  distro: '',
};

// Play and pause, where it is (dragged to seek), its rate; then the
// children, e.g. a close button
export function PlaybackControls({
  className = '',
  playing,
  position,
  duration,
  rate,
  disabled = false,
  error = null,
  onPlay,
  onSeek,
  onRate,
  children,
}: {
  className?: string;
  playing: boolean;
  // ms from the bag's start
  position: number;
  duration: number;
  rate: number;
  disabled?: boolean;
  // Shown instead of where it is
  error?: string | null;
  onPlay: (playing: boolean) => void;
  onSeek: (position: number) => void;
  onRate: (rate: number) => void;
  children?: ReactNode;
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
      onSeek(pending.current);
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

  const shown = draft ?? position;
  const rates = RATES.includes(rate) ? RATES : [...RATES, rate].sort((a, b) => a - b);
  return (
    <div className={`bag-controls ${className}`}>
      <button
        type="button"
        className="icon-button"
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={disabled}
        onClick={() => onPlay(!playing)}
      >
        {playing ? <PauseIcon width={16} height={16} /> : <PlayIcon width={16} height={16} />}
      </button>
      {error ? (
        <span className="bag-controls-error" title={error}>
          {error}
        </span>
      ) : (
        <>
          <input
            type="range"
            aria-label="Where the playback is"
            min={0}
            max={Math.max(duration, 1)}
            step="any"
            value={shown}
            disabled={disabled}
            onChange={(e) => seek(Number(e.target.value))}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={() => draft !== null && release()}
          />
          <span className="bag-controls-time">
            {elapsed(shown)} / {elapsed(duration)}
          </span>
          <select aria-label="Rate" title="Rate" value={rate} disabled={disabled} onChange={(e) => onRate(Number(e.target.value))}>
            {rates.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </>
      )}
      {children}
    </div>
  );
}

// A new bag's folder, typed or browsed for (its parent)
export function BagPathField({ path, onChange, error }: { path: string; onChange: (path: string) => void; error?: string | null }) {
  const id = useId();
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Into
      </label>
      <div className="bag-path">
        <input id={id} value={path} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="button" onClick={() => setBrowsing(true)}>
          Browse…
        </button>
      </div>
      <p className="field-help">A new folder, which the recording makes: /…, ~/…</p>
      {error && <p className="field-help error">{error}</p>}
      {browsing && (
        <FileBrowser
          kind="folder"
          start={path.replace(/\/[^/]*$/, '') || '~'}
          onChoose={(chosen) => {
            setBrowsing(false);
            onChange(`${chosen.replace(/\/+$/, '')}/${baseName(path)}`);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

// The options of the last recording on this device
export function loadRecordOptions(): RecordOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<RecordOptions> | null;
    return { ...DEFAULT_RECORD_OPTIONS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULT_RECORD_OPTIONS };
  }
}

export function saveRecordOptions(options: RecordOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Not kept
  }
}

// A number in a unit: 0 for none
function AmountField({
  label,
  value,
  units,
  placeholder,
  onChange,
}: {
  label: string;
  // What empty means
  placeholder: string;
  // In the first unit's base: bytes, seconds
  value: number;
  units: readonly { label: string; factor: number }[];
  onChange: (value: number) => void;
}) {
  const initial = inUnit(value, units);
  const [factor, setFactor] = useState(initial.factor);
  const [text, setText] = useState(value > 0 ? String(initial.amount) : '');
  useEffect(() => {
    // Set elsewhere (reset): follow it
    if (Math.round((Number(text) || 0) * factor) !== Math.round(value)) {
      const next = inUnit(value, units);
      setFactor(next.factor);
      setText(value > 0 ? String(next.amount) : '');
    }
  }, [value]);
  const commit = (nextText: string, nextFactor: number) => {
    setText(nextText);
    setFactor(nextFactor);
    const amount = Number(nextText);
    onChange(Number.isFinite(amount) && amount > 0 ? amount * nextFactor : 0);
  };
  return (
    <span className="bag-amount">
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        placeholder={placeholder}
        aria-label={label}
        value={text}
        onChange={(e) => commit(e.target.value, factor)}
      />
      <select aria-label={`${label}: unit`} value={factor} onChange={(e) => commit(text, Number(e.target.value))}>
        {units.map((unit) => (
          <option key={unit.label} value={unit.factor}>
            {unit.label}
          </option>
        ))}
      </select>
    </span>
  );
}

// ros2 bag record's options: storage and its preset, splitting, compression,
// cache, hidden topics, sim time
export function RecordOptionsFields({
  options,
  capabilities,
  onChange,
}: {
  options: RecordOptions;
  capabilities: BagCapabilities | null;
  onChange: (options: RecordOptions) => void;
}) {
  const id = useId();
  const known = capabilities ?? FALLBACK_CAPABILITIES;
  const storage = options.storage || known.defaultStorage;
  const presets = STORAGE_PRESETS[storage] ?? [];
  const storages = known.storages.includes(options.storage) || !options.storage ? known.storages : [...known.storages, options.storage];
  const compressors = known.compressors.includes(options.compressionFormat) ? known.compressors : [...known.compressors, options.compressionFormat];
  const mcap = storage === 'mcap';
  const set = (changes: Partial<RecordOptions>) => {
    const next = { ...options, ...changes };
    const nextStorage = next.storage || known.defaultStorage;
    // What the storage chosen does not take
    if (next.preset && STORAGE_PRESETS[nextStorage] && !STORAGE_PRESETS[nextStorage].includes(next.preset)) {
      next.preset = '';
    }
    if (nextStorage === 'mcap' && next.compressionMode === 'message') {
      next.compressionMode = 'none';
    }
    onChange(next);
  };

  return (
    <div className="bag-options">
      <label className="bag-option-label" htmlFor={`${id}-storage`}>
        Storage
      </label>
      <div className="bag-option">
        <select id={`${id}-storage`} value={options.storage} onChange={(e) => set({ storage: e.target.value })}>
          <option value="">Default ({storageLabel(known.defaultStorage)})</option>
          {storages.map((s) => (
            <option key={s} value={s}>
              {storageLabel(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Storage preset"
          title="--storage-preset-profile"
          value={options.preset}
          disabled={presets.length === 0}
          onChange={(e) => set({ preset: e.target.value })}
        >
          <option value="">No preset</option>
          {presets.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
      </div>

      <span className="bag-option-label">New file at</span>
      <div className="bag-option">
        <AmountField label="Largest file" value={options.maxBagSize} units={SIZE_UNITS} placeholder="never" onChange={(maxBagSize) => set({ maxBagSize })} />
        <span className="bag-option-or">or</span>
        <AmountField label="Longest file" value={options.maxBagDuration} units={DURATION_UNITS} placeholder="never" onChange={(maxBagDuration) => set({ maxBagDuration })} />
      </div>

      <label className="bag-option-label" htmlFor={`${id}-compression`}>
        Compression
      </label>
      <div className="bag-option">
        <select
          id={`${id}-compression`}
          value={options.compressionMode}
          onChange={(e) => set({ compressionMode: e.target.value as CompressionMode })}
        >
          <option value="none">None</option>
          <option value="file">Each file</option>
          <option value="message" disabled={mcap}>
            Each message{mcap ? ' (not MCAP)' : ''}
          </option>
        </select>
        <select
          aria-label="Compression format"
          value={options.compressionFormat}
          disabled={options.compressionMode === 'none'}
          onChange={(e) => set({ compressionFormat: e.target.value })}
        >
          {compressors.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </div>
      {mcap && options.compressionMode === 'none' && !options.preset.startsWith('zstd') && (
        <p className="field-help bag-option-help">MCAP compresses its chunks with the zstd_fast or zstd_small preset.</p>
      )}
      {options.compressionMode === 'file' && (
        <p className="field-help bag-option-help">Each file is compressed once complete: rosbag2 decompresses it to play it.</p>
      )}

      <span className="bag-option-label">Cache</span>
      <div className="bag-option">
        <AmountField label="Cache" value={options.maxCacheSize} units={SIZE_UNITS.slice(0, 1)} placeholder="100" onChange={(maxCacheSize) => set({ maxCacheSize })} />
        <span className="field-help">Of messages held before written: rosbag2’s 100 MiB if empty</span>
      </div>

      <span className="bag-option-label">Also</span>
      <div className="bag-option bag-checks">
        <label>
          <input type="checkbox" checked={options.includeHidden} onChange={(e) => set({ includeHidden: e.target.checked })} />
          Hidden topics
        </label>
        <label title="The messages’ times from /clock">
          <input type="checkbox" checked={options.useSimTime} onChange={(e) => set({ useSimTime: e.target.checked })} />
          Sim time
        </label>
      </div>
    </div>
  );
}
