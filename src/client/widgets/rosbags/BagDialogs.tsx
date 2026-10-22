// The Rosbags widget's dialogs: a recording to start (ros2 bag record), its
// topics chosen among the graph's, with its options; and a bag to play (ros2
// bag play), with its own.

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';

import type { GraphSnapshot } from '../../../shared/monitor.ts';
import type { BagCapabilities, BagInfo, Playback } from '../../../shared/rosbag.ts';
import { connection } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { SearchIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { isHiddenName } from '../monitor/model.ts';
import { elapsed, formatDuration, newBagPath, optionsSummary, topicRate } from './model.ts';
import { BagPathField, FALLBACK_CAPABILITIES, loadRecordOptions, RecordOptionsFields, saveRecordOptions } from './parts.tsx';

const RATES = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
const TOPIC = /^\/?[A-Za-z_~{][\w/{}~]*$/;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The topics to choose among: the graph's, and those chosen that it lacks
function topicRows(graph: GraphSnapshot | null, chosen: ReadonlySet<string>, hidden: boolean, filter: string) {
  const term = filter.trim().toLowerCase();
  const rows = (graph?.topics ?? [])
    .filter((topic) => hidden || !isHiddenName(topic.name) || chosen.has(topic.name))
    .map((topic) => ({ name: topic.name, type: topic.types.join(', '), publishers: topic.publishers as number | null }));
  for (const name of chosen) {
    if (!rows.some((row) => row.name === name)) {
      rows.push({ name, type: '', publishers: null });
    }
  }
  return rows
    .filter((row) => !term || row.name.toLowerCase().includes(term) || row.type.toLowerCase().includes(term))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function RecordDialog({
  folder,
  topics,
  capabilities,
  onClose,
}: {
  folder: string;
  // Chosen first
  topics: string[];
  capabilities: BagCapabilities | null;
  onClose: () => void;
}) {
  const id = useId();
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  useEffect(() => connection.subscribeGraph(setGraph), []);
  const [path, setPath] = useState(() => newBagPath(folder, 'rosbag2'));
  const [all, setAll] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(topics));
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [regex, setRegex] = useState('');
  const [exclude, setExclude] = useState('');
  const [options, setOptions] = useState(loadRecordOptions);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => topicRows(graph, chosen, options.includeHidden, filter), [graph, chosen, options.includeHidden, filter]);
  const known = capabilities ?? FALLBACK_CAPABILITIES;
  const nothing = !all && chosen.size === 0 && !regex.trim();

  const toggle = (name: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });

  const addTyped = () => {
    const name = typed.trim();
    if (!TOPIC.test(name)) {
      setError(`Not a topic name: ${name}`);
      return;
    }
    toggle(name.startsWith('/') || name.startsWith('~') ? name : `/${name}`, true);
    setTyped('');
    setError(null);
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const recording = await connection.bagsAction({
        action: 'record',
        path: path.trim(),
        topics: all ? [] : [...chosen],
        all,
        regex: all ? '' : regex.trim(),
        exclude: exclude.trim(),
        options,
      });
      saveRecordOptions(options);
      notify(`Recording into ${recording.path}`);
      onClose();
    } catch (e) {
      setError(message(e));
      setStarting(false);
    }
  };

  return (
    <Modal title="Record a rosbag" onClose={onClose} wide resizable>
      <form className="modal-body bag-dialog" onSubmit={(e) => void start(e)}>
        <BagPathField path={path} onChange={setPath} />

        <div className={`field${all ? '' : ' bag-choosing'}`}>
          <span className="field-label">Topics</span>
          <div className="bag-segments" role="radiogroup" aria-label="Topics">
            <label>
              <input type="radio" name={`${id}-what`} checked={!all} onChange={() => setAll(false)} />
              Those chosen
            </label>
            <label>
              <input type="radio" name={`${id}-what`} checked={all} onChange={() => setAll(true)} />
              All of them
            </label>
          </div>
          {!all && (
            <>
              <div className="bag-topic-tools">
                <label className="bag-search">
                  <SearchIcon width={13} height={13} />
                  <input type="search" value={filter} placeholder="Filter…" aria-label="Only the topics containing" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
                </label>
                <button type="button" className="link-button" onClick={() => setChosen((current) => new Set([...current, ...rows.map((row) => row.name)]))}>
                  All shown
                </button>
                <button type="button" className="link-button" onClick={() => setChosen(new Set())}>
                  None
                </button>
              </div>
              <ul className="bag-topic-list" aria-label="Topics to record">
                {rows.map((row) => (
                  <li key={row.name}>
                    <label className="bag-topic">
                      <input type="checkbox" checked={chosen.has(row.name)} onChange={(e) => toggle(row.name, e.target.checked)} />
                      <span className="bag-topic-name">{row.name}</span>
                      <span className="bag-topic-type" title={row.type}>
                        {row.publishers === null ? 'not in the graph now' : row.publishers === 0 ? `${row.type} · no publisher` : row.type}
                      </span>
                    </label>
                  </li>
                ))}
                {rows.length === 0 && <li className="bag-muted">{graph ? 'No topic matches' : 'Reading the ROS graph…'}</li>}
              </ul>
              <div className="bag-topic-tools">
                <input
                  className="bag-typed"
                  value={typed}
                  placeholder="/a_topic_not_published_yet"
                  aria-label="Another topic"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (typed.trim()) {
                        addTyped();
                      }
                    }
                  }}
                />
                <button type="button" className="button" disabled={!typed.trim()} onClick={addTyped}>
                  Add
                </button>
                <span className="field-help">{chosen.size} chosen</span>
              </div>
            </>
          )}
        </div>

        <div className="bag-regexes">
          {!all && (
            <label className="field">
              <span className="field-label">Also those matching</span>
              <input value={regex} placeholder="^/camera/.*/compressed$" spellCheck={false} onChange={(e) => setRegex(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span className="field-label">But not those matching</span>
            <input value={exclude} placeholder="/image_raw$" spellCheck={false} onChange={(e) => setExclude(e.target.value)} />
          </label>
        </div>

        <details className="bag-advanced">
          <summary>
            Advanced <span className="bag-advanced-summary">{optionsSummary(options, known.defaultStorage)}</span>
          </summary>
          <RecordOptionsFields options={options} capabilities={capabilities} onChange={setOptions} />
        </details>

        {error && <p className="field-help error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={starting || !path.trim() || nothing}>
            {starting ? 'Starting…' : 'Record'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PlayDialog({ bag, last, onClose }: { bag: BagInfo; last: Playback | null; onClose: () => void }) {
  const id = useId();
  const again = last?.path === bag.path ? last : null;
  const [rate, setRate] = useState(again?.rate ?? 1);
  const [loop, setLoop] = useState(again?.loop ?? false);
  const [offset, setOffset] = useState(again?.startOffset ? again.startOffset * 1000 : 0);
  const [clock, setClock] = useState(again?.clock ?? false);
  const [paused, setPaused] = useState(again?.startPaused ?? false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(again?.topics.length ? again.topics : bag.topics.map((topic) => topic.name)),
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duration = bag.duration ?? 0;
  const rates = RATES.includes(rate) ? RATES : [...RATES, rate].sort((a, b) => a - b);
  const every = chosen.size === bag.topics.length;

  const play = async (event: FormEvent) => {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      await connection.bagsAction({
        action: 'play',
        path: bag.path,
        rate,
        loop,
        topics: every ? [] : [...chosen],
        startOffset: offset / 1000,
        clock,
        startPaused: paused,
      });
      notify(`Playing ${bag.name}`);
      onClose();
    } catch (e) {
      setError(message(e));
      setStarting(false);
    }
  };

  return (
    <Modal title={`Play ${bag.name}`} onClose={onClose} wide>
      <form className="modal-body bag-dialog" onSubmit={(e) => void play(e)}>
        <p className="dialog-message">
          Its messages published again on the robot’s topics (ros2 bag play), as they were recorded: the nodes receiving them
          cannot tell them from live ones.
        </p>
        <div className="bag-options">
          <label className="bag-option-label" htmlFor={`${id}-rate`}>
            Rate
          </label>
          <div className="bag-option">
            <select id={`${id}-rate`} value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              {rates.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            <label className="bag-check">
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              Loop
            </label>
          </div>
          {duration > 0 && (
            <>
              <label className="bag-option-label" htmlFor={`${id}-offset`}>
                From
              </label>
              <div className="bag-option">
                <input
                  id={`${id}-offset`}
                  type="range"
                  className="bag-offset"
                  min={0}
                  max={duration}
                  step={Math.max(1, duration / 1000)}
                  value={offset}
                  onChange={(e) => setOffset(Number(e.target.value))}
                />
                <span className="bag-offset-time">
                  {elapsed(offset)} / {formatDuration(duration)}
                </span>
              </div>
            </>
          )}
          <span className="bag-option-label">Also</span>
          <div className="bag-option bag-checks">
            <label title="Nodes using sim time follow the bag’s clock">
              <input type="checkbox" checked={clock} onChange={(e) => setClock(e.target.checked)} />
              Publish /clock
            </label>
            <label>
              <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
              Start paused
            </label>
          </div>
        </div>
        {bag.topics.length > 0 && (
          <div className="field">
            <div className="bag-topic-tools">
              <span className="field-label">Topics</span>
              <button type="button" className="link-button" onClick={() => setChosen(new Set(bag.topics.map((topic) => topic.name)))}>
                All
              </button>
              <button type="button" className="link-button" onClick={() => setChosen(new Set())}>
                None
              </button>
            </div>
            <ul className="bag-topic-list" aria-label="Topics to play">
              {bag.topics.map((topic) => (
                <li key={topic.name}>
                  <label className="bag-topic">
                    <input
                      type="checkbox"
                      checked={chosen.has(topic.name)}
                      onChange={(e) =>
                        setChosen((current) => {
                          const next = new Set(current);
                          if (e.target.checked) {
                            next.add(topic.name);
                          } else {
                            next.delete(topic.name);
                          }
                          return next;
                        })
                      }
                    />
                    <span className="bag-topic-name">{topic.name}</span>
                    <span className="bag-topic-type" title={topic.type}>
                      {[topic.type, topic.count !== null ? `${topic.count} messages` : '', topicRate(topic, bag.duration)].filter(Boolean).join(' · ')}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="field-help error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={starting || chosen.size === 0}>
            {starting ? 'Opening…' : 'Play'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
