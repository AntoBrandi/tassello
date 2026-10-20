// The behavior tree inspector: what a BT.CPP behavior tree is doing, from its
// log (nav2_msgs/msg/BehaviorTreeLog, Nav2's /behavior_tree_log), on the tree
// of its XML file: the running branch, each node's status and last result,
// its counts and ports, and the latest transitions. As a graph or a list.
//
// The server follows the log and keeps the nodes' state (see
// src/server/behavior_trees.ts): the page gets the tree, then what changes,
// at most 10 times a second. It also records the log into rosbags, and plays
// them back (RecordPlayback.tsx): the widget shows them as it shows the log.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import type { BehaviorTreeRecording, StreamStatus } from '../../../shared/protocol.ts';
import { connection, type BehaviorTreeHandlers, type BehaviorTreePlaybackRequest } from '../../connection.ts';
import { FileBrowser } from '../../editor/FileInput.tsx';
import {
  CloseIcon,
  FilmIcon,
  FitIcon,
  HistoryIcon,
  ListIcon,
  NavigationIcon,
  RecordIcon,
  TreeIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { BehaviorTreeGraph } from './BehaviorTreeGraph.tsx';
import { BehaviorTreeList } from './BehaviorTreeList.tsx';
import type { Direction } from './layout.ts';
import {
  activeNodes,
  clockTime,
  duration,
  EMPTY,
  nodeLabel,
  reduce,
  statusLabel,
  toneOf,
  type Model,
} from './model.ts';
import { KindIcon, kindLabel } from './parts.tsx';
import { baseName, PlaybackBar, playbackTime, RecordDialog, type Playback } from './RecordPlayback.tsx';

type View = 'graph' | 'list';

interface BehaviorTreeConfig {
  topic: string;
  tree: string;
  view: 'auto' | View;
  direction: Direction;
  showPorts: boolean;
  recordFolder: string;
}

// Narrower than this, the automatic view is the list
const NARROW_PX = 420;
// The details' (.bt-details), with their margins; on narrower widgets they
// cover the tree, which has no room to be beside them
const DETAILS_PX = 300 + 16;
const BESIDE_DETAILS_PX = 240;
// Shown in the details, of the node's
const NODE_TRANSITIONS = 8;

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => connection.serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(connection.serverNow()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

// What the tree is doing, in a line
function summary(model: Model, status: { state: StreamStatus['state']; message: string }, now: number) {
  if (status.state === 'error') {
    return { text: status.message, tone: 'error' };
  }
  // What it does first, actions and conditions, then what waits for them
  const rank = (node: number) => (['action', 'condition'].includes(model.nodes[node].kind ?? '') ? 0 : 1);
  const active = activeNodes(model).sort((a, b) => rank(a) - rank(b));
  if (active.length > 0) {
    const names = active.slice(0, 2).map((node) => model.nodes[node].name);
    const since = model.states[active[0]]?.since;
    return {
      text: `Running ${names.join(', ')}${active.length > 2 ? ` and ${active.length - 2} more` : ''}${
        since ? ` · ${duration(now - since)}` : ''
      }`,
      tone: 'running',
    };
  }
  const root = model.treeSize > 0 ? model.states[0] : undefined;
  if (root?.status === 'SUCCESS' || root?.status === 'FAILURE') {
    return { text: root.status === 'SUCCESS' ? 'Succeeded' : 'Failed', tone: toneOf(root.status) };
  }
  if (root?.result) {
    return {
      text: `Idle · its last run ${root.result === 'SUCCESS' ? 'succeeded' : 'failed'}${root.since ? `, ${duration(now - root.since)} ago` : ''}`,
      tone: 'idle',
    };
  }
  if (status.state === 'waiting') {
    return { text: status.message, tone: 'idle' };
  }
  return { text: 'Idle', tone: 'idle' };
}

function NodeDetails({
  model,
  index,
  now,
  onSelect,
  onClose,
}: {
  model: Model;
  index: number;
  now: number;
  onSelect: (node: number) => void;
  onClose: () => void;
}) {
  const node = model.nodes[index];
  const state = model.states[index];
  const ancestors: number[] = [];
  for (let parent = node.parent; parent >= 0; parent = model.nodes[parent].parent) {
    ancestors.unshift(parent);
  }
  const ports = Object.entries(node.ports);
  const recent = model.transitions.filter((t) => t.node === index).slice(-NODE_TRANSITIONS).reverse();
  let since = 'not seen changing';
  if (state?.since) {
    since = `for ${duration(now - state.since)}`;
  } else if (state?.status) {
    since = 'since before this page';
  }
  return (
    <aside className="bt-details" aria-label={`${node.name}: details`}>
      <header className="bt-details-header">
        <KindIcon node={node} size={18} />
        <div className="bt-details-title">
          <strong>{node.type}</strong>
          <span>
            {node.name !== node.type ? `${node.name} · ` : ''}
            {kindLabel(node)}
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="bt-details-body">
        {ancestors.length > 0 && (
          <nav className="bt-path" aria-label="Its parents">
            {ancestors.map((ancestor) => (
              <button key={ancestor} type="button" onClick={() => onSelect(ancestor)}>
                {model.nodes[ancestor].name}
              </button>
            ))}
          </nav>
        )}
        <dl className="bt-facts">
          <dt>Status</dt>
          <dd>
            {state?.status ? <span className={`bt-pill ${toneOf(state.status)}`}>{statusLabel(state.status)}</span> : 'Unknown'}{' '}
            <span className="bt-muted">{since}</span>
          </dd>
          {state?.result && (
            <>
              <dt>Last result</dt>
              <dd>
                <span className={`bt-pill ${toneOf(state.result)}`}>{statusLabel(state.result)}</span>
              </dd>
            </>
          )}
          <dt>Seen</dt>
          <dd>
            {state?.changes ?? 0} transitions · <span className="success">{state?.successes ?? 0} successes</span> ·{' '}
            <span className="failure">{state?.failures ?? 0} failures</span>
          </dd>
        </dl>
        {ports.length > 0 && (
          <section>
            <h3>Ports</h3>
            <dl className="bt-ports">
              {ports.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd className={/^\{.*\}$/.test(value) ? 'entry' : undefined}>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        <section>
          <h3>Latest transitions</h3>
          {recent.length > 0 ? (
            <ol className="bt-node-log">
              {recent.map((t) => (
                <li key={t.id}>
                  <time>{clockTime(t.time)}</time>
                  <span className={`bt-pill ${toneOf(t.from)}`}>{statusLabel(t.from)}</span>→
                  <span className={`bt-pill ${toneOf(t.to)}`}>{statusLabel(t.to)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="bt-muted">None seen</p>
          )}
        </section>
      </div>
    </aside>
  );
}

// The latest transitions of all the nodes, the newest at the bottom, followed
// unless scrolled up
function TransitionLog({ model, onSelect }: { model: Model; onSelect: (node: number) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && following.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [model.transitions]);
  return (
    <section className="bt-log" aria-label="Latest transitions">
      {model.transitions.length === 0 ? (
        <p className="bt-muted bt-log-empty">No transition yet</p>
      ) : (
        <ol
          ref={listRef}
          onScroll={(e) => {
            const list = e.currentTarget;
            following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
          }}
        >
          {model.transitions.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onSelect(t.node)}>
                <time>{clockTime(t.time)}</time>
                <span className="bt-log-node">{nodeLabel(model.nodes[t.node])}</span>
                <span className={`bt-pill ${toneOf(t.from)}`}>{statusLabel(t.from)}</span>→
                <span className={`bt-pill ${toneOf(t.to)}`}>{statusLabel(t.to)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BehaviorTreeWidget({ config, editing }: WidgetProps<BehaviorTreeConfig>) {
  const [model, dispatch] = useReducer(reduce, EMPTY);
  const [status, setStatus] = useState<{ state: StreamStatus['state']; message: string }>({
    state: 'waiting',
    message: 'Connecting…',
  });
  // Chosen with the toolbar, over the config's
  const [chosenView, setChosenView] = useState<View | null>(null);
  const [follow, setFollow] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const [focus, setFocus] = useState<{ node: number; seq: number } | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // The bag played back, else the live log
  const [bag, setBag] = useState<string | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const playbackId = useRef<number | null>(null);
  const [recording, setRecording] = useState<BehaviorTreeRecording['recording']>(null);
  const [recordDialog, setRecordDialog] = useState(false);
  const [choosingBag, setChoosingBag] = useState(false);
  // Recorded or played last: where the bags are browsed from
  const lastBag = useRef<string | null>(null);
  // Played, the slider moves smoothly
  const now = useNow(playback?.playing ? 250 : 1000);

  const topic = config.topic.trim();
  const tree = config.tree.trim();
  useEffect(() => {
    dispatch({ type: 'reset' });
    setRecording(null);
    setPlayback(null);
    playbackId.current = null;
    if (!topic && !bag) {
      setStatus({ state: 'error', message: 'No log topic: set one in edit mode' });
      return;
    }
    setStatus({ state: 'waiting', message: 'Connecting…' });
    const handlers: BehaviorTreeHandlers = {
      status: (state, message) => setStatus({ state, message }),
      tree: (info) => dispatch({ type: 'tree', tree: info }),
      update: (update) => dispatch({ type: 'update', update }),
      recording: setRecording,
      playback: (state) => setPlayback({ ...state, at: Date.now() }),
    };
    if (bag) {
      const { id, unsubscribe } = connection.subscribeBehaviorTreePlayback({ bag, topic, tree }, handlers);
      playbackId.current = id;
      return unsubscribe;
    }
    return connection.subscribeBehaviorTree({ topic, tree }, handlers);
  }, [topic, tree, bag]);

  // Shown at once, as the server will have it
  const control = useCallback((request: BehaviorTreePlaybackRequest) => {
    if (playbackId.current === null) {
      return;
    }
    setPlayback(
      (current) =>
        current && {
          ...current,
          time: request.time ?? playbackTime(current),
          playing: request.playing ?? current.playing,
          speed: request.speed ?? current.speed,
          at: Date.now(),
        },
    );
    connection.controlBehaviorTreePlayback(playbackId.current, request);
  }, []);

  const stopRecording = async () => {
    try {
      const path = await connection.recordBehaviorTree(topic, null);
      if (path) {
        lastBag.current = path;
        notify(`Recorded ${topic} into ${path}`);
      }
    } catch (e) {
      notify(`Could not stop recording ${topic}: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  // Another tree: what was chosen of the last one goes
  useEffect(() => {
    setSelected(null);
    setFolded(new Set());
  }, [model.version]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selected === null) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const fold = useCallback((node: number) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(node)) {
        next.add(node);
      }
      return next;
    });
  }, []);

  // From the list, the log or the details: the graph shows it too
  const show = useCallback((node: number) => {
    setSelected(node);
    setFocus((current) => ({ node, seq: (current?.seq ?? 0) + 1 }));
  }, []);

  const hasTree = model.treeSize > 0;
  const view: View = !hasTree
    ? 'list'
    : (chosenView ?? (config.view === 'auto' ? (width < NARROW_PX ? 'list' : 'graph') : config.view));
  const detailsShown = selected !== null && model.nodes[selected] !== undefined;
  const covered = detailsShown && width - DETAILS_PX >= BESIDE_DETAILS_PX ? DETAILS_PX : 0;
  // Played back, the bag's clock is what the durations count on
  const clock = playback ? playbackTime(playback) : now;
  const line = summary(model, status, clock);
  if (bag && playback && !playback.error) {
    line.text = `${baseName(bag)}: ${line.text}`;
  }
  const banners: { text: string; title?: string; tone: 'error' | 'warning' }[] = [];
  if (model.error) {
    banners.push({ text: `${model.error}. The nodes are the log’s`, tone: 'error' });
  }
  if (model.mismatch) {
    banners.push({ text: model.mismatch, tone: 'warning' });
  }
  if (model.warnings.length > 0) {
    banners.push({
      text: model.warnings[0] + (model.warnings.length > 1 ? ` (and ${model.warnings.length - 1} more)` : ''),
      title: model.warnings.join('\n'),
      tone: 'warning',
    });
  }

  let content;
  if (!model.received) {
    content = <div className="widget-message">{status.state === 'error' ? status.message : 'Reading the tree…'}</div>;
  } else if (model.nodes.length === 0) {
    content = (
      <div className="widget-message">
        {tree
          ? 'The nodes will show as they change'
          : 'No tree file: the nodes will show as they change. Set the tree’s file in edit mode to see it whole'}
      </div>
    );
  } else if (view === 'graph') {
    content = (
      <BehaviorTreeGraph
        model={model}
        direction={config.direction}
        showPorts={config.showPorts}
        folded={folded}
        selected={selected}
        follow={follow}
        focus={focus}
        fitRequest={fitRequest}
        covered={covered}
        onSelect={setSelected}
        onFold={fold}
        onPan={() => setFollow(false)}
      />
    );
  } else {
    content = (
      <BehaviorTreeList
        model={model}
        folded={folded}
        selected={selected}
        follow={follow}
        now={clock}
        onSelect={setSelected}
        onFold={fold}
      />
    );
  }

  return (
    <div ref={rootRef} className="bt">
      {banners.map((banner) => (
        <div key={banner.text} className={`bt-banner ${banner.tone}`} title={banner.title ?? banner.text}>
          {banner.text}
        </div>
      ))}
      <div className={`bt-main ${view}`}>
        {content}
        <div className="overlay-toolbar">
          {view === 'graph' && (
            <button
              type="button"
              className="overlay-button"
              title="Fit the tree"
              aria-label="Fit the tree"
              onClick={() => {
                setFollow(false);
                setFitRequest((n) => n + 1);
              }}
            >
              <FitIcon width={17} height={17} />
            </button>
          )}
          <button
            type="button"
            className="overlay-button"
            aria-pressed={follow}
            title="Follow the running nodes"
            aria-label="Follow the running nodes"
            onClick={() => setFollow((on) => !on)}
          >
            <NavigationIcon width={17} height={17} />
          </button>
          <span className="overlay-separator" />
          <button
            type="button"
            className="overlay-button"
            aria-pressed={view === 'graph'}
            title={hasTree ? 'As a graph' : 'As a graph: needs the tree’s file'}
            aria-label="As a graph"
            disabled={!hasTree}
            onClick={() => setChosenView('graph')}
          >
            <TreeIcon width={17} height={17} />
          </button>
          <button
            type="button"
            className="overlay-button"
            aria-pressed={view === 'list'}
            title="As a list"
            aria-label="As a list"
            onClick={() => setChosenView('list')}
          >
            <ListIcon width={17} height={17} />
          </button>
          <span className="overlay-separator" />
          <button
            type="button"
            className="overlay-button"
            aria-pressed={showLog}
            title="The latest transitions"
            aria-label="The latest transitions"
            onClick={() => setShowLog((on) => !on)}
          >
            <HistoryIcon width={17} height={17} />
          </button>
          <span className="overlay-separator" />
          {!bag && (
            <button
              type="button"
              className={`overlay-button${recording ? ' recording' : ''}`}
              aria-pressed={recording !== null}
              title={recording ? `Stop recording into ${recording.path}` : 'Record the log into a rosbag'}
              aria-label={recording ? 'Stop recording' : 'Record the log'}
              disabled={!topic || editing}
              onClick={() => (recording ? void stopRecording() : setRecordDialog(true))}
            >
              <RecordIcon width={17} height={17} />
            </button>
          )}
          <button
            type="button"
            className="overlay-button"
            aria-pressed={bag !== null}
            title={bag ? `Back to the live log, from ${bag}` : 'Play a rosbag back'}
            aria-label={bag ? 'Back to the live log' : 'Play a rosbag back'}
            disabled={editing}
            onClick={() => (bag ? setBag(null) : setChoosingBag(true))}
          >
            <FilmIcon width={17} height={17} />
          </button>
        </div>
        {detailsShown && (
          <NodeDetails model={model} index={selected} now={clock} onSelect={show} onClose={() => setSelected(null)} />
        )}
      </div>
      {showLog && <TransitionLog model={model} onSelect={show} />}
      {bag && playback && <PlaybackBar playback={playback} onControl={control} onClose={() => setBag(null)} />}
      <div className={`bt-status ${line.tone}`} title={line.text}>
        <span className="bt-dot" aria-hidden="true" />
        <span className="bt-status-text">{line.text}</span>
        {recording && !bag && (
          <span className="bt-rec" title={`Recording into ${recording.path}`}>
            REC {duration(now - recording.since)}
          </span>
        )}
      </div>
      {recordDialog && (
        <RecordDialog
          topic={topic}
          folder={config.recordFolder}
          onRecording={(path) => (lastBag.current = path)}
          onClose={() => setRecordDialog(false)}
        />
      )}
      {choosingBag && (
        <FileBrowser
          kind="bag"
          // The last bag's folder: a bag is a folder, or a file in one
          start={lastBag.current?.replace(/\/+[^/]+\/*$/, '') || config.recordFolder}
          onChoose={(path) => {
            setChoosingBag(false);
            lastBag.current = path;
            setBag(path);
          }}
          onClose={() => setChoosingBag(false)}
        />
      )}
    </div>
  );
}

export const behaviorTreeWidget = defineWidget<BehaviorTreeConfig>({
  type: 'behavior-tree',
  name: 'Behavior Tree Inspector',
  description: 'What a behavior tree is doing: its running branch, its nodes’ status, and their transitions.',
  icon: TreeIcon,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },
  component: BehaviorTreeWidget,
  properties: [
    {
      key: 'topic',
      label: 'Log topic',
      kind: 'topic',
      default: '/behavior_tree_log',
      topicTypes: ['nav2_msgs/msg/BehaviorTreeLog'],
      help: 'nav2_msgs/BehaviorTreeLog: Nav2’s bt_navigator logs its tree on /behavior_tree_log',
    },
    {
      key: 'tree',
      label: 'Tree file',
      kind: 'behavior-tree',
      default: '',
      placeholder: 'package://nav2_bt_navigator/behavior_trees/navigate_to_pose_w_replanning_and_recovery.xml',
      help: 'The XML of the tree the robot runs (/…, ~/…, package://…), or upload it. Without it, the nodes are listed as they change',
    },
    {
      key: 'view',
      label: 'View',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Automatic: the graph, the list when narrow' },
        { value: 'graph', label: 'Graph' },
        { value: 'list', label: 'List' },
      ],
      help: 'Its toolbar switches between them',
    },
    {
      key: 'direction',
      label: 'Graph direction',
      kind: 'select',
      default: 'vertical',
      options: [
        { value: 'vertical', label: 'Top to bottom' },
        { value: 'horizontal', label: 'Left to right' },
      ],
      visible: (config) => config.view !== 'list',
    },
    {
      key: 'showPorts',
      label: 'Show the ports in the graph',
      kind: 'boolean',
      default: false,
      help: 'The nodes’ parameters and blackboard entries ({goal}); their details show them anyway',
      visible: (config) => config.view !== 'list',
    },
    {
      key: 'recordFolder',
      label: 'Recordings folder',
      kind: 'string',
      default: '~/bags',
      help: 'Where the record button puts its rosbags, and the playback button looks for them first',
    },
  ],
});
