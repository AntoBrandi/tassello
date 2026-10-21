// The ROS graph, as the ros2 command line shows it, on sheets: its topics,
// services and actions, filtered by name or type, the hidden ones on demand.
// A topic's messages, rate, bandwidth and delay, endpoints and QoS, a message
// to publish (ros2 topic echo, hz, bw, delay, info, pub); a service to call
// (ros2 service call, info, echo); an action's goals, whoever sent them, and
// a goal to send (ros2 action send_goal, info); their types' definitions
// (ros2 interface show).
//
// The server polls the graph (see src/server/ros_graph.ts) and follows what
// the pages ask (topic_monitor.ts, actions.ts); what a widget publishes goes
// on while it shows other topics, until stopped.

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';

import type { GraphSnapshot } from '../../../shared/monitor.ts';
import { connection } from '../../connection.ts';
import { ActionIcon, EyeIcon, EyeOffIcon, MonitorIcon, SearchIcon, ServiceIcon, StopIcon, TopicIcon } from '../../icons.tsx';
import { shortCount, textMatch } from '../logs/model.ts';
import { defineWidget, type WidgetProps } from '../types.ts';
import { ActionDetails } from './ActionDetails.tsx';
import { filterEntries, sheetEntries, shortType, type Entry, type Sheet } from './model.ts';
import { Dot } from './parts.tsx';
import { Publishings } from './publishing.ts';
import { ServiceDetails } from './ServiceDetails.tsx';
import { TopicDetails } from './TopicDetails.tsx';

interface MonitorConfig {
  sheet: Sheet;
  name: string;
  filter: string;
  regex: boolean;
  hidden: boolean;
  window: number;
  truncate: number;
}

const SHEETS: { sheet: Sheet; label: string; title: string; Icon: typeof TopicIcon; out: string; in: string }[] = [
  { sheet: 'topics', label: 'Topics', title: 'The topics (ros2 topic list)', Icon: TopicIcon, out: 'publishers', in: 'subscribers' },
  { sheet: 'services', label: 'Services', title: 'The services (ros2 service list)', Icon: ServiceIcon, out: 'servers', in: 'clients' },
  { sheet: 'actions', label: 'Actions', title: 'The actions (ros2 action list)', Icon: ActionIcon, out: 'servers', in: 'clients' },
];

// Wider than this, the details are beside the list, else under it
const DETAILS_BESIDE_PX = 680;
// Shorter than this, the details take the place of the list
const SHORT_PX = 380;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function Row({
  entry,
  sheet,
  selected,
  onSelect,
}: {
  entry: Entry;
  sheet: (typeof SHEETS)[number];
  selected: boolean;
  onSelect: (entry: Entry) => void;
}) {
  const several = entry.types.length > 1;
  return (
    <li>
      <button
        type="button"
        className={`mon-row${selected ? ' selected' : ''}${entry.hidden ? ' hidden' : ''}`}
        aria-current={selected || undefined}
        data-name={entry.name}
        onClick={() => onSelect(entry)}
      >
        <span className="mon-row-name">{entry.name}</span>
        <span className={`mon-row-type${several ? ' warn' : ''}`} title={entry.types.join(', ')}>
          {several ? `${entry.types.length} types` : shortType(entry.types[0] ?? '')}
        </span>
        <span className="mon-row-counts" title={`${plural(entry.out, sheet.out.replace(/s$/, ''))}, ${plural(entry.in, sheet.in.replace(/s$/, ''))}`}>
          <span className={`mon-count${entry.out === 0 ? ' none' : ''}`}>{shortCount(entry.out)}</span>
          <span className={`mon-count in${entry.in === 0 ? ' none' : ''}`}>{shortCount(entry.in)}</span>
        </span>
      </button>
    </li>
  );
}

function MonitorWidget({ config }: WidgetProps<MonitorConfig>) {
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [sheet, setSheet] = useState<Sheet>(config.sheet);
  const [filterText, setFilterText] = useState(config.filter);
  const [regex, setRegex] = useState(config.regex);
  const [hidden, setHidden] = useState(config.hidden);
  // The entry shown, as last seen in the graph
  const [selected, setSelected] = useState<{ sheet: Sheet; entry: Entry } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [publishings] = useState(() => new Publishings());
  const publishing = useSyncExternalStore(publishings.subscribe, publishings.list);

  useEffect(() => setSheet(config.sheet), [config.sheet]);
  useEffect(() => setFilterText(config.filter), [config.filter]);
  useEffect(() => setRegex(config.regex), [config.regex]);
  useEffect(() => setHidden(config.hidden), [config.hidden]);
  useEffect(() => () => publishings.stopAll(), [publishings]);

  useEffect(() => connection.subscribeGraph(setGraph), []);

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

  // The configured one, once in the graph
  const opened = useRef(false);
  useEffect(() => {
    const name = config.name.trim();
    if (!graph || opened.current || !name) {
      return;
    }
    const entry = sheetEntries(graph, config.sheet).find((e) => e.name === name || e.name === `/${name}`);
    if (entry) {
      opened.current = true;
      setSelected({ sheet: config.sheet, entry });
    }
  }, [graph, config.name, config.sheet]);

  const text = useDeferredValue(filterText);
  const match = useMemo(() => textMatch(text, regex), [text, regex]);
  const all = useMemo(
    () => Object.fromEntries(SHEETS.map(({ sheet: s }) => [s, sheetEntries(graph, s)])) as Record<Sheet, Entry[]>,
    [graph],
  );
  const shown = useMemo(() => filterEntries(all[sheet], hidden, match.test), [all, sheet, hidden, match]);
  const hiddenCount = all[sheet].filter((e) => e.hidden).length;

  // The entry shown, as the graph has it now
  const current = selected && (all[selected.sheet].find((e) => e.name === selected.entry.name) ?? null);
  const details = selected ? { sheet: selected.sheet, entry: current ?? selected.entry, gone: graph !== null && !current } : null;

  const select = (entry: Entry) =>
    setSelected((now) => (now?.sheet === sheet && now.entry.name === entry.name ? null : { sheet, entry }));

  const onListKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const index = shown.findIndex((e) => details?.sheet === sheet && e.name === details.entry.name);
    const next = shown[Math.max(0, Math.min(shown.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      setSelected({ sheet, entry: next });
      listRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(next.name)}"]`)?.focus();
    }
  };

  const sheetInfo = SHEETS.find((s) => s.sheet === sheet)!;
  const { width, height } = size;
  const beside = width >= DETAILS_BESIDE_PX;
  const running = publishing.filter((p) => !p.state.done);

  let content;
  if (!graph) {
    content = <p className="mon-empty">Reading the ROS graph…</p>;
  } else if (shown.length === 0) {
    content = (
      <p className="mon-empty">
        {all[sheet].length === 0
          ? `No ${sheet} in the ROS graph`
          : match.test
            ? `No ${sheet.replace(/s$/, '')} matches the filter${!hidden && hiddenCount ? ', among those not hidden' : ''}`
            : `Only hidden ${sheet}: show them with the eye`}
      </p>
    );
  } else {
    content = (
      <ul ref={listRef} className="mon-list" aria-label={sheetInfo.label} onKeyDown={onListKey}>
        {shown.map((entry) => (
          <Row
            key={entry.name}
            entry={entry}
            sheet={sheetInfo}
            selected={details?.sheet === sheet && details.entry.name === entry.name}
            onSelect={select}
          />
        ))}
      </ul>
    );
  }

  let panel = null;
  if (details && graph) {
    const close = () => setSelected(null);
    const key = `${details.sheet} ${details.entry.name}`;
    if (details.sheet === 'topics') {
      panel = (
        <TopicDetails
          key={key}
          topic={details.entry}
          self={graph.self}
          initialTab="echo"
          window={config.window}
          truncate={config.truncate}
          publishings={publishings}
          onClose={close}
        />
      );
    } else if (details.sheet === 'services') {
      panel = <ServiceDetails key={key} service={details.entry} graph={graph} initialTab="call" truncate={config.truncate} onClose={close} />;
    } else {
      panel = <ActionDetails key={key} action={details.entry} graph={graph} initialTab="goals" onClose={close} />;
    }
  }

  let line: { text: string; tone: string };
  if (!graph) {
    line = { text: 'Reading the ROS graph…', tone: 'idle' };
  } else {
    const one = sheet.replace(/s$/, '');
    const listed = hidden ? all[sheet].length : all[sheet].length - hiddenCount;
    const parts = [
      shown.length < listed ? `${shown.length.toLocaleString()} of ${plural(listed, one)} shown` : plural(listed, one),
    ];
    if (!hidden && hiddenCount > 0) {
      parts.push(`${hiddenCount.toLocaleString()} hidden`);
    }
    parts.push(plural(graph.nodes.length, 'node'));
    if (details?.gone) {
      parts.unshift(`${details.entry.name} is gone from the graph`);
    }
    line = { text: parts.join(' · '), tone: details?.gone ? 'warn' : 'idle' };
  }

  return (
    <div
      ref={rootRef}
      className={`mon${panel && !beside && height > 0 && height < SHORT_PX ? ' cramped' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected) {
          setSelected(null);
        }
      }}
    >
      <div className="mon-toolbar" role="toolbar" aria-label="ROS monitor">
        <div className="mon-sheets" role="tablist" aria-label="Sheets">
          {SHEETS.map(({ sheet: s, label, title, Icon }) => (
            <button
              key={s}
              type="button"
              role="tab"
              className="mon-sheet"
              aria-selected={sheet === s}
              title={title}
              onClick={() => setSheet(s)}
            >
              <Icon width={14} height={14} />
              <span className="mon-sheet-name">{label}</span>
              <span className="mon-sheet-count">{shortCount(filterEntries(all[s], hidden, null).length)}</span>
            </button>
          ))}
        </div>
        <label className={`mon-search${match.error ? ' invalid' : ''}`} title={match.error ?? 'Only those whose name or type contain any of these, separated by ;'}>
          <SearchIcon width={14} height={14} />
          <input
            type="search"
            value={filterText}
            placeholder="Filter…"
            aria-label="Only those whose name or type contain"
            spellCheck={false}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </label>
        <div className="mon-tools">
          <button
            type="button"
            className="overlay-button mon-regex"
            aria-pressed={regex}
            title="As a regular expression"
            aria-label="As a regular expression"
            onClick={() => setRegex((on) => !on)}
          >
            .*
          </button>
          <button
            type="button"
            className="overlay-button"
            aria-pressed={hidden}
            title={`${hidden ? 'Hide' : 'Show'} the hidden ones (${hiddenCount}): names with a part starting with _ (an action’s topics and services)${sheet === 'services' ? ', and every node’s parameter services' : ''}`}
            aria-label={hidden ? 'Hide the hidden ones' : 'Show the hidden ones'}
            onClick={() => setHidden((on) => !on)}
          >
            {hidden ? <EyeIcon width={17} height={17} /> : <EyeOffIcon width={17} height={17} />}
          </button>
        </div>
      </div>
      <div className={`mon-body${beside ? ' beside' : ''}`}>
        <div className="mon-main">{content}</div>
        {panel}
      </div>
      <div className={`mon-status ${line.tone}`}>
        <Dot tone={line.tone} />
        <span className="mon-status-text" title={line.text}>
          {line.text}
        </span>
        {running.map((p) => (
          <span key={p.topic} className="mon-publishing" title={`Publishing on ${p.topic}: ${p.state.count.toLocaleString()} so far`}>
            <Dot tone="busy" />
            <span className="mon-publishing-topic">{p.topic}</span>
            <span className="mon-publishing-count">{shortCount(p.state.count)}</span>
            <button type="button" className="overlay-button" aria-label={`Stop publishing on ${p.topic}`} title="Stop publishing" onClick={() => publishings.stop(p.topic)}>
              <StopIcon width={11} height={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export const monitorWidget = defineWidget<MonitorConfig>({
  type: 'monitor',
  name: 'ROS Monitor',
  description:
    'The ROS graph, as the ros2 command line shows it: topics to echo, measure and publish on, services to call, actions’ goals to follow and send.',
  icon: MonitorIcon,
  defaultSize: { w: 10, h: 8 },
  minSize: { w: 3, h: 4 },
  component: MonitorWidget,
  properties: [
    {
      key: 'sheet',
      label: 'Sheet',
      kind: 'select',
      default: 'topics',
      options: [
        { value: 'topics', label: 'Topics' },
        { value: 'services', label: 'Services' },
        { value: 'actions', label: 'Actions' },
      ],
      help: 'When the panel opens: its toolbar changes it',
    },
    {
      key: 'name',
      label: 'Opened',
      kind: 'string',
      default: '',
      placeholder: '/odom',
      help: 'A topic, service or action of the sheet to open with the panel, e.g. a widget showing /odom’s messages',
    },
    {
      key: 'filter',
      label: 'Filter',
      kind: 'string',
      default: '',
      placeholder: 'scan; nav2_msgs',
      help: 'Only those whose name or type contain any of these, separated by ;. The toolbar changes it',
    },
    { key: 'regex', label: 'Filter as a regular expression', kind: 'boolean', default: false },
    {
      key: 'hidden',
      label: 'Show the hidden ones',
      kind: 'boolean',
      default: false,
      help: 'Names with a part starting with _ (an action’s topics and services), and every node’s parameter services',
    },
    {
      key: 'window',
      label: 'Rate window (messages)',
      kind: 'number',
      default: 100,
      min: 2,
      max: 10_000,
      step: 1,
      help: 'The latest messages a topic’s rate, bandwidth and delay are of (ros2 topic hz --window)',
    },
    {
      key: 'truncate',
      label: 'Echoed lists cut after',
      kind: 'number',
      default: 128,
      min: 1,
      max: 10_000,
      step: 1,
      help: 'Lists and strings longer than this are cut (ros2 topic echo --truncate-length)',
    },
  ],
});
