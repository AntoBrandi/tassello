// What the monitor's sheets share: the details' header and tabs, the nodes
// of a service or an action, a definition, the time going by.

import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';

import type { InterfaceInfo } from '../../../shared/monitor.ts';
import { connection } from '../../connection.ts';
import { CloseIcon, CopyIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { copyText } from '../file_manager/folders.ts';

export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => connection.serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(connection.serverNow()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

// An interface's definition and schemas, null while asked; its error if it
// could not be had
export function useInterface(type: string | null): { info: InterfaceInfo | null; error: string | null } {
  const [state, setState] = useState<{ info: InterfaceInfo | null; error: string | null; type: string | null }>({
    info: null,
    error: null,
    type: null,
  });
  useEffect(() => {
    if (!type) {
      return;
    }
    let live = true;
    connection.interfaceInfo(type).then(
      (info) => live && setState({ info, error: null, type }),
      (e: unknown) => live && setState({ info: null, error: e instanceof Error ? e.message : String(e), type }),
    );
    return () => {
      live = false;
    };
  }, [type]);
  return state.type === type ? state : { info: null, error: null };
}

export function copy(text: string, what: string): void {
  copyText(text).then(
    () => notify(`Copied ${what}`),
    (e: unknown) => notify(`Could not copy ${what}: ${e instanceof Error ? e.message : e}`, 'error'),
  );
}

export interface Tab<T extends string> {
  id: T;
  label: string;
  title: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

// A topic's, a service's, an action's: its name, its type, and its tabs
export function DetailsHeader<T extends string>({
  name,
  type,
  Icon,
  tabs,
  tab,
  onTab,
  onClose,
}: {
  name: string;
  type: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tabs: Tab<T>[];
  tab: T;
  onTab: (tab: T) => void;
  onClose: () => void;
}) {
  return (
    <header className="mon-details-header">
      <div className="mon-details-title">
        <Icon width={15} height={15} className="mon-details-icon" />
        <div className="mon-details-names">
          <strong className="mon-details-name" title={name}>
            {name}
          </strong>
          <button
            type="button"
            className="mon-details-type"
            title={`${type}: click to copy`}
            onClick={() => copy(type, 'the type')}
          >
            {type || 'Type unknown'}
          </button>
        </div>
        <button type="button" className="overlay-button" title="Copy the name" aria-label="Copy the name" onClick={() => copy(name, 'the name')}>
          <CopyIcon width={15} height={15} />
        </button>
        <button type="button" className="overlay-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <CloseIcon width={15} height={15} />
        </button>
      </div>
      <div className="mon-tabs" role="tablist">
        {tabs.map(({ id, label, title, Icon: TabIcon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="mon-tab"
            aria-selected={tab === id}
            title={title}
            onClick={() => onTab(id)}
          >
            <TabIcon width={13} height={13} />
            <span className="mon-tab-name">{label}</span>
          </button>
        ))}
      </div>
    </header>
  );
}

export function Section({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <section className="mon-section">
      <h3 className="mon-heading">
        {title}
        {detail !== undefined && <span className="mon-heading-detail">{detail}</span>}
      </h3>
      {children}
    </section>
  );
}

// Nodes of the graph; the dashboard's own named so
export function NodeList({ nodes, self, empty }: { nodes: string[]; self: string; empty: string }) {
  if (nodes.length === 0) {
    return <p className="mon-muted">{empty}</p>;
  }
  return (
    <ul className="mon-nodes">
      {nodes.map((node) => (
        <li key={node}>
          <span className="mon-node">{node}</span>
          {node === self && <span className="mon-self">this dashboard</span>}
        </li>
      ))}
    </ul>
  );
}

// ros2 interface show
export function Definition({ type }: { type: string }) {
  const { info, error } = useInterface(type);
  if (error) {
    return <p className="mon-error">{error}</p>;
  }
  if (!info) {
    return <p className="mon-muted">Reading its definition…</p>;
  }
  return (
    <div className="mon-definition">
      <div className="mon-bar">
        <span className="mon-bar-text">ros2 interface show {type}</span>
        <span className="mon-spacer" />
        {info.text !== null && (
          <button
            type="button"
            className="overlay-button"
            title="Copy the definition"
            aria-label="Copy the definition"
            onClick={() => copy(info.text ?? '', 'the definition')}
          >
            <CopyIcon width={15} height={15} />
          </button>
        )}
      </div>
      {info.text !== null ? (
        <pre className="mon-code">{info.text || '(no fields)'}</pre>
      ) : (
        <p className="mon-muted">Its file was not found in the ROS packages sourced</p>
      )}
    </div>
  );
}

// The colour of a state, as the networking widget has them
export function Dot({ tone }: { tone: string }) {
  return <span className={`mon-dot ${tone}`} aria-hidden="true" />;
}
