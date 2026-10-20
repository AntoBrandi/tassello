// The ROS log, as rqt_console and swri_console show it: the messages of every
// node (rcl_interfaces/msg/Log, on /rosout), coloured by level, filtered by
// node (those running and those that logged, with their counts), by level,
// and by text: terms or a regular expression, to show or to hide. Pause,
// follow the newest, clear, download them as ROS prints them, and see a
// message whole, with where it was logged.
//
// The server follows the log for every page, keeps its latest messages and
// sends the new ones at most 10 times a second (see src/server/rosout.ts): a
// page opened later sees what was logged before.

import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { LogEntry, StreamStatus } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import {
  ArrowDownToLineIcon,
  BanIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FilterIcon,
  LogsIcon,
  NodesIcon,
  PauseIcon,
  SearchIcon,
  TrashIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { LogList } from './LogList.tsx';
import {
  clockTime,
  EMPTY,
  filterLog,
  indexOfSeq,
  LEVELS,
  levelIndex,
  levelsFrom,
  logLine,
  nodeScope,
  reduce,
  runningNode,
  shortCount,
  stampTime,
  textMatch,
  type Level,
  type NodeInfo,
  type TimeFormat,
} from './model.ts';

interface LogsConfig {
  topic: string;
  nodes: string;
  level: Level;
  include: string;
  exclude: string;
  regex: boolean;
  time: TimeFormat;
}

// Wider than this, the nodes are listed beside the messages, else over them
const NODES_BESIDE_PX = 560;
// Narrower than this, a message takes two lines
const COMPACT_PX = 420;
// Shorter than this, a message's details take the place of the list
const SHORT_PX = 300;
// Of the node column, in characters
const NODE_COLUMN = { min: 6, max: 22 };

// navigator.clipboard is for secure pages only (https, localhost), and the
// dashboard is mostly served over http
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) {
    throw new Error('the browser does not allow it');
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// rosout_myrobot_20261020_140327.log
function fileName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `rosout_${connection.hostname || 'robot'}_${date}_${time}.log`;
}

function messages(count: number): string {
  return `${count.toLocaleString()} message${count === 1 ? '' : 's'}`;
}

function NodeList({
  nodes,
  chosen,
  overlay,
  onToggle,
  onAll,
  onClose,
}: {
  nodes: NodeInfo[];
  chosen: ReadonlySet<string>;
  overlay: boolean;
  onToggle: (name: string) => void;
  onAll: () => void;
  onClose: () => void;
}) {
  return (
    <aside className={`logs-nodes${overlay ? ' overlay' : ''}`} aria-label="Nodes">
      <header className="logs-nodes-header">
        <span>Nodes</span>
        <button type="button" className="link-button" disabled={chosen.size === 0} onClick={onAll}>
          Show all
        </button>
        {overlay && (
          <button type="button" className="overlay-button" aria-label="Close" onClick={onClose}>
            <CloseIcon width={15} height={15} />
          </button>
        )}
      </header>
      {nodes.length === 0 ? (
        <p className="logs-nodes-empty">No node yet</p>
      ) : (
        <ul>
          {nodes.map((info) => {
            const on = chosen.has(info.name);
            const problems = info.counts[3] + info.counts[4];
            const warnings = info.counts[2];
            return (
              <li key={info.name}>
                <button
                  type="button"
                  className={`logs-node${info.node ? '' : ' gone'}`}
                  aria-pressed={on}
                  title={`${info.node ?? `${info.name}: not running`} · ${messages(info.total)}`}
                  onClick={() => onToggle(info.name)}
                >
                  <span className="logs-node-dot" aria-hidden="true" />
                  <span className="logs-node-name">{info.name}</span>
                  {problems > 0 && <span className="logs-node-badge error">{shortCount(problems)}</span>}
                  {warnings > 0 && <span className="logs-node-badge warn">{shortCount(warnings)}</span>}
                  <span className="logs-node-count">{shortCount(info.total)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function LogDetails({
  entry,
  running,
  onOnly,
  onClose,
}: {
  entry: LogEntry;
  running: ReadonlyMap<string, string>;
  onOnly: () => void;
  onClose: () => void;
}) {
  const { level, tag } = LEVELS[levelIndex(entry.level)];
  const node = runningNode(entry.name, running);
  const copy = () =>
    copyText(logLine(entry)).then(
      () => notify('Copied the message'),
      (e: unknown) => notify(`Could not copy the message: ${e instanceof Error ? e.message : e}`, 'error'),
    );
  return (
    <section className={`logs-details ${level}`} aria-label="The message">
      <header className="logs-details-header">
        <span className="logs-pill">{tag}</span>
        <strong className="logs-details-node" title={node ?? `${entry.name}: not running`}>
          {entry.name}
        </strong>
        <span className="logs-toolbar-end" />
        <button
          type="button"
          className="overlay-button"
          title="Only this node’s messages"
          aria-label="Only this node’s messages"
          onClick={onOnly}
        >
          <FilterIcon width={16} height={16} />
        </button>
        <button type="button" className="overlay-button" title="Copy" aria-label="Copy" onClick={() => void copy()}>
          <CopyIcon width={16} height={16} />
        </button>
        <button type="button" className="overlay-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <pre className="logs-details-msg">{entry.msg}</pre>
      <dl className="logs-details-facts">
        <div>
          <dt>Time</dt>
          <dd>
            {clockTime(entry.stamp)} · {stampTime(entry.stamp)}
          </dd>
        </div>
        {entry.file && (
          <div>
            <dt>Where</dt>
            <dd>
              {entry.file}:{entry.line}
              {entry.function && ` · ${entry.function}`}
            </dd>
          </div>
        )}
        <div>
          <dt>Node</dt>
          <dd>{node ?? 'Not running'}</dd>
        </div>
      </dl>
    </section>
  );
}

function LogsWidget({ config }: WidgetProps<LogsConfig>) {
  const [model, dispatch] = useReducer(reduce, EMPTY);
  const [status, setStatus] = useState<{ state: StreamStatus['state']; message: string }>({
    state: 'waiting',
    message: 'Connecting…',
  });
  // The toolbar's, from the config's
  const [levels, setLevels] = useState<ReadonlySet<Level>>(() => levelsFrom(config.level));
  const [include, setInclude] = useState(config.include);
  const [exclude, setExclude] = useState(config.exclude);
  const [regex, setRegex] = useState(config.regex);
  // Chosen in the list of nodes
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  // Shown or hidden with the toolbar, over what the width has
  const [nodesOpen, setNodesOpen] = useState<boolean | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLevels(levelsFrom(config.level)), [config.level]);
  useEffect(() => setInclude(config.include), [config.include]);
  useEffect(() => setExclude(config.exclude), [config.exclude]);
  useEffect(() => setRegex(config.regex), [config.regex]);

  const topic = config.topic.trim();
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!topic) {
      setStatus({ state: 'error', message: 'No log topic: set one in edit mode' });
      return;
    }
    setStatus({ state: 'waiting', message: 'Connecting…' });
    return connection.subscribeRosout(
      { topic },
      {
        status: (state, message) => setStatus({ state, message }),
        update: (update) => dispatch({ type: 'update', update }),
      },
    );
  }, [topic]);

  // Another log: from its newest
  useEffect(() => {
    setSelected(null);
    setFollow(true);
  }, [model.version]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Typed, the list follows when it can
  const includeText = useDeferredValue(include);
  const excludeText = useDeferredValue(exclude);
  const scope = useMemo(() => nodeScope(config.nodes), [config.nodes]);
  const includeMatch = useMemo(() => textMatch(includeText, regex), [includeText, regex]);
  const excludeMatch = useMemo(() => textMatch(excludeText, regex), [excludeText, regex]);
  const view = useMemo(
    () =>
      filterLog(model.entries, model.running, {
        scope,
        nodes: chosen,
        levels,
        include: includeMatch.test,
        exclude: excludeMatch.test,
      }),
    [model.entries, model.running, scope, chosen, levels, includeMatch, excludeMatch],
  );

  const toggleLevel = (level: Level, only: boolean) =>
    setLevels((current) => {
      if (only) {
        return new Set([level]);
      }
      const next = new Set(current);
      if (!next.delete(level)) {
        next.add(level);
      }
      return next;
    });

  const toggleNode = useCallback(
    (name: string) =>
      setChosen((current) => {
        const next = new Set(current);
        if (!next.delete(name)) {
          next.add(name);
        }
        return next;
      }),
    [],
  );

  const found = selected === null ? undefined : model.entries[indexOfSeq(model.entries, selected)];
  const details = found?.seq === selected ? found : undefined;
  const { width, height } = size;
  const nodesBeside = width >= NODES_BESIDE_PX;
  const nodesShown = nodesOpen ?? nodesBeside;
  const logged = view.nodes.filter((info) => info.total > 0);
  const nodeWidth = Math.min(
    NODE_COLUMN.max,
    Math.max(NODE_COLUMN.min, ...logged.map((info) => info.name.length)),
  );

  let empty = 'No message matches the filters';
  if (!model.received) {
    empty = status.state === 'error' ? status.message : 'Reading the log…';
  } else if (model.entries.length === 0) {
    empty = model.cleared ? 'Cleared: the new messages will show here' : 'No message yet';
  } else if (view.total === 0) {
    empty = `No message of ${config.nodes.trim()} yet`;
  }

  let line: { text: string; tone: string };
  if (status.state === 'error') {
    line = { text: status.message, tone: 'error' };
  } else if (!model.received) {
    line = { text: status.message, tone: 'idle' };
  } else {
    const parts = [
      view.shown.length === view.total ? messages(view.total) : `${view.shown.length.toLocaleString()} of ${messages(view.total)}`,
    ];
    if (chosen.size > 0) {
      parts.push(chosen.size === 1 ? `of ${[...chosen][0]}` : `of ${chosen.size} nodes`);
    }
    if (model.skipped > 0) {
      parts.push(`${model.skipped.toLocaleString()} skipped: too many at once`);
    }
    if (model.paused) {
      parts.push(model.pending.length > 0 ? `paused, ${messages(model.pending.length)} waiting` : 'paused');
    }
    line = { text: parts.join(' · '), tone: model.paused ? 'paused' : status.state };
  }

  return (
    <div
      ref={rootRef}
      className={`logs${details && height > 0 && height < SHORT_PX ? ' cramped' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected !== null) {
          setSelected(null);
        }
      }}
    >
      <div className="logs-toolbar" role="toolbar" aria-label="Logs">
        <button
          type="button"
          className="overlay-button"
          aria-pressed={nodesShown}
          title="The nodes"
          aria-label="The nodes"
          onClick={() => setNodesOpen(!nodesShown)}
        >
          <NodesIcon width={17} height={17} />
        </button>
        <div className="logs-levels" role="group" aria-label="Levels">
          {LEVELS.map(({ level, label, letter }, index) => (
            <button
              key={level}
              type="button"
              className={`logs-level ${level}`}
              aria-pressed={levels.has(level)}
              aria-label={`${label}: ${view.levels[index]}`}
              title={`${label}: ${messages(view.levels[index])}. Shift+click: this level only`}
              onClick={(event) => toggleLevel(level, event.shiftKey)}
            >
              <span className="logs-level-dot" aria-hidden="true" />
              <span className="logs-level-name">{label}</span>
              <span className="logs-level-letter" aria-hidden="true">
                {letter}
              </span>
              <span className="logs-level-count">{shortCount(view.levels[index])}</span>
            </button>
          ))}
        </div>
        <div className="logs-tools">
          <label
            className={`logs-search${includeMatch.error ? ' invalid' : ''}`}
            title={includeMatch.error ?? 'Only the messages containing any of these, separated by ;'}
          >
            <SearchIcon width={14} height={14} />
            <input
              type="search"
              value={include}
              placeholder="Include…"
              aria-label="Only the messages containing"
              spellCheck={false}
              onChange={(e) => setInclude(e.target.value)}
            />
          </label>
          <label
            className={`logs-search${excludeMatch.error ? ' invalid' : ''}`}
            title={excludeMatch.error ?? 'Not the messages containing any of these, separated by ;'}
          >
            <BanIcon width={14} height={14} />
            <input
              type="search"
              value={exclude}
              placeholder="Exclude…"
              aria-label="Not the messages containing"
              spellCheck={false}
              onChange={(e) => setExclude(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="overlay-button logs-regex"
            aria-pressed={regex}
            title="As regular expressions"
            aria-label="As regular expressions"
            onClick={() => setRegex((on) => !on)}
          >
            .*
          </button>
          <span className="overlay-separator" />
          <button
            type="button"
            className="overlay-button"
            aria-pressed={model.paused}
            title={model.paused ? 'Resume' : 'Pause: the new messages wait'}
            aria-label={model.paused ? 'Resume' : 'Pause'}
            onClick={() => dispatch({ type: model.paused ? 'resume' : 'pause' })}
          >
            <PauseIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            aria-pressed={follow}
            title="Follow the newest"
            aria-label="Follow the newest"
            onClick={() => setFollow((on) => !on)}
          >
            <ArrowDownToLineIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            title="Download the messages shown"
            aria-label="Download the messages shown"
            disabled={view.shown.length === 0}
            onClick={() => download(fileName(), view.shown.map(logLine).join('\n') + '\n')}
          >
            <DownloadIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            title="Clear the messages"
            aria-label="Clear the messages"
            disabled={model.entries.length === 0 && model.pending.length === 0}
            onClick={() => {
              setSelected(null);
              dispatch({ type: 'clear' });
            }}
          >
            <TrashIcon width={17} height={17} />
          </button>
        </div>
      </div>
      <div className="logs-main">
        {nodesShown && (
          <NodeList
            nodes={view.nodes}
            chosen={chosen}
            overlay={!nodesBeside}
            onToggle={toggleNode}
            onAll={() => setChosen(new Set())}
            onClose={() => setNodesOpen(false)}
          />
        )}
        <LogList
          entries={view.shown}
          version={model.version}
          selected={selected}
          follow={follow}
          time={config.time}
          showNode={chosen.size !== 1 && logged.length !== 1}
          nodeWidth={nodeWidth}
          compact={width > 0 && width < COMPACT_PX}
          empty={empty}
          onSelect={setSelected}
          onFollow={setFollow}
        />
      </div>
      {details && (
        <LogDetails
          entry={details}
          running={model.running}
          onOnly={() => setChosen(new Set([details.name]))}
          onClose={() => setSelected(null)}
        />
      )}
      <div className={`logs-status ${line.tone}`} title={line.text}>
        <span className="logs-dot" aria-hidden="true" />
        <span className="logs-status-text">{line.text}</span>
      </div>
    </div>
  );
}

export const logsWidget = defineWidget<LogsConfig>({
  type: 'logs',
  name: 'Logs',
  description: 'The ROS log of every node (/rosout), coloured by level, filtered by node, level and text.',
  icon: LogsIcon,
  defaultSize: { w: 10, h: 6 },
  minSize: { w: 4, h: 3 },
  component: LogsWidget,
  properties: [
    {
      key: 'topic',
      label: 'Log topic',
      kind: 'topic',
      default: '/rosout',
      topicTypes: ['rcl_interfaces/msg/Log'],
      help: 'rcl_interfaces/Log: every node’s logger publishes on /rosout',
    },
    {
      key: 'nodes',
      label: 'Nodes',
      kind: 'string',
      default: '',
      placeholder: 'amcl, *_server',
      help: 'Only these nodes, with their child loggers: names or globs (*), separated by commas or spaces. All if empty',
    },
    {
      key: 'level',
      label: 'Levels shown',
      kind: 'select',
      default: 'debug',
      options: [
        { value: 'debug', label: 'All' },
        { value: 'info', label: 'Info and above' },
        { value: 'warn', label: 'Warnings and above' },
        { value: 'error', label: 'Errors and above' },
      ],
      help: 'When the panel opens: its toolbar shows and hides each level',
    },
    {
      key: 'include',
      label: 'Include',
      kind: 'string',
      default: '',
      placeholder: 'goal; path',
      help: 'Only the messages containing any of these, separated by ;. The toolbar changes it',
    },
    {
      key: 'exclude',
      label: 'Exclude',
      kind: 'string',
      default: '',
      placeholder: 'Publishing',
      help: 'Not the messages containing any of these, separated by ;. The toolbar changes it',
    },
    {
      key: 'regex',
      label: 'Filters as regular expressions',
      kind: 'boolean',
      default: false,
    },
    {
      key: 'time',
      label: 'Time',
      kind: 'select',
      default: 'clock',
      options: [
        { value: 'clock', label: 'Clock time, 14:03:27.512' },
        { value: 'stamp', label: 'ROS stamp, in seconds' },
        { value: 'none', label: 'Hidden' },
      ],
      help: 'Of the messages’ stamps, on their nodes’ clocks: seconds on sim time',
    },
  ],
});
