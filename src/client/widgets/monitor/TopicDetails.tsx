// A topic, as the ros2 topic verbs show it: its messages (echo), their rate,
// bandwidth and delay (hz, bw, delay), its publishers and subscriptions with
// their QoS (info --verbose), a message to publish (pub), and its type's
// definition (ros2 interface show).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { PublishQos, TopicDetails as Details, TopicEcho, TopicEndpoint, TopicStats } from '../../../shared/monitor.ts';
import { connection } from '../../connection.ts';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BoltIcon,
  CodeIcon,
  CopyIcon,
  InfoIcon,
  LogsIcon,
  PauseIcon,
  PencilIcon,
  SendIcon,
  StopIcon,
  TopicIcon,
} from '../../icons.tsx';
import { MessageForm } from './MessageForm.tsx';
import { MessageView } from './MessageView.tsx';
import {
  formatBytes,
  formatRate,
  formatSeconds,
  hasTruncated,
  policyName,
  qosDuration,
  qosSummary,
  yamlText,
  type Entry,
} from './model.ts';
import { copy, Definition, DetailsHeader, Dot, Section, useInterface, useNow, type Tab } from './parts.tsx';
import type { Publishings } from './publishing.ts';

export type TopicTab = 'echo' | 'rate' | 'info' | 'publish' | 'type';

const TABS: Tab<TopicTab>[] = [
  { id: 'echo', label: 'Echo', title: 'Its messages (ros2 topic echo)', Icon: LogsIcon },
  { id: 'rate', label: 'Rate', title: 'Their rate, bandwidth and delay (ros2 topic hz, bw, delay)', Icon: BoltIcon },
  { id: 'info', label: 'Info', title: 'Its publishers and subscriptions, with their QoS (ros2 topic info -v)', Icon: InfoIcon },
  { id: 'publish', label: 'Publish', title: 'Publish a message (ros2 topic pub)', Icon: SendIcon },
  { id: 'type', label: 'Type', title: 'Its type’s definition (ros2 interface show)', Icon: CodeIcon },
];

// Echoes kept to go back through while paused
export const HISTORY = 100;
export const TRUNCATE_OPTIONS = [16, 128, 1000, 10_000];
export const WINDOW_OPTIONS = [10, 100, 1000, 10_000];

// What a page publishes on a topic, kept while it lives: the message edited,
// how often
interface Draft {
  message: unknown;
  mode: 'once' | 'rate';
  rate: string;
  times: string;
  qos: PublishQos;
}

const drafts = new Map<string, Draft>();

// The options, and the value chosen if another (the widget's property)
function withValue(options: number[], value: number): number[] {
  return [...new Set([...options, value])].sort((a, b) => a - b);
}

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function spreadText(spread: { mean: number; min: number; max: number; stdDev: number }, format: (v: number) => string): string {
  return `min ${format(spread.min)} · max ${format(spread.max)} · std dev ${format(spread.stdDev)}`;
}

function Figure({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className={`mon-figure${tone ? ` ${tone}` : ''}`}>
      <span className="mon-figure-label">{label}</span>
      <span className="mon-figure-value">{value}</span>
      {detail && <span className="mon-figure-detail">{detail}</span>}
    </div>
  );
}

// No message for this long: the figures are of the past
function silence(stats: TopicStats | null, now: number): number | null {
  if (!stats?.lastAt) {
    return null;
  }
  const quiet = (now - stats.lastAt) / 1000;
  const expected = stats.interval ? stats.interval.mean * 3 : 2;
  return quiet > Math.max(2, expected) ? quiet : null;
}

function RateView({
  stats,
  status,
  hasHeader,
  window,
  onWindow,
}: {
  stats: TopicStats | null;
  status: { state: string; message: string };
  hasHeader: boolean;
  window: number;
  onWindow: (window: number) => void;
}) {
  const now = useNow(500);
  const quiet = silence(stats, now);
  return (
    <div className="mon-pane-body">
      <div className="mon-bar">
        <label className="mon-inline">
          Window
          <select className="mon-select" value={window} onChange={(e) => onWindow(Number(e.target.value))} title="The latest messages the figures are of (ros2 topic hz --window)">
            {withValue(WINDOW_OPTIONS, window).map((w) => (
              <option key={w} value={w}>
                {w.toLocaleString()} messages
              </option>
            ))}
          </select>
        </label>
      </div>
      {!stats || stats.received === 0 ? (
        <p className={status.state === 'error' ? 'mon-error' : 'mon-muted'}>{status.message || 'Waiting for messages…'}</p>
      ) : (
        <div className="mon-figures">
          <Figure
            label="Rate"
            value={stats.rate !== null ? formatRate(stats.rate) : '—'}
            detail={stats.interval ? `Between messages: ${formatSeconds(stats.interval.mean)} on average, ${spreadText(stats.interval, formatSeconds)}` : 'Two messages are needed'}
            tone={quiet ? 'stale' : undefined}
          />
          <Figure
            label="Bandwidth"
            value={stats.bandwidth !== null ? `${formatBytes(stats.bandwidth)}/s` : '—'}
            detail={stats.size ? `Messages: ${formatBytes(stats.size.mean)} on average, ${spreadText(stats.size, formatBytes)}` : undefined}
          />
          <Figure
            label="Delay"
            value={stats.delay ? formatSeconds(stats.delay.mean) : '—'}
            detail={
              stats.delay
                ? `From header.stamp to arrival, on the ROS clock: ${spreadText(stats.delay, formatSeconds)}`
                : hasHeader
                  ? 'Waiting for messages'
                  : 'Its messages have no header to stamp them (ros2 topic delay needs one)'
            }
          />
          <Figure
            label="Received"
            value={stats.received.toLocaleString()}
            detail={`${quiet ? `None for ${formatSeconds(quiet)}` : `The latest ${formatSeconds(Math.max(0, (now - (stats.lastAt ?? now)) / 1000))} ago`} · figures of the latest ${stats.window.toLocaleString()}`}
            tone={quiet ? 'stale' : undefined}
          />
        </div>
      )}
    </div>
  );
}

export function EchoView({
  echoes,
  stats,
  status,
  paused,
  onPause,
  field,
  onField,
  truncate,
  onTruncate,
  onPublish,
}: {
  echoes: TopicEcho[];
  stats: TopicStats | null;
  status: { state: string; message: string };
  paused: boolean;
  onPause: () => void;
  field: string;
  onField: (field: string) => void;
  truncate: number;
  onTruncate: (truncate: number) => void;
  // Edits the message shown, to publish it; none for those that cannot be
  onPublish?: (message: unknown) => void;
}) {
  const [fieldText, setFieldText] = useState(field);
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => setFieldText(field), [field]);
  // Running: the latest
  useEffect(() => {
    if (!paused) {
      setIndex(null);
    }
  }, [paused]);
  const at = index ?? echoes.length - 1;
  const shown = echoes[at];
  const cut = shown ? hasTruncated(shown.message) : false;
  return (
    <div className="mon-pane-body echo">
      <div className="mon-bar">
        <button
          type="button"
          className="overlay-button"
          aria-pressed={paused}
          title={paused ? 'Resume' : 'Pause: go back through the latest messages'}
          aria-label={paused ? 'Resume' : 'Pause'}
          onClick={onPause}
        >
          <PauseIcon width={15} height={15} />
        </button>
        <input
          type="search"
          className="mon-input mon-field-path"
          value={fieldText}
          placeholder="Field: pose.position"
          title="Only this field of the messages (ros2 topic echo --field): names separated by dots, list items by their index. Enter to apply"
          aria-label="Only this field"
          spellCheck={false}
          onChange={(e) => {
            setFieldText(e.target.value);
            if (!e.target.value) {
              onField('');
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onField(fieldText.trim());
            }
          }}
          onBlur={() => onField(fieldText.trim())}
        />
        <select
          className="mon-select"
          value={truncate}
          title="Lists and strings longer than this are cut (ros2 topic echo --truncate-length)"
          aria-label="Lists cut after"
          onChange={(e) => onTruncate(Number(e.target.value))}
        >
          {withValue(TRUNCATE_OPTIONS, truncate).map((t) => (
            <option key={t} value={t}>
              ≤ {t.toLocaleString()} items
            </option>
          ))}
        </select>
        <span className="mon-spacer" />
        <button
          type="button"
          className="overlay-button"
          title="Copy the message, as YAML"
          aria-label="Copy the message"
          disabled={!shown || shown.message === undefined}
          onClick={() => shown && copy(yamlText(shown.message), 'the message')}
        >
          <CopyIcon width={15} height={15} />
        </button>
        {onPublish && (
          <button
            type="button"
            className="overlay-button"
            title={
              cut
                ? 'Parts of it are cut: show its lists whole to publish it'
                : field
                  ? 'Publish whole messages: clear the field first'
                  : 'Edit it and publish it'
            }
            aria-label="Edit and publish"
            disabled={!shown || cut || field !== '' || shown.message === undefined}
            onClick={() => shown && onPublish(shown.message)}
          >
            <PencilIcon width={15} height={15} />
          </button>
        )}
      </div>
      {shown ? (
        <>
          <div className="mon-echo-meta">
            {paused && echoes.length > 1 && (
              <span className="mon-stepper">
                <button type="button" className="overlay-button" aria-label="The one before" disabled={at <= 0} onClick={() => setIndex(at - 1)}>
                  <ArrowLeftIcon width={13} height={13} />
                </button>
                <span>
                  {at + 1} of {echoes.length}
                </span>
                <button type="button" className="overlay-button" aria-label="The one after" disabled={at >= echoes.length - 1} onClick={() => setIndex(at + 1)}>
                  <ArrowRightIcon width={13} height={13} />
                </button>
              </span>
            )}
            <span title="Its number since the widget started following the topic">#{shown.seq.toLocaleString()}</span>
            <time>{clock(shown.receivedAt)}</time>
            <span>{formatBytes(shown.size)}</span>
            {stats?.rate != null && !paused && <span>{formatRate(stats.rate)}</span>}
            {paused && <span className="mon-paused">paused</span>}
          </div>
          <div className="mon-echo">
            <MessageView message={shown.message} />
          </div>
        </>
      ) : (
        <p className={status.state === 'error' ? 'mon-error' : 'mon-muted'}>{status.message || 'Waiting for messages…'}</p>
      )}
    </div>
  );
}

function Endpoint({ endpoint, self }: { endpoint: TopicEndpoint; self: string }) {
  const { qos } = endpoint;
  return (
    <li>
      <details className="mon-endpoint">
        <summary>
          <span className="mon-node">{endpoint.node}</span>
          {endpoint.node === self && <span className="mon-self">this dashboard</span>}
          <span className="mon-qos">{qosSummary(qos)}</span>
        </summary>
        <dl className="mon-facts">
          <div>
            <dt>Type</dt>
            <dd>{endpoint.type}</dd>
          </div>
          <div>
            <dt>Reliability</dt>
            <dd>{policyName(qos.reliability)}</dd>
          </div>
          <div>
            <dt>Durability</dt>
            <dd>{policyName(qos.durability)}</dd>
          </div>
          <div>
            <dt>History (depth)</dt>
            <dd>
              {policyName(qos.history)}
              {qos.depth > 0 && ` (${qos.depth})`}
            </dd>
          </div>
          <div>
            <dt>Deadline</dt>
            <dd>{qosDuration(qos.deadline)}</dd>
          </div>
          <div>
            <dt>Lifespan</dt>
            <dd>{qosDuration(qos.lifespan)}</dd>
          </div>
          <div>
            <dt>Liveliness</dt>
            <dd>{policyName(qos.liveliness)}</dd>
          </div>
          <div>
            <dt>Liveliness lease</dt>
            <dd>{qosDuration(qos.leaseDuration)}</dd>
          </div>
        </dl>
      </details>
    </li>
  );
}

function InfoView({ topic, self }: { topic: string; self: string }) {
  const [details, setDetails] = useState<Details | null>(null);
  useEffect(() => {
    setDetails(null);
    return connection.subscribeTopicInfo(topic, setDetails);
  }, [topic]);
  if (!details) {
    return <p className="mon-muted">Reading its endpoints…</p>;
  }
  const types = [...new Set([...details.publishers, ...details.subscriptions].map((e) => e.type))];
  return (
    <div className="mon-pane-body">
      {details.problems.length > 0 && (
        <Section title="They do not talk" detail={`${details.problems.length}`}>
          <ul className="mon-problems">
            {details.problems.map((problem, i) => (
              <li key={i}>
                <span className="mon-problem-nodes">
                  {details.publishers[problem.publisher]?.node} → {details.subscriptions[problem.subscription]?.node}
                </span>
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {types.length > 1 && <p className="mon-error">Its endpoints disagree on its type: {types.join(', ')}</p>}
      <Section title="Publishers" detail={details.publishers.length}>
        {details.publishers.length ? (
          <ul className="mon-endpoints">
            {details.publishers.map((endpoint, i) => (
              <Endpoint key={i} endpoint={endpoint} self={self} />
            ))}
          </ul>
        ) : (
          <p className="mon-muted">None</p>
        )}
      </Section>
      <Section title="Subscriptions" detail={details.subscriptions.length}>
        {details.subscriptions.length ? (
          <ul className="mon-endpoints">
            {details.subscriptions.map((endpoint, i) => (
              <Endpoint key={i} endpoint={endpoint} self={self} />
            ))}
          </ul>
        ) : (
          <p className="mon-muted">None</p>
        )}
      </Section>
    </div>
  );
}

const DEFAULT_QOS: PublishQos = { reliability: 'auto', durability: 'auto', depth: 10 };

function PublishView({
  topic,
  type,
  draft,
  onDraft,
  publishings,
}: {
  topic: string;
  type: string;
  draft: Draft | null;
  onDraft: (draft: Draft) => void;
  publishings: Publishings;
}) {
  const { info, error } = useInterface(type || null);
  useSyncExternalStore(publishings.subscribe, publishings.list);
  const publishing = publishings.get(topic);
  const part = info?.parts[0];
  const current: Draft | null = draft ?? (part ? { message: part.default, mode: 'once', rate: '10', times: '', qos: DEFAULT_QOS } : null);

  if (!type) {
    return <p className="mon-muted">Its type is not known: nobody publishes or subscribes to it</p>;
  }
  if (error) {
    return <p className="mon-error">{error}</p>;
  }
  if (!info || !part || !current) {
    return <p className="mon-muted">Reading its definition…</p>;
  }
  const running = publishing !== undefined && !publishing.state.done;
  const update = (change: Partial<Draft>) => onDraft({ ...current, ...change });
  const rate = Number(current.rate);
  const times = current.times.trim() ? Number(current.times) : 0;
  const invalid =
    current.mode === 'rate' && (!(rate > 0) || rate > 1000 || !Number.isInteger(times) || times < 0)
      ? 'The rate must be above 0 and at most 1000, the count a whole number'
      : null;

  const start = () =>
    publishings.start({
      topic,
      messageType: type,
      message: current.message,
      rate: current.mode === 'once' ? 0 : rate,
      times: current.mode === 'once' ? 1 : times,
      qos: current.qos,
    });

  let line: { text: string; tone: string } | null = null;
  if (publishing?.state.error) {
    line = { text: publishing.state.error, tone: 'failed' };
  } else if (publishing) {
    const { count, done } = publishing.state;
    const messages = `${count.toLocaleString()} message${count === 1 ? '' : 's'}`;
    line = done ? { text: `Published ${messages}`, tone: 'on' } : { text: `Publishing: ${messages} so far`, tone: 'busy' };
  }

  return (
    <div className="mon-pane-body">
      <MessageForm
        info={info}
        type={part.type}
        value={current.message}
        initial={part.default}
        onChange={(message) => update({ message })}
        disabled={running}
      />
      <div className="mon-options">
        <div className="mon-segmented" role="group" aria-label="How often">
          <button type="button" aria-pressed={current.mode === 'once'} disabled={running} onClick={() => update({ mode: 'once' })}>
            Once
          </button>
          <button type="button" aria-pressed={current.mode === 'rate'} disabled={running} onClick={() => update({ mode: 'rate' })}>
            Repeatedly
          </button>
        </div>
        {current.mode === 'rate' && (
          <>
            <label className="mon-inline">
              <input
                type="text"
                inputMode="decimal"
                className="mon-input mon-short"
                value={current.rate}
                disabled={running}
                aria-label="Rate"
                onChange={(e) => update({ rate: e.target.value })}
              />
              Hz
            </label>
            <label className="mon-inline">
              <input
                type="text"
                inputMode="numeric"
                className="mon-input mon-short"
                value={current.times}
                placeholder="∞"
                title="How many messages: empty until stopped (ros2 topic pub --times)"
                disabled={running}
                aria-label="How many messages"
                onChange={(e) => update({ times: e.target.value })}
              />
              times
            </label>
          </>
        )}
      </div>
      <details className="mon-qos-options">
        <summary>
          QoS:{' '}
          {current.qos.reliability === 'auto' && current.qos.durability === 'auto'
            ? 'matching the subscriptions'
            : `${policyName(current.qos.reliability)}, ${policyName(current.qos.durability)}`}
          , depth {current.qos.depth}
        </summary>
        <div className="mon-options">
          <label className="mon-inline">
            Reliability
            <select
              className="mon-select"
              value={current.qos.reliability}
              disabled={running}
              onChange={(e) => update({ qos: { ...current.qos, reliability: e.target.value as PublishQos['reliability'] } })}
            >
              <option value="auto">Auto: reliable</option>
              <option value="reliable">Reliable</option>
              <option value="best_effort">Best effort</option>
            </select>
          </label>
          <label className="mon-inline">
            Durability
            <select
              className="mon-select"
              value={current.qos.durability}
              disabled={running}
              onChange={(e) => update({ qos: { ...current.qos, durability: e.target.value as PublishQos['durability'] } })}
            >
              <option value="auto">Auto: as the subscriptions</option>
              <option value="volatile">Volatile</option>
              <option value="transient_local">Transient local (latched)</option>
            </select>
          </label>
          <label className="mon-inline">
            Depth
            <input
              type="number"
              min={1}
              max={1000}
              className="mon-input mon-short"
              value={current.qos.depth}
              disabled={running}
              onChange={(e) =>
                update({ qos: { ...current.qos, depth: Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)) } })
              }
            />
          </label>
        </div>
      </details>
      <div className="mon-actions">
        {running ? (
          <button type="button" className="button danger" onClick={() => publishings.stop(topic)}>
            <StopIcon width={14} height={14} /> Stop
          </button>
        ) : (
          <button type="button" className="button primary" disabled={invalid !== null} title={invalid ?? undefined} onClick={start}>
            <SendIcon width={14} height={14} /> {current.mode === 'once' ? 'Publish' : 'Start publishing'}
          </button>
        )}
        {line && (
          <span className={`mon-result ${line.tone}`}>
            <Dot tone={line.tone} />
            {line.text}
          </span>
        )}
      </div>
    </div>
  );
}

export function TopicDetails({
  topic,
  self,
  initialTab,
  window,
  truncate,
  publishings,
  onClose,
}: {
  topic: Entry;
  self: string;
  initialTab: TopicTab;
  window: number;
  truncate: number;
  publishings: Publishings;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TopicTab>(initialTab);
  const type = topic.types[0] ?? '';
  const [windowSize, setWindowSize] = useState(window);
  const [truncateLength, setTruncateLength] = useState(truncate);
  const [field, setField] = useState('');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [echoes, setEchoes] = useState<TopicEcho[]>([]);
  const [stats, setStats] = useState<TopicStats | null>(null);
  const [status, setStatus] = useState({ state: 'waiting', message: '' });
  const draftKey = `${topic.name} ${type}`;
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(draftKey) ?? null);
  const { info } = useInterface(tab === 'rate' && type ? type : null);
  const hasHeader = info?.schemas[type]?.fields[0]?.type === 'std_msgs/msg/Header';

  useEffect(() => setWindowSize(window), [window]);
  useEffect(() => setTruncateLength(truncate), [truncate]);

  // One subscription for both tabs, which keeps its figures: paused, the
  // messages that come are not kept
  const following = tab === 'echo' || tab === 'rate';
  useEffect(() => {
    if (!following) {
      return;
    }
    setStats(null);
    setStatus({ state: 'waiting', message: '' });
    return connection.subscribeTopicMonitor(
      { topic: topic.name, window: windowSize, echo: { field, truncate: truncateLength } },
      {
        status: (state, message) => setStatus({ state, message }),
        stats: setStats,
        echo: (echo) => {
          if (!pausedRef.current) {
            setEchoes((list) => [...list.slice(-(HISTORY - 1)), echo]);
          }
        },
      },
    );
  }, [topic.name, following, windowSize, field, truncateLength]);

  // Other messages: those of before are not of them
  useEffect(() => setEchoes([]), [topic.name, field, truncateLength]);

  const saveDraft = (next: Draft) => {
    drafts.set(draftKey, next);
    setDraft(next);
  };

  let content;
  if (tab === 'echo') {
    content = (
      <EchoView
        echoes={echoes}
        stats={stats}
        status={status}
        paused={paused}
        onPause={() => setPaused((p) => !p)}
        field={field}
        onField={setField}
        truncate={truncateLength}
        onTruncate={setTruncateLength}
        onPublish={(message) => {
          saveDraft({ ...(draft ?? { mode: 'once', rate: '10', times: '', qos: DEFAULT_QOS }), message });
          setTab('publish');
        }}
      />
    );
  } else if (tab === 'rate') {
    content = <RateView stats={stats} status={status} hasHeader={hasHeader} window={windowSize} onWindow={setWindowSize} />;
  } else if (tab === 'info') {
    content = <InfoView topic={topic.name} self={self} />;
  } else if (tab === 'publish') {
    content = <PublishView topic={topic.name} type={type} draft={draft} onDraft={saveDraft} publishings={publishings} />;
  } else {
    content = type ? <Definition type={type} /> : <p className="mon-muted">Its type is not known</p>;
  }

  return (
    <section className="mon-details" aria-label={`${topic.name}: details`}>
      <DetailsHeader name={topic.name} type={topic.types.join(', ')} Icon={TopicIcon} tabs={TABS} tab={tab} onTab={setTab} onClose={onClose} />
      <div className="mon-pane">{content}</div>
    </section>
  );
}
