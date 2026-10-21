// A service, as the ros2 service verbs show it: a request to call it with,
// once or repeatedly, and its response (call), the nodes serving and using
// it (info), its requests and responses as they go (echo, when the service
// introspects them: since Jazzy), and its type's definition.

import { useEffect, useRef, useState } from 'react';

import type { GraphSnapshot, TopicEcho, TopicStats } from '../../../shared/monitor.ts';
import { connection } from '../../connection.ts';
import { CodeIcon, CopyIcon, InfoIcon, LogsIcon, SendIcon, ServiceIcon, StopIcon } from '../../icons.tsx';
import { MessageForm } from './MessageForm.tsx';
import { MessageView } from './MessageView.tsx';
import { formatSeconds, serviceEventTopic, yamlText, type Entry } from './model.ts';
import { copy, Definition, DetailsHeader, NodeList, Section, useInterface, type Tab } from './parts.tsx';
import { EchoView, HISTORY } from './TopicDetails.tsx';

export type ServiceTab = 'call' | 'info' | 'echo' | 'type';

const TABS: Tab<ServiceTab>[] = [
  { id: 'call', label: 'Call', title: 'Call it (ros2 service call)', Icon: SendIcon },
  { id: 'info', label: 'Info', title: 'The nodes serving and using it (ros2 service info)', Icon: InfoIcon },
  { id: 'echo', label: 'Echo', title: 'Its requests and responses as they go (ros2 service echo)', Icon: LogsIcon },
  { id: 'type', label: 'Type', title: 'Its type’s definition (ros2 interface show)', Icon: CodeIcon },
];

interface Draft {
  request: unknown;
  repeat: boolean;
  rate: string;
  timeout: string;
}

// Of the page's services, kept while it lives
const drafts = new Map<string, Draft>();

interface Call {
  // On the page's clock
  at: number;
  ms: number;
  response: unknown;
  error: string | null;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

function CallView({ service, type }: { service: string; type: string }) {
  const { info, error } = useInterface(type || null);
  const key = `${service} ${type}`;
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(key) ?? null);
  const [calling, setCalling] = useState(false);
  const [repeating, setRepeating] = useState(false);
  const [last, setLast] = useState<Call | null>(null);
  const [count, setCount] = useState(0);
  // The repetition going on: what stops it
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  const request = info?.parts[0];
  if (!type) {
    return <p className="mon-muted">Its type is not known</p>;
  }
  if (error) {
    return <p className="mon-error">{error}</p>;
  }
  if (!info || !request) {
    return <p className="mon-muted">Reading its definition…</p>;
  }
  const current: Draft = draft ?? { request: request.default, repeat: false, rate: '1', timeout: '5' };
  const update = (change: Partial<Draft>) => {
    const next = { ...current, ...change };
    drafts.set(key, next);
    setDraft(next);
  };
  const timeoutMs = Math.round(Number(current.timeout) * 1000);
  const rate = Number(current.rate);
  const invalid =
    !(timeoutMs > 0) || timeoutMs > 60_000
      ? 'The timeout must be above 0 and at most 60 s'
      : current.repeat && (!(rate > 0) || rate > 100)
        ? 'The rate must be above 0 and at most 100'
        : null;

  const callOnce = async (): Promise<void> => {
    const at = Date.now();
    try {
      const response = await connection.callService(service, type, current.request, timeoutMs, { checked: true });
      setLast({ at, ms: Date.now() - at, response, error: null });
    } catch (e) {
      setLast({ at, ms: Date.now() - at, response: null, error: e instanceof Error ? e.message : String(e) });
    }
    setCount((c) => c + 1);
  };

  const start = () => {
    if (!current.repeat) {
      setCalling(true);
      void callOnce().finally(() => setCalling(false));
      return;
    }
    // ros2 service call --rate: one after the other, at most at the rate
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      const started = Date.now();
      await callOnce();
      if (!stopped) {
        timer = setTimeout(loop, Math.max(0, 1000 / rate - (Date.now() - started)));
      }
    };
    stopRef.current = () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      stopRef.current = null;
      setRepeating(false);
    };
    setRepeating(true);
    setCount(0);
    void loop();
  };

  const busy = calling || repeating;
  return (
    <div className="mon-pane-body">
      <MessageForm
        info={info}
        type={request.type}
        value={current.request}
        initial={request.default}
        onChange={(value) => update({ request: value })}
        disabled={busy}
      />
      <div className="mon-options">
        <div className="mon-segmented" role="group" aria-label="How often">
          <button type="button" aria-pressed={!current.repeat} disabled={busy} onClick={() => update({ repeat: false })}>
            Once
          </button>
          <button type="button" aria-pressed={current.repeat} disabled={busy} onClick={() => update({ repeat: true })}>
            Repeatedly
          </button>
        </div>
        {current.repeat && (
          <label className="mon-inline">
            <input
              type="text"
              inputMode="decimal"
              className="mon-input mon-short"
              value={current.rate}
              disabled={busy}
              aria-label="Calls a second"
              onChange={(e) => update({ rate: e.target.value })}
            />
            Hz
          </label>
        )}
        <label className="mon-inline" title="How long to wait for the service, then for its response">
          Timeout
          <input
            type="text"
            inputMode="decimal"
            className="mon-input mon-short"
            value={current.timeout}
            disabled={busy}
            onChange={(e) => update({ timeout: e.target.value })}
          />
          s
        </label>
      </div>
      <div className="mon-actions">
        {repeating ? (
          <button type="button" className="button danger" onClick={() => stopRef.current?.()}>
            <StopIcon width={14} height={14} /> Stop
          </button>
        ) : (
          <button type="button" className="button primary" disabled={invalid !== null || calling} title={invalid ?? undefined} onClick={start}>
            <SendIcon width={14} height={14} /> {calling ? 'Calling…' : current.repeat ? 'Start calling' : 'Call'}
          </button>
        )}
        {repeating && <span className="mon-result busy">{count.toLocaleString()} calls so far</span>}
      </div>
      {last && (
        <Section
          title={last.error ? 'Failed' : 'Response'}
          detail={`${clock(last.at)} · ${formatSeconds(last.ms / 1000)}${count > 1 ? ` · call ${count.toLocaleString()}` : ''}`}
        >
          {last.error ? (
            <p className="mon-error">{last.error}</p>
          ) : (
            <div className="mon-response">
              <button
                type="button"
                className="overlay-button mon-response-copy"
                title="Copy the response, as YAML"
                aria-label="Copy the response"
                onClick={() => copy(yamlText(last.response), 'the response')}
              >
                <CopyIcon width={14} height={14} />
              </button>
              <MessageView message={last.response} />
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ros2 service echo: the service's events, which its node publishes on
// <service>/_service_event when introspecting it
function EventsView({ service, graph, truncate }: { service: string; graph: GraphSnapshot; truncate: number }) {
  const topic = serviceEventTopic(service);
  const known = graph.topics.some((t) => t.name === topic);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [field, setField] = useState('');
  const [truncateLength, setTruncateLength] = useState(truncate);
  const [echoes, setEchoes] = useState<TopicEcho[]>([]);
  const [stats, setStats] = useState<TopicStats | null>(null);
  const [status, setStatus] = useState({ state: 'waiting', message: '' });

  useEffect(() => {
    setEchoes([]);
    if (!known) {
      return;
    }
    return connection.subscribeTopicMonitor(
      { topic, window: 100, echo: { field, truncate: truncateLength } },
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
  }, [topic, known, field, truncateLength]);

  if (!known) {
    return (
      <p className="mon-muted">
        No events: its node does not introspect it. Since Jazzy, a node does with configure_introspection; then its
        requests and responses are published on {topic}.
      </p>
    );
  }
  return (
    <EchoView
      echoes={echoes}
      stats={stats}
      status={{ ...status, message: status.message || 'Waiting for a call…' }}
      paused={paused}
      onPause={() => setPaused((p) => !p)}
      field={field}
      onField={setField}
      truncate={truncateLength}
      onTruncate={setTruncateLength}
    />
  );
}

export function ServiceDetails({
  service,
  graph,
  initialTab,
  truncate,
  onClose,
}: {
  service: Entry;
  graph: GraphSnapshot;
  initialTab: ServiceTab;
  truncate: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ServiceTab>(initialTab);
  const type = service.types[0] ?? '';
  const endpoints = graph.services.find((s) => s.name === service.name);
  let content;
  if (tab === 'call') {
    content = <CallView service={service.name} type={type} />;
  } else if (tab === 'info') {
    content = (
      <div className="mon-pane-body">
        <Section title="Servers" detail={endpoints?.servers.length ?? 0}>
          <NodeList nodes={endpoints?.servers ?? []} self={graph.self} empty="None: calls wait for one" />
        </Section>
        <Section title="Clients" detail={endpoints?.clients.length ?? 0}>
          <NodeList nodes={endpoints?.clients ?? []} self={graph.self} empty="None" />
        </Section>
      </div>
    );
  } else if (tab === 'echo') {
    content = <EventsView service={service.name} graph={graph} truncate={truncate} />;
  } else {
    content = type ? <Definition type={type} /> : <p className="mon-muted">Its type is not known</p>;
  }
  return (
    <section className="mon-details" aria-label={`${service.name}: details`}>
      <DetailsHeader name={service.name} type={service.types.join(', ')} Icon={ServiceIcon} tabs={TABS} tab={tab} onTab={setTab} onClose={onClose} />
      <div className="mon-pane">{content}</div>
    </section>
  );
}
