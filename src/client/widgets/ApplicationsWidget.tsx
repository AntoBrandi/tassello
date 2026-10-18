// The robot's applications, its systemd services (e.g. myrobot-*): their
// state, buttons to start, stop and restart them, and their output (their
// journal), shown like a button's. Of the system's service manager and the
// user's.

import { useEffect, useRef, useState } from 'react';

import type { ServiceInfo, ServiceVerb, ServicesUpdate } from '../../shared/protocol.ts';
import { connection } from '../connection.ts';
import { useDialogs } from '../dialogs.tsx';
import { AppsIcon, PlayIcon, RefreshIcon, StopIcon, TerminalIcon } from '../icons.tsx';
import { notify } from '../notifications.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

interface ApplicationsConfig {
  services: string;
  confirmStop: boolean;
}

// Kept in the page, the latest
const OUTPUT_LIMIT = 16_000;

const VERBS: Record<ServiceVerb, string> = { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' };

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  }
  return `${Math.floor(s / 86400)} d`;
}

// Its state, in words, and its colour (see .service-dot in styles.css)
function describe(service: ServiceInfo, now: number): { text: string; tone: string } {
  const since = service.since ? ` · ${duration(now - service.since)}` : '';
  if (service.load === 'not-found') {
    return { text: 'Not installed', tone: 'off' };
  }
  switch (service.active) {
    case 'active':
      return service.sub === 'running'
        ? { text: `Running${since}`, tone: 'on' }
        : { text: `Active (${service.sub})${since}`, tone: 'on' };
    case 'activating':
      return { text: 'Starting…', tone: 'busy' };
    case 'deactivating':
      return { text: 'Stopping…', tone: 'busy' };
    case 'reloading':
      return { text: 'Reloading…', tone: 'busy' };
    case 'failed':
      return { text: `Failed (${service.result})${since}`, tone: 'failed' };
    default:
      return { text: 'Stopped', tone: 'off' };
  }
}

// "myrobot-laser.service" -> "laser", for the name "myrobot"
function shortName(unit: string, pattern: string): string {
  const name = unit.replace(/\.service$/, '');
  const prefix = pattern.trim().replace(/[*?[].*$/, '').replace(/\.service$/, '');
  const short = prefix && name.startsWith(prefix) ? name.slice(prefix.length).replace(/^[-_.]+/, '') : '';
  return short || name;
}

function ServiceOutput({ service }: { service: ServiceInfo }) {
  const [text, setText] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);
  const { unit, scope } = service;
  useEffect(() => {
    setText('');
    return connection.subscribeLogs({ unit, scope }, ({ text: chunk, reset }) =>
      setText((shown) => (reset ? chunk : shown + chunk).slice(-OUTPUT_LIMIT)),
    );
  }, [unit, scope]);
  useEffect(() => {
    const output = outputRef.current;
    if (output) {
      output.scrollTop = output.scrollHeight;
    }
  }, [text]);
  return (
    <pre ref={outputRef} className="command-output service-output">
      {text || 'No output yet'}
    </pre>
  );
}

function ApplicationsWidget({ config }: WidgetProps<ApplicationsConfig>) {
  const dialogs = useDialogs();
  const [update, setUpdate] = useState<ServicesUpdate | null>(null);
  // Units whose output is shown
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Units with a start, stop or restart under way, and which
  const [pending, setPending] = useState<Record<string, ServiceVerb>>({});
  const [, setTick] = useState(0);

  const pattern = config.services.trim();
  useEffect(() => {
    setUpdate(null);
    if (!pattern) {
      return;
    }
    return connection.subscribeServices({ pattern }, setUpdate);
  }, [pattern]);

  // Ticks the durations
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const key = (service: ServiceInfo) => `${service.scope} ${service.unit}`;

  const act = async (service: ServiceInfo, verb: ServiceVerb) => {
    const name = shortName(service.unit, pattern);
    if (verb !== 'start' && config.confirmStop) {
      const confirmed = await dialogs.confirm({
        title: `${verb === 'stop' ? 'Stop' : 'Restart'} ${name}?`,
        message: service.self
          ? 'This is the dashboard itself: the page loses its server until it is running again.'
          : `${service.unit}: ${service.description}`,
        confirmLabel: verb === 'stop' ? 'Stop' : 'Restart',
        danger: true,
      });
      if (!confirmed) {
        return;
      }
    }
    setPending((current) => ({ ...current, [key(service)]: verb }));
    const error = await connection.serviceAction(service.unit, service.scope, verb);
    setPending(({ [key(service)]: _, ...rest }) => rest);
    if (error) {
      notify(`Could not ${verb} ${name}: ${error}`, 'error');
    }
  };

  if (!pattern) {
    return <div className="widget-message">No services: set their name in edit mode</div>;
  }
  if (!update) {
    return <div className="widget-message">Listing the services…</div>;
  }
  if (update.services.length === 0) {
    return <div className={`widget-message${update.error ? ' error' : ''}`}>{update.error ?? `No service matches “${pattern}”`}</div>;
  }
  const scopes = new Set(update.services.map((service) => service.scope));
  const now = connection.serverNow();
  return (
    <ul className="services">
      {update.services.map((service) => {
        const id = key(service);
        const verb = pending[id];
        const state = verb ? { text: VERBS[verb], tone: 'busy' } : describe(service, now);
        const running = ['active', 'activating', 'reloading'].includes(service.active);
        const shown = open.has(id);
        return (
          <li key={id} className="service">
            <div className="service-row">
              <span className={`service-dot ${state.tone}`} aria-hidden="true" />
              <div className="service-text" title={`${service.unit}: ${service.description}`}>
                <span className="service-name">
                  {shortName(service.unit, pattern)}
                  {service.self && <span className="service-tag">this dashboard</span>}
                  {service.enabled === 'enabled' && <span className="service-tag">at boot</span>}
                  {scopes.size > 1 && <span className="service-tag">{service.scope}</span>}
                </span>
                <span className={`service-state ${state.tone}`}>{state.text}</span>
              </div>
              <div className="service-actions">
                {running ? (
                  <>
                    <button
                      type="button"
                      className="service-button"
                      title="Restart"
                      aria-label={`Restart ${service.unit}`}
                      disabled={!!verb}
                      onClick={() => act(service, 'restart')}
                    >
                      <RefreshIcon width={16} height={16} />
                    </button>
                    <button
                      type="button"
                      className="service-button stop"
                      title="Stop"
                      aria-label={`Stop ${service.unit}`}
                      disabled={!!verb}
                      onClick={() => act(service, 'stop')}
                    >
                      <StopIcon width={16} height={16} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="service-button start"
                    title="Start"
                    aria-label={`Start ${service.unit}`}
                    disabled={!!verb || service.load === 'not-found'}
                    onClick={() => act(service, 'start')}
                  >
                    <PlayIcon width={16} height={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="service-button"
                  title={shown ? 'Hide the output' : 'Show the output'}
                  aria-label={`Output of ${service.unit}`}
                  aria-pressed={shown}
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (!next.delete(id)) {
                        next.add(id);
                      }
                      return next;
                    })
                  }
                >
                  <TerminalIcon width={16} height={16} />
                </button>
              </div>
            </div>
            {shown && <ServiceOutput service={service} />}
          </li>
        );
      })}
    </ul>
  );
}

export const applicationsWidget = defineWidget<ApplicationsConfig>({
  type: 'applications',
  name: 'Application Manager',
  description: 'The robot’s systemd services: their state, start and stop them, see their output.',
  icon: AppsIcon,
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 4, h: 2 },
  component: ApplicationsWidget,
  properties: [
    {
      key: 'services',
      label: 'Services',
      kind: 'string',
      default: '',
      placeholder: 'myrobot',
      help: 'The start of their names (myrobot: myrobot*.service), or a glob (myrobot-nav*)',
    },
    {
      key: 'confirmStop',
      label: 'Ask before stopping',
      kind: 'boolean',
      default: true,
      help: 'And before restarting',
    },
  ],
});
