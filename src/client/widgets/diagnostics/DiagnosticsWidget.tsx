// The robot's diagnostics, as rqt_robot_monitor and rqt_runtime_monitor show
// them: the diagnostic_msgs/msg/DiagnosticArray of /diagnostics (every node's
// diagnostic_updater, by node) or of /diagnostics_agg (the aggregator's
// tree). Each status with its level, the groups with the worst under them,
// those with problems unfolded; as a tree, as a list (the worst first), or as
// the latest changes of level. Filtered by level and text, and a widget can be
// for some statuses only (Sensors, motor_*). A status's details: its message,
// hardware id, values and latest changes. Pause, download, and forget the
// statuses no longer published.
//
// The server follows the diagnostics for every page, marks stale the statuses
// no longer received and keeps their changes of level (see
// src/server/diagnostics.ts): a page opened later sees what changed before.

import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { DiagnosticChange, DiagnosticEntry, StreamStatus } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import {
  CloseIcon,
  CopyIcon,
  DiagnosticsIcon,
  DownloadIcon,
  HistoryIcon,
  ListIcon,
  PauseIcon,
  SearchIcon,
  TrashIcon,
  TreeIcon,
  UnfoldIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { shortCount, textMatch } from '../logs/model.ts';
import { defineWidget, type WidgetProps } from '../types.ts';
import {
  AUTO_FOLDING,
  changeLine,
  clockTime,
  displayed,
  duration,
  EMPTY,
  filterChanges,
  isForgotten,
  keepUnfolded,
  LEVELS,
  levelInfo,
  levelOf,
  levelsFrom,
  reduce,
  rowMessage,
  statusLevel,
  statusScope,
  statusText,
  viewDiagnostics,
  type Filter,
  type Folding,
  type Level,
} from './model.ts';
import { LevelIcon, StatusRows, type StatusRow } from './StatusRows.tsx';

type View = 'tree' | 'list' | 'changes';

interface DiagnosticsConfig {
  topic: string;
  statuses: string;
  level: Level;
  filter: string;
  regex: boolean;
  view: View;
}

// Wider than this, a status's details are beside the statuses, else under
// them
const DETAILS_BESIDE_PX = 640;
// Shorter than this, a status's details take the place of the statuses
const SHORT_PX = 300;
// Of a status's, in its details
const STATUS_CHANGES = 10;

// Of the status line, the worst first
const PROBLEMS: { level: Level; one: string; many: string }[] = [
  { level: 'error', one: 'error', many: 'errors' },
  { level: 'stale', one: 'stale', many: 'stale' },
  { level: 'warn', one: 'warning', many: 'warnings' },
];

function statuses(count: number): string {
  return `${count.toLocaleString()} status${count === 1 ? '' : 'es'}`;
}

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

// diagnostics_myrobot_20261020_140327.txt
function fileName(prefix: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${connection.hostname || 'robot'}_${date}_${time}.txt`;
}

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => connection.serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(connection.serverNow()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

function StatusDetails({
  entry,
  label,
  changes,
  onClose,
}: {
  entry: DiagnosticEntry;
  label: string;
  // All of them: its own are picked
  changes: DiagnosticChange[];
  onClose: () => void;
}) {
  const now = useNow(1000);
  const level = statusLevel(entry);
  const published = levelOf(entry.level);
  const recent = useMemo(
    () =>
      changes
        .filter((change) => change.status === entry.id)
        .slice(-STATUS_CHANGES)
        .reverse(),
    [changes, entry.id],
  );
  const copy = () =>
    copyText(statusText(entry)).then(
      () => notify('Copied the status'),
      (e: unknown) => notify(`Could not copy the status: ${e instanceof Error ? e.message : e}`, 'error'),
    );
  return (
    <section className={`diag-details ${level}`} aria-label={`${label}: details`}>
      <header className="diag-details-header">
        <LevelIcon level={level} size={16} />
        <span className="diag-pill">{levelInfo(level).tag}</span>
        <strong className="diag-details-name" title={entry.name}>
          {label}
        </strong>
        <span className="diag-spacer" />
        <button type="button" className="overlay-button" title="Copy" aria-label="Copy" onClick={() => void copy()}>
          <CopyIcon width={16} height={16} />
        </button>
        <button type="button" className="overlay-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="diag-details-body">
        {entry.message && <pre className="diag-details-msg">{entry.message}</pre>}
        <dl className="diag-facts">
          <div>
            <dt>Name</dt>
            <dd>{entry.name}</dd>
          </div>
          <div>
            <dt>Since</dt>
            <dd>
              {clockTime(entry.since)} · {duration(now - entry.since)}
            </dd>
          </div>
          {entry.stale && (
            <div>
              <dt>Last received</dt>
              <dd>
                {clockTime(entry.updated)} · {duration(now - entry.updated)} ago
                {published !== 'stale' && `, at ${levelInfo(published).tag}`}
              </dd>
            </div>
          )}
          {entry.hardwareId && (
            <div>
              <dt>Hardware ID</dt>
              <dd>{entry.hardwareId}</dd>
            </div>
          )}
        </dl>
        <h3>Values</h3>
        {entry.values.length > 0 ? (
          <dl className="diag-values">
            {entry.values.map(({ key, value }, index) => (
              <div key={index}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="diag-muted">None</p>
        )}
        <h3>Latest changes</h3>
        {recent.length > 0 ? (
          <ol className="diag-status-changes">
            {recent.map((change) => {
              const to = levelOf(change.level);
              return (
                <li key={change.seq} className={to}>
                  <time title={new Date(change.time).toLocaleString()}>{clockTime(change.time)}</time>
                  <span className="diag-pill">{levelInfo(to).tag}</span>
                  <span className="diag-msg">{change.message}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="diag-muted">None seen</p>
        )}
      </div>
    </section>
  );
}

// The latest changes of level, the latest first
function ChangeList({
  changes,
  entries,
  selected,
  empty,
  onSelect,
}: {
  changes: DiagnosticChange[];
  entries: ReadonlyMap<number, DiagnosticEntry>;
  // The status selected
  selected: number | null;
  empty: string;
  onSelect: (status: number) => void;
}) {
  if (changes.length === 0) {
    return <p className="diag-empty">{empty}</p>;
  }
  return (
    <ol className="diag-changes" aria-label="Latest changes">
      {changes.map((change) => {
        const level = levelOf(change.level);
        const name = entries.get(change.status)?.name ?? '';
        const said = change.message ? `${name}: ${change.message}` : name;
        return (
          <li key={change.seq}>
            <button
              type="button"
              className={`diag-change ${level}${change.status === selected ? ' selected' : ''}`}
              title={`${new Date(change.time).toLocaleString()} · ${said}`}
              onClick={() => onSelect(change.status)}
            >
              <time>{clockTime(change.time)}</time>
              <LevelIcon level={level} />
              <span className="diag-change-name">{name}</span>
              <span className="diag-msg">{change.message}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function DiagnosticsWidget({ config }: WidgetProps<DiagnosticsConfig>) {
  const [model, dispatch] = useReducer(reduce, EMPTY);
  const [status, setStatus] = useState<{ state: StreamStatus['state']; message: string }>({
    state: 'waiting',
    message: 'Connecting…',
  });
  // The toolbar's, from the config's
  const [levels, setLevels] = useState<ReadonlySet<Level>>(() => levelsFrom(config.level));
  const [filterText, setFilterText] = useState(config.filter);
  const [regex, setRegex] = useState(config.regex);
  const [view, setView] = useState<View>(config.view);
  const [folding, setFolding] = useState<Folding>(AUTO_FOLDING);
  // A node of the tree, by key
  const [selected, setSelected] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLevels(levelsFrom(config.level)), [config.level]);
  useEffect(() => setFilterText(config.filter), [config.filter]);
  useEffect(() => setRegex(config.regex), [config.regex]);
  useEffect(() => setView(config.view), [config.view]);

  const topic = config.topic.trim();
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!topic) {
      setStatus({ state: 'error', message: 'No diagnostics topic: set one in edit mode' });
      return;
    }
    setStatus({ state: 'waiting', message: 'Connecting…' });
    return connection.subscribeDiagnostics(
      { topic },
      {
        status: (state, message) => setStatus({ state, message }),
        update: (update) => dispatch({ type: 'update', update }),
      },
    );
  }, [topic]);

  // Other diagnostics: nothing selected, folded as they come
  useEffect(() => {
    setSelected(null);
    setFolding(AUTO_FOLDING);
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

  // Typed, the tree follows when it can
  const text = useDeferredValue(filterText);
  const scope = useMemo(() => statusScope(config.statuses), [config.statuses]);
  const match = useMemo(() => textMatch(text, regex), [text, regex]);
  const filter = useMemo<Filter>(() => ({ scope, levels, text: match.test }), [scope, levels, match]);
  const { statuses: entries, changes } = displayed(model);
  const kept = useMemo(
    () => [...entries.values()].filter((entry) => !isForgotten(model.forgotten, entry)),
    [entries, model.forgotten],
  );
  const shown = useMemo(() => viewDiagnostics(kept, filter, folding), [kept, filter, folding]);
  useEffect(() => setFolding((current) => keepUnfolded(shown, current)), [shown]);
  const shownChanges = useMemo(
    () => (view === 'changes' ? filterChanges(changes, entries, filter) : []),
    [view, changes, entries, filter],
  );

  const rows = useMemo<StatusRow[]>(
    () =>
      view === 'list'
        ? shown.list.map((node) => ({
            key: node.key,
            depth: 0,
            label: node.entry!.name,
            level: node.own!,
            message: node.entry!.message,
            open: null,
            dim: false,
            status: true,
            problems: null,
          }))
        : shown.rows.map(({ node, depth, open, dim, counts }) => ({
            key: node.key,
            depth,
            label: node.label,
            level: node.worst,
            message: rowMessage(node),
            open,
            dim,
            status: node.entry !== null,
            problems: open === false ? counts : null,
          })),
    [view, shown],
  );

  const fold = useCallback(
    (key: string, open: boolean) =>
      setFolding((current) => ({ ...current, chosen: new Map(current.chosen).set(key, !open) })),
    [],
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

  const node = selected === null ? undefined : shown.nodes.get(selected);
  const details = node?.entry ? { entry: node.entry, label: node.label } : null;
  const gone = [...shown.nodes.values()].flatMap((n) => (n.entry?.stale ? [n.entry.id] : []));
  const { width, height } = size;
  const beside = width >= DETAILS_BESIDE_PX;

  let empty = view === 'changes' ? 'No change matches the filters' : 'No status matches the filters';
  if (!model.received) {
    empty = status.state === 'error' ? status.message : 'Reading the diagnostics…';
  } else if (shown.nodes.size === 0) {
    if (kept.length < entries.size) {
      empty = 'The statuses no longer published are forgotten: they show again once published';
    } else {
      empty = scope ? `No status of ${config.statuses.trim()} yet` : 'No status yet';
    }
  } else if (view === 'changes' && changes.length === 0) {
    empty = 'No change of level yet';
  }

  let line: { text: string; tone: string };
  if (status.state === 'error') {
    line = { text: status.message, tone: 'failed' };
  } else if (!model.received) {
    line = { text: status.message, tone: 'idle' };
  } else {
    const parts: string[] = [];
    if (status.state === 'waiting') {
      parts.push(status.message);
    }
    if (shown.total > 0) {
      const problems = PROBLEMS.filter(({ level }) => shown.totals[level] > 0).map(
        ({ level, one, many }) => `${shown.totals[level].toLocaleString()} ${shown.totals[level] === 1 ? one : many}`,
      );
      parts.push(problems.length > 0 ? problems.join(', ') : 'All OK');
      parts.push(
        shown.filtering && view !== 'changes'
          ? `${shown.matching.toLocaleString()} of ${statuses(shown.total)} shown`
          : statuses(shown.total),
      );
    }
    if (model.frozen) {
      parts.push('paused');
    }
    line = { text: parts.join(' · ') || 'No status yet', tone: model.frozen ? 'paused' : (shown.worst ?? 'idle') };
  }

  let content;
  if (view === 'changes') {
    content = (
      <ChangeList
        changes={shownChanges}
        entries={entries}
        selected={details?.entry.id ?? null}
        empty={empty}
        onSelect={(id) => setSelected(shown.keys.get(id) ?? null)}
      />
    );
  } else {
    content = (
      <StatusRows
        kind={view}
        rows={rows}
        selected={selected}
        empty={empty}
        onSelect={setSelected}
        onFold={fold}
      />
    );
  }

  const downloadShown = () => {
    if (view === 'changes') {
      const lines = shownChanges.map((change) => changeLine(change, entries.get(change.status))).reverse();
      download(fileName('diagnostics_changes'), lines.join('\n') + '\n');
    } else {
      download(fileName('diagnostics'), shown.list.map((n) => statusText(n.entry!)).join('\n\n') + '\n');
    }
  };

  return (
    <div
      ref={rootRef}
      className={`diag${details && !beside && height > 0 && height < SHORT_PX ? ' cramped' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected !== null) {
          setSelected(null);
        }
      }}
    >
      <div className="diag-toolbar" role="toolbar" aria-label="Diagnostics">
        <div className="diag-levels" role="group" aria-label="Levels">
          {LEVELS.map(({ level, label }) => (
            <button
              key={level}
              type="button"
              className={`diag-level ${level}`}
              aria-pressed={levels.has(level)}
              aria-label={`${label}: ${shown.counts[level]}`}
              title={`${label}: ${statuses(shown.counts[level])}. Shift+click: this level only`}
              onClick={(event) => toggleLevel(level, event.shiftKey)}
            >
              <LevelIcon level={level} size={13} />
              <span className="diag-level-name">{label}</span>
              <span className="diag-level-count">{shortCount(shown.counts[level])}</span>
            </button>
          ))}
        </div>
        <div className="diag-filter">
          <label
            className={`diag-search${match.error ? ' invalid' : ''}`}
            title={
              match.error ?? 'Only the statuses whose name, message or hardware ID contain any of these, separated by ;'
            }
          >
            <SearchIcon width={14} height={14} />
            <input
              type="search"
              value={filterText}
              placeholder="Filter…"
              aria-label="Only the statuses containing"
              spellCheck={false}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="overlay-button diag-regex"
            aria-pressed={regex}
            title="As a regular expression"
            aria-label="As a regular expression"
            onClick={() => setRegex((on) => !on)}
          >
            .*
          </button>
        </div>
        <div className="diag-tools">
          <button
            type="button"
            className="overlay-button"
            aria-pressed={view === 'tree'}
            title="As a tree"
            aria-label="As a tree"
            onClick={() => setView('tree')}
          >
            <TreeIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            aria-pressed={view === 'list'}
            title="As a list, the worst first"
            aria-label="As a list"
            onClick={() => setView('list')}
          >
            <ListIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            aria-pressed={view === 'changes'}
            title="The latest changes of level"
            aria-label="The latest changes"
            onClick={() => setView('changes')}
          >
            <HistoryIcon width={17} height={17} />
          </button>
          <span className="overlay-separator" />
          {view === 'tree' && (
            <button
              type="button"
              className="overlay-button"
              aria-pressed={folding.mode === 'all'}
              title={folding.mode === 'all' ? 'Unfold only the groups with problems' : 'Unfold all the groups'}
              aria-label="Unfold all the groups"
              onClick={() => setFolding({ mode: folding.mode === 'all' ? 'auto' : 'all', chosen: new Map() })}
            >
              <UnfoldIcon width={17} height={17} />
            </button>
          )}
          <button
            type="button"
            className="overlay-button"
            aria-pressed={model.frozen !== null}
            title={model.frozen ? 'Resume' : 'Pause: the statuses stay as they are'}
            aria-label={model.frozen ? 'Resume' : 'Pause'}
            onClick={() => dispatch({ type: model.frozen ? 'resume' : 'pause' })}
          >
            <PauseIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            title={view === 'changes' ? 'Download the changes shown' : 'Download the statuses shown'}
            aria-label={view === 'changes' ? 'Download the changes shown' : 'Download the statuses shown'}
            disabled={view === 'changes' ? shownChanges.length === 0 : shown.list.length === 0}
            onClick={downloadShown}
          >
            <DownloadIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            title={`Forget the statuses no longer published${gone.length > 0 ? ` (${gone.length})` : ''}`}
            aria-label="Forget the statuses no longer published"
            disabled={gone.length === 0}
            onClick={() => dispatch({ type: 'forget', ids: gone })}
          >
            <TrashIcon width={17} height={17} />
          </button>
        </div>
      </div>
      <div className={`diag-body${beside ? ' beside' : ''}`}>
        <div className="diag-main">{content}</div>
        {details && (
          <StatusDetails
            entry={details.entry}
            label={details.label}
            changes={changes}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      <div className={`diag-status ${line.tone}`} title={line.text}>
        {line.tone === 'ok' || line.tone === 'warn' || line.tone === 'error' || line.tone === 'stale' ? (
          <LevelIcon level={line.tone} size={12} />
        ) : (
          <span className="diag-dot" aria-hidden="true" />
        )}
        <span className="diag-status-text">{line.text}</span>
      </div>
    </div>
  );
}

export const diagnosticsWidget = defineWidget<DiagnosticsConfig>({
  type: 'diagnostics',
  name: 'Diagnostics',
  description: 'The robot’s diagnostics (/diagnostics, /diagnostics_agg): each status’s level, message and values, filtered by level and text.',
  icon: DiagnosticsIcon,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },
  component: DiagnosticsWidget,
  properties: [
    {
      key: 'topic',
      label: 'Diagnostics topic',
      kind: 'topic',
      default: '/diagnostics',
      topicTypes: ['diagnostic_msgs/msg/DiagnosticArray'],
      help: 'diagnostic_msgs/DiagnosticArray: /diagnostics has every node’s statuses, /diagnostics_agg the aggregator’s tree of them',
    },
    {
      key: 'statuses',
      label: 'Statuses',
      kind: 'string',
      default: '',
      placeholder: 'Sensors, motor_*',
      help: 'Only these, with those under them: names, paths or globs (*), separated by commas. From the root if they start with /, else at any depth. All if empty',
    },
    {
      key: 'level',
      label: 'Levels shown',
      kind: 'select',
      default: 'ok',
      options: [
        { value: 'ok', label: 'All' },
        { value: 'warn', label: 'Problems: warnings, errors, stale' },
        { value: 'stale', label: 'Errors and stale' },
        { value: 'error', label: 'Errors only' },
      ],
      help: 'When the panel opens: its toolbar shows and hides each level',
    },
    {
      key: 'filter',
      label: 'Filter',
      kind: 'string',
      default: '',
      placeholder: 'lidar; battery',
      help: 'Only the statuses whose name, message or hardware ID contain any of these, separated by ;. The toolbar changes it',
    },
    {
      key: 'regex',
      label: 'Filter as a regular expression',
      kind: 'boolean',
      default: false,
    },
    {
      key: 'view',
      label: 'View',
      kind: 'select',
      default: 'tree',
      options: [
        { value: 'tree', label: 'Tree' },
        { value: 'list', label: 'List, the worst first' },
        { value: 'changes', label: 'Latest changes of level' },
      ],
      help: 'When the panel opens: its toolbar changes it',
    },
  ],
});
