// The robot's rosbags: those of a folder, the newest first, with what their
// metadata says (ros2 bag info: when, how long, how big, their storage and
// compression, each topic's type, count and rate), each downloaded (folders
// as .tar.gz), deleted or played on the robot (ros2 bag play: paused, sought,
// sped up, looped, some topics only). New ones recorded (ros2 bag record):
// chosen topics or all of them, with rosbag2's options (storage and preset,
// files split by size or duration, compression of each file or message).
// The recordings and the playback are the robot's: every page sees them,
// those of the behavior tree inspectors too (see src/server/rosbags.ts).

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import type { BagsUpdate } from '../../../shared/protocol.ts';
import { playbackPosition, type BagInfo, type Playback } from '../../../shared/rosbag.ts';
import { fsApi } from '../../api.ts';
import { connection } from '../../connection.ts';
import { useDialogs } from '../../dialogs.tsx';
import { FileBrowser } from '../../editor/FileInput.tsx';
import { CloseIcon, DownloadIcon, FilmIcon, FolderIcon, MoreIcon, PlayIcon, RecordIcon, SearchIcon, StopIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { copyText, startDownload } from '../file_manager/folders.ts';
import { formatDate, formatFullDate, formatSize } from '../file_manager/model.ts';
import { ContextMenu, type MenuItem } from '../file_manager/parts.tsx';
import { useNow } from '../monitor/parts.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { PlayDialog, RecordDialog } from './BagDialogs.tsx';
import { baseName, elapsed, filterBags, formatDuration, optionsSummary, recordingWhat, storageLabel, topicRate } from './model.ts';
import { FALLBACK_CAPABILITIES, PlaybackControls } from './parts.tsx';

interface RosbagsConfig {
  folder: string;
  topics: string;
  readOnly: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function copy(text: string, what: string): void {
  copyText(text).then(
    () => notify(`Copied ${what}`),
    (e: unknown) => notify(`Could not copy ${what}: ${message(e)}`, 'error'),
  );
}

// ros2 bag play's command, to run it elsewhere
function playCommand(path: string): string {
  return `ros2 bag play ${/^[\w./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`}`;
}

function act(request: Parameters<typeof connection.bagsAction>[0], failure: string): Promise<boolean> {
  return connection.bagsAction(request).then(
    () => true,
    (e: unknown) => {
      notify(`${failure}: ${message(e)}`, 'error');
      return false;
    },
  );
}

function BagDetails({ bag }: { bag: BagInfo }) {
  const end = bag.start !== null && bag.duration !== null ? bag.start + bag.duration : null;
  return (
    <div className="bag-details">
      <dl className="bag-facts">
        <div>
          <dt>Path</dt>
          <dd>{bag.path}</dd>
        </div>
        {bag.start !== null && (
          <div>
            <dt>Recorded</dt>
            <dd className="prose">
              {formatFullDate(bag.start)}
              {end !== null && ` to ${formatFullDate(end)}`}
            </dd>
          </div>
        )}
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(bag.duration)}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>{bag.messages ?? '?'}</dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>
            {storageLabel(bag.storage)}
            {bag.compression && `, ${bag.compression.format} compressed by ${bag.compression.mode}`}
          </dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>
            {bag.files.map((file) => (
              <span key={file.name} className="bag-file">
                {file.name} <span className="bag-muted-inline">{formatSize(file.size)}</span>
              </span>
            ))}
          </dd>
        </div>
      </dl>
      {bag.topics.length > 0 && (
        <table className="bag-topics">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                Messages
              </th>
              <th scope="col" className="num">
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {bag.topics.map((topic) => (
              <tr key={topic.name}>
                <td className="bag-topics-name">{topic.name}</td>
                <td className="bag-topics-type">{topic.type}</td>
                <td className="num">{topic.count ?? '?'}</td>
                <td className="num">{topicRate(topic, bag.duration)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PlaybackBar({ playback, now, editable }: { playback: Playback; now: number; editable: boolean }) {
  // What the page asked last, shown until the robot says
  const [asked, setAsked] = useState<Partial<Playback> | null>(null);
  useEffect(() => setAsked(null), [playback.state, playback.rate, playback.position, playback.at]);
  const shown: Playback = { ...playback, ...asked };
  const ask = (changes: Partial<Playback>) => {
    const at = connection.serverNow();
    setAsked({ ...asked, position: playbackPosition(shown, at), at, ...changes });
  };
  const name = baseName(playback.path);
  const control = (request: Parameters<typeof connection.bagsAction>[0]) => void act(request, `Could not ${request.action} ${name}`);
  const stop = (
    <button
      type="button"
      className="icon-button"
      title={playback.state === 'ended' ? 'Close' : 'Stop playing (ros2 bag play exits)'}
      aria-label={playback.state === 'ended' ? 'Close' : 'Stop playing'}
      disabled={!editable && playback.state !== 'ended'}
      onClick={() => control({ action: 'stop-playback' })}
    >
      {playback.state === 'ended' ? <CloseIcon width={16} height={16} /> : <StopIcon width={14} height={14} />}
    </button>
  );
  let note: string | null = null;
  if (playback.state === 'starting') {
    note = `Opening ${name}…`;
  } else if (playback.state === 'ended') {
    note = playback.error ?? `Played ${name} whole`;
  }
  return (
    <div className={`bag-playback ${playback.state}`} role="group" aria-label={`Playback of ${name}`}>
      <span className="bag-playback-name" title={`${playback.path}${playback.topics.length ? `: ${playback.topics.join(', ')}` : ''}`}>
        <FilmIcon width={14} height={14} />
        {name}
        {playback.loop && <span className="bag-badge">loop</span>}
        {playback.clock && <span className="bag-badge">/clock</span>}
      </span>
      {note !== null ? (
        <div className="bag-controls">
          <span className={playback.error ? 'bag-controls-error' : 'bag-controls-note'} title={note}>
            {note}
          </span>
          {playback.state === 'ended' && editable && (
            <button
              type="button"
              className="button bag-small"
              onClick={() =>
                control({
                  action: 'play',
                  path: playback.path,
                  rate: playback.rate,
                  loop: playback.loop,
                  topics: playback.topics,
                  startOffset: playback.startOffset,
                  clock: playback.clock,
                  startPaused: playback.startPaused,
                })
              }
            >
              <PlayIcon width={12} height={12} /> Again
            </button>
          )}
          {stop}
        </div>
      ) : (
        <PlaybackControls
          playing={shown.state === 'playing'}
          position={playbackPosition(shown, now)}
          duration={playback.duration}
          rate={shown.rate}
          disabled={!editable}
          onPlay={(playing) => {
            ask({ state: playing ? 'playing' : 'paused' });
            control({ action: playing ? 'resume' : 'pause' });
          }}
          onSeek={(position) => {
            ask({ position });
            control({ action: 'seek', position });
          }}
          onRate={(rate) => {
            ask({ rate });
            control({ action: 'rate', rate });
          }}
        >
          {stop}
        </PlaybackControls>
      )}
    </div>
  );
}

function RosbagsWidget({ config }: WidgetProps<RosbagsConfig>) {
  const dialogs = useDialogs();
  const [folder, setFolder] = useState(config.folder);
  useEffect(() => setFolder(config.folder), [config.folder]);
  const [update, setUpdate] = useState<BagsUpdate | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [recordDialog, setRecordDialog] = useState(false);
  const [playDialog, setPlayDialog] = useState<BagInfo | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const lastPlayback = useRef<Playback | null>(null);

  useEffect(() => {
    setUpdate(null);
    return connection.subscribeBags(folder.trim() || '~', setUpdate);
  }, [folder]);

  const playback = update?.playback ?? null;
  if (playback) {
    lastPlayback.current = playback;
  }
  const now = useNow(playback?.state === 'playing' ? 250 : 1000);
  const editable = !config.readOnly;
  const bags = useMemo(() => filterBags(update?.bags ?? [], filter), [update?.bags, filter]);
  const playing = playback !== null && playback.state !== 'ended';
  const capabilities = update?.capabilities ?? null;
  const defaultTopics = useMemo(
    () =>
      config.topics
        .split(/[;,\s]+/)
        .map((topic) => topic.trim())
        .filter(Boolean),
    [config.topics],
  );

  const withBusy = async (path: string, run: () => Promise<unknown>) => {
    setBusy((current) => new Set(current).add(path));
    try {
      await run();
    } finally {
      setBusy((current) => new Set([...current].filter((p) => p !== path)));
    }
  };

  const stopRecording = (path: string) =>
    withBusy(path, async () => {
      if (await act({ action: 'stop', path }, `Could not stop recording into ${path}`)) {
        notify(`Recorded into ${path}`);
      }
    });

  const play = (bag: BagInfo) =>
    withBusy(bag.path, async () => {
      if (
        await act(
          { action: 'play', path: bag.path, rate: 1, loop: false, topics: [], startOffset: 0, clock: false, startPaused: false },
          `Could not play ${bag.name}`,
        )
      ) {
        notify(`Playing ${bag.name}`);
      }
    });

  const remove = async (bag: BagInfo) => {
    const confirmed = await dialogs.confirm({
      title: `Delete ${bag.name}?`,
      message: `${bag.files.length === 1 ? 'Its file' : `Its ${bag.files.length} files`}, ${formatSize(bag.size)}, ${bag.files.length === 1 ? 'is' : 'are'} deleted from the robot. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (confirmed) {
      await withBusy(bag.path, async () => {
        if (await act({ action: 'delete', paths: [bag.path] }, `Could not delete ${bag.name}`)) {
          notify(`Deleted ${bag.name}`);
        }
      });
    }
  };

  const download = (bag: BagInfo) => startDownload(fsApi.downloadUrl([bag.path]));

  // Under its button, or where the pointer is
  const bagMenu = (event: MouseEvent<HTMLElement>, bag: BagInfo, pointer = false) => {
    const box = event.currentTarget.getBoundingClientRect();
    const blocked = bag.recording || busy.has(bag.path);
    setMenu({
      x: pointer ? event.clientX : box.right - 200,
      y: pointer ? event.clientY : box.bottom + 4,
      items: [
        { label: 'Play…', run: () => setPlayDialog(bag), disabled: !editable || blocked || playing },
        { label: expanded === bag.path ? 'Hide the details' : 'Details', run: () => setExpanded(expanded === bag.path ? null : bag.path) },
        { label: bag.path.endsWith('.mcap') || bag.path.endsWith('.db3') ? 'Download' : 'Download as .tar.gz', run: () => download(bag), separated: true },
        { label: 'Copy the path', run: () => copy(bag.path, 'the path') },
        { label: 'Copy ros2 bag play', run: () => copy(playCommand(bag.path), 'the command') },
        { label: 'Delete…', run: () => void remove(bag), disabled: !editable || blocked, danger: true, separated: true },
      ],
    });
  };

  const recordings = update?.recordings ?? [];
  const total = (update?.bags ?? []).reduce((sum, bag) => sum + bag.size, 0);
  let status: { text: string; tone: string };
  if (!update) {
    status = { text: `Reading ${folder}…`, tone: 'idle' };
  } else if (update.error) {
    status = { text: update.error, tone: 'failed' };
  } else {
    const count = update.bags?.length ?? 0;
    status = { text: [update.folder, `${count} bag${count === 1 ? '' : 's'}`, formatSize(total)].join(' · '), tone: 'idle' };
  }

  let content;
  if (!update?.bags) {
    content = <p className="bag-empty">{update?.error ?? `Reading ${folder}…`}</p>;
  } else if (update.bags.length === 0) {
    content = <p className="bag-empty">No rosbag in {update.folder} yet{editable ? ': record one, it goes there' : ''}</p>;
  } else if (bags.length === 0) {
    content = <p className="bag-empty">No rosbag matches the filter</p>;
  } else {
    content = (
      <ul className="bag-list" aria-label={`Rosbags of ${update.folder}`}>
        {bags.map((bag) => {
          const open = expanded === bag.path;
          const played = playing && playback?.path === bag.path;
          const blocked = bag.recording || busy.has(bag.path);
          const meta = [
            formatDate(bag.start ?? bag.modified, now),
            bag.recording ? null : formatDuration(bag.duration),
            `${bag.topics.length} topic${bag.topics.length === 1 ? '' : 's'}`,
            bag.messages !== null && !bag.recording ? `${bag.messages} messages` : null,
          ].filter(Boolean);
          return (
            <li key={bag.path} className={`bag-item${open ? ' open' : ''}${busy.has(bag.path) ? ' busy' : ''}`}>
              <div className="bag-row">
                <button
                  type="button"
                  className="bag-name"
                  aria-expanded={open}
                  title={bag.path}
                  onClick={() => setExpanded(open ? null : bag.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    bagMenu(e, bag, true);
                  }}
                >
                  <span className="bag-title">
                    <span className="bag-title-text">{bag.name}</span>
                    {bag.recording && <span className="bag-badge rec">REC</span>}
                    {played && <span className="bag-badge play">playing</span>}
                  </span>
                  <span className="bag-meta">{meta.join(' · ')}</span>
                </button>
                <span className="bag-storage" title={bag.compression ? `${bag.compression.format}, by ${bag.compression.mode}` : undefined}>
                  {storageLabel(bag.storage)}
                  {bag.compression && <span className="bag-zip">{bag.compression.format}</span>}
                </span>
                <span className="bag-size">{formatSize(bag.size)}</span>
                <div className="bag-actions">
                  {editable && (
                    <button
                      type="button"
                      className="overlay-button"
                      title={playing ? 'A bag is being played: stop it first' : 'Play on the robot (ros2 bag play)'}
                      aria-label={`Play ${bag.name}`}
                      disabled={blocked || playing}
                      onClick={() => void play(bag)}
                    >
                      <PlayIcon width={14} height={14} />
                    </button>
                  )}
                  <button type="button" className="overlay-button" title="Download" aria-label={`Download ${bag.name}`} onClick={() => download(bag)}>
                    <DownloadIcon width={15} height={15} />
                  </button>
                  <button type="button" className="overlay-button" title="More" aria-label={`More on ${bag.name}`} aria-haspopup="menu" onClick={(e) => bagMenu(e, bag)}>
                    <MoreIcon width={15} height={15} />
                  </button>
                </div>
              </div>
              {bag.problem && <p className="bag-problem">{bag.problem}</p>}
              {open && <BagDetails bag={bag} />}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="bag">
      <div className="bag-toolbar" role="toolbar" aria-label="Rosbags">
        <button type="button" className="bag-folder" title={`${update?.folder ?? folder}: choose another folder`} onClick={() => setBrowsing(true)}>
          <FolderIcon width={14} height={14} />
          <span className="bag-folder-text">{folder}</span>
        </button>
        <label className="bag-search bag-filter">
          <SearchIcon width={13} height={13} />
          <input
            type="search"
            value={filter}
            placeholder="Filter…"
            aria-label="Only the bags whose name or topics contain"
            title="Only the bags whose name, or one of whose topics, contains any of these, separated by ;"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {editable && (
          <button type="button" className="button bag-record-button" title="Record a rosbag (ros2 bag record)" onClick={() => setRecordDialog(true)}>
            <RecordIcon width={14} height={14} />
            Record
          </button>
        )}
      </div>
      {recordings.length > 0 && (
        <ul className="bag-recordings" aria-label="Recordings">
          {recordings.map((recording) => (
            <li key={recording.path} className="bag-recording">
              <span className="bag-rec-dot" aria-hidden="true" />
              <span className="bag-recording-text" title={`${recording.path}\n${optionsSummary(recording.options, capabilities?.defaultStorage ?? FALLBACK_CAPABILITIES.defaultStorage)}`}>
                <strong>{baseName(recording.path)}</strong>
                <span className="bag-meta">
                  {[recordingWhat(recording), recording.by === 'behavior-tree' ? 'by a behavior tree inspector' : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="bag-recording-figures">
                {elapsed(now - recording.since)} · {formatSize(recording.size)}
              </span>
              {editable && (
                <button
                  type="button"
                  className="button bag-small danger"
                  disabled={busy.has(recording.path)}
                  title="Stop recording, completing the bag"
                  onClick={() => void stopRecording(recording.path)}
                >
                  <StopIcon width={11} height={11} /> Stop
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {playback && <PlaybackBar playback={playback} now={now} editable={editable} />}
      <div className="bag-main">{content}</div>
      <div className={`bag-status ${status.tone}`} title={status.text}>
        <span className="bag-status-text">{status.text}</span>
      </div>
      {recordDialog && (
        <RecordDialog
          folder={update?.folder ?? folder}
          topics={defaultTopics}
          capabilities={capabilities}
          onClose={() => setRecordDialog(false)}
        />
      )}
      {playDialog && <PlayDialog bag={playDialog} last={lastPlayback.current} onClose={() => setPlayDialog(null)} />}
      {browsing && (
        <FileBrowser
          kind="folder"
          start={update?.folder ?? folder}
          onChoose={(chosen) => {
            setBrowsing(false);
            setFolder(chosen);
            setExpanded(null);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
      {menu && <ContextMenu x={Math.max(4, menu.x)} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

export const rosbagsWidget = defineWidget<RosbagsConfig>({
  type: 'rosbags',
  name: 'Rosbags',
  description: 'The robot’s rosbags: recorded with rosbag2’s options, listed with their topics, downloaded, deleted and played back.',
  icon: FilmIcon,
  defaultSize: { w: 8, h: 7 },
  minSize: { w: 3, h: 4 },
  component: RosbagsWidget,
  properties: [
    {
      key: 'folder',
      label: 'Folder',
      kind: 'string',
      default: '~/bags',
      placeholder: '~/bags',
      help: 'Where the rosbags are listed and recorded into: /…, ~/…. The toolbar changes it for the page',
    },
    {
      key: 'topics',
      label: 'Topics to record',
      kind: 'string',
      default: '',
      placeholder: '/scan; /odom; /tf',
      help: 'Chosen first when recording, separated by ;',
    },
    {
      key: 'readOnly',
      label: 'View only',
      kind: 'boolean',
      default: false,
      help: 'Lists and downloads the bags, without recording, playing or deleting: the page’s choice, not a protection',
    },
  ],
});
