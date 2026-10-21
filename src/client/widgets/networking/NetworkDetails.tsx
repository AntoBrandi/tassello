// What the Networking widget says of what is selected, beside or under its
// list: a Wi-Fi network in range, a saved connection, or an interface, with
// what can be done to it.

import type { ReactNode } from 'react';

import {
  DEVICE_ACTIVATED,
  SECURITY_LABELS,
  type NetworkConnection,
  type NetworkDevice,
  type WifiNetwork,
} from '../../../shared/networking.ts';
import { CloseIcon } from '../../icons.tsx';
import {
  activityFor,
  bandOf,
  connectionKindLabel,
  deviceKindLabel,
  deviceStatus,
  forDevices,
  lastUsedText,
  savedFor,
  type PageState,
} from './model.ts';
import { DeviceIcon, Dot, KindIcon, SignalIcon } from './parts.tsx';
import type { Actions, Selection } from './NetworkViews.tsx';

const METHOD_LABELS: Record<string, string> = {
  auto: 'Automatic (DHCP)',
  manual: 'Manual',
  shared: 'Shared: the robot gives the addresses',
  disabled: 'Disabled',
  'link-local': 'Link-local only',
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Pane({
  icon,
  name,
  title,
  children,
  footer,
  onClose,
}: {
  icon: ReactNode;
  name: string;
  title?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  return (
    <section className="net-details" aria-label={`${name}: details`}>
      <header className="net-details-header">
        <span className="net-details-icon">{icon}</span>
        <strong className="net-details-name" title={title ?? name}>
          {name}
        </strong>
        <span className="net-spacer" />
        <button type="button" className="overlay-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <CloseIcon width={16} height={16} />
        </button>
      </header>
      <div className="net-details-body">{children}</div>
      {footer && <footer className="net-details-actions">{footer}</footer>}
    </section>
  );
}

function Button({
  label,
  actions,
  danger = false,
  primary = false,
  disabled,
  onClick,
}: {
  label: string;
  actions: Actions;
  danger?: boolean;
  primary?: boolean;
  // Why not, besides the page's
  disabled?: string | null;
  onClick: () => void;
}) {
  const why = actions.blocked ?? disabled ?? null;
  return (
    <button
      type="button"
      className={`button${danger ? ' danger' : primary ? ' primary' : ''}`}
      disabled={why !== null}
      title={why ?? undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Addresses({ list }: { list: string[] }) {
  return list.length > 0 ? (
    <>
      {list.map((item) => (
        <span key={item} className="net-fact-line">
          {item}
        </span>
      ))}
    </>
  ) : (
    <span className="net-muted">None</span>
  );
}

// A file under /run is NetworkManager's in memory: lost at reboot, unless it
// is netplan's, made again from /etc/netplan at every boot
function fileNote(file: string): string | null {
  if (/\/netplan-[^/]*$/.test(file)) {
    return 'From netplan (/etc/netplan)';
  }
  if (file.startsWith('/run/')) {
    return 'In memory: lost at reboot';
  }
  return null;
}

function ConnectionFacts({
  state,
  connection,
  now,
  signal = true,
}: {
  state: PageState;
  connection: NetworkConnection;
  now: number;
  // Its network's in range, if not said already
  signal?: boolean;
}) {
  const device = state.devices.find((d) => d.name === connection.device);
  const wireless = connection.kind === 'wifi' || connection.kind === 'hotspot';
  const inRange =
    signal && connection.kind === 'wifi' ? state.networks.find((n) => n.ssid === connection.ssid) : undefined;
  const note = fileNote(connection.file);
  const active = device?.state === DEVICE_ACTIVATED;
  let status: ReactNode;
  if (connection.activeState === 'activated') {
    status = (
      <>
        <Dot tone="on" /> {connection.kind === 'hotspot' ? 'On' : 'Connected'}, on {connection.device}
      </>
    );
  } else if (connection.activeState) {
    status = (
      <>
        <Dot tone="busy" /> {device ? deviceStatus(device, state.wifi).text : connection.activeState}
      </>
    );
  } else {
    status = 'Not connected';
  }
  return (
    <dl className="net-facts">
      <Fact label="Status">{status}</Fact>
      <Fact label="Kind">{connectionKindLabel(connection)}</Fact>
      {wireless && connection.ssid && connection.ssid !== connection.name && <Fact label="Network">{connection.ssid}</Fact>}
      {wireless && connection.security && <Fact label="Security">{SECURITY_LABELS[connection.security]}</Fact>}
      {connection.security === 'wpa-eap' && connection.identity && <Fact label="User name">{connection.identity}</Fact>}
      {connection.kind === 'hotspot' && (
        <Fact label="Band">
          {connection.band ? (connection.band === 'a' ? '5 GHz' : '2.4 GHz') : 'Automatic'}
          {connection.channel > 0 && `, channel ${connection.channel}`}
        </Fact>
      )}
      {inRange && (
        <Fact label="Signal">
          {inRange.signal}% · {bandOf(inRange.frequency)}, channel {inRange.channel}
        </Fact>
      )}
      {connection.hidden && <Fact label="Hidden">Its name is not shown: looked for by name</Fact>}
      {(connection.kind === 'wifi' || connection.kind === 'hotspot' || connection.kind === 'ethernet') && (
        <Fact label="Interface">{connection.interface || 'Any'}</Fact>
      )}
      {connection.ipv4Method && <Fact label="IPv4">{METHOD_LABELS[connection.ipv4Method] ?? connection.ipv4Method}</Fact>}
      {(active || connection.addresses.length > 0) && (
        <Fact label="Address">
          <Addresses list={active ? device!.ipv4 : connection.addresses} />
        </Fact>
      )}
      {(active ? device!.gateway : connection.gateway) && <Fact label="Gateway">{active ? device!.gateway : connection.gateway}</Fact>}
      {(active ? device!.dns : connection.dns).length > 0 && (
        <Fact label="DNS">
          <Addresses list={active ? device!.dns : connection.dns} />
        </Fact>
      )}
      <Fact label="Automatic">
        {connection.autoconnect
          ? `Yes${connection.priority !== 0 ? `, priority ${connection.priority}` : ''}`
          : 'No: only when asked'}
      </Fact>
      <Fact label="Last used">
        <span title={connection.lastUsed ? new Date(connection.lastUsed).toLocaleString() : undefined}>
          {lastUsedText(connection.lastUsed, now).replace(/^Used (on )?/, '').replace(/^Never used$/, 'Never')}
        </span>
      </Fact>
      {connection.file && (
        <Fact label="File">
          <span className="net-fact-line">{connection.file}</span>
          {note && <span className="net-fact-line net-muted">{note}</span>}
        </Fact>
      )}
      <Fact label="UUID">
        <span className="net-mono">{connection.uuid}</span>
      </Fact>
    </dl>
  );
}

function ConnectionActions({ connection, actions }: { connection: NetworkConnection; actions: Actions }) {
  if (actions.readOnly || connection.external) {
    return null;
  }
  const hotspot = connection.kind === 'hotspot';
  const editable = connection.kind === 'wifi' || hotspot || connection.kind === 'ethernet';
  const readOnly = connection.readOnly ? 'NetworkManager has it read-only' : null;
  return (
    <>
      {connection.activeState ? (
        <Button label={hotspot ? 'Stop' : 'Disconnect'} actions={actions} onClick={() => actions.disconnect(connection)} />
      ) : (
        <Button label={hotspot ? 'Start' : 'Connect'} primary actions={actions} onClick={() => actions.connect(connection, null)} />
      )}
      {editable && <Button label="Edit…" actions={actions} disabled={readOnly} onClick={() => actions.edit(connection)} />}
      {(connection.kind === 'wifi' || hotspot) && (
        <Button label="Share…" actions={actions} onClick={() => actions.share(connection)} />
      )}
      <Button label="Forget…" danger actions={actions} disabled={readOnly} onClick={() => actions.forget(connection)} />
    </>
  );
}

function ConnectionDetails({
  state,
  connection,
  actions,
  now,
  onClose,
}: {
  state: PageState;
  connection: NetworkConnection;
  actions: Actions;
  now: number;
  onClose: () => void;
}) {
  const { failed } = activityFor(state.activity, { uuid: connection.uuid }, now);
  return (
    <Pane
      icon={<KindIcon kind={connection.kind} size={16} />}
      name={connection.name}
      onClose={onClose}
      footer={<ConnectionActions connection={connection} actions={actions} />}
    >
      {failed && <p className="net-error">{`${failed.label}: ${failed.error}`}</p>}
      {connection.external && (
        <p className="net-muted">
          NetworkManager made it for an interface another program configures (docker, a VPN client…): it is not
          changed here.
        </p>
      )}
      <ConnectionFacts state={state} connection={connection} now={now} />
    </Pane>
  );
}

function NetworkDetails({
  state,
  network,
  actions,
  now,
  onClose,
}: {
  state: PageState;
  network: WifiNetwork;
  actions: Actions;
  now: number;
  onClose: () => void;
}) {
  const saved = savedFor(state.connections, network.ssid, network.device);
  const { failed } = activityFor(state.activity, { uuid: saved?.uuid ?? null, ssid: network.ssid, device: network.device }, now);
  const footer = saved ? (
    <ConnectionActions connection={saved} actions={actions} />
  ) : actions.readOnly ? null : (
    <Button label="Join…" primary actions={actions} onClick={() => actions.join(network)} />
  );
  return (
    <Pane icon={<SignalIcon signal={network.signal} size={16} />} name={network.ssid} onClose={onClose} footer={footer}>
      {failed && <p className="net-error">{`${failed.label}: ${failed.error}`}</p>}
      <dl className="net-facts">
        <Fact label="Signal">{network.signal}%</Fact>
        <Fact label="Security">
          {SECURITY_LABELS[network.security]}
          {network.securityText && ` (${network.securityText})`}
        </Fact>
        <Fact label="Band">
          {bandOf(network.frequency)}, channel {network.channel} ({network.frequency} MHz)
        </Fact>
        {network.rate && <Fact label="Rate">{network.rate}</Fact>}
        <Fact label="Access point">
          <span className="net-mono">{network.bssid}</span>
          {network.points > 1 && <span className="net-fact-line net-muted">The strongest of {network.points}</span>}
        </Fact>
        {network.mode !== 'Infra' && <Fact label="Mode">{network.mode}</Fact>}
        <Fact label="Seen by">{network.device}</Fact>
      </dl>
      {saved && (
        <>
          <h3>Saved as {saved.name}</h3>
          <ConnectionFacts state={state} connection={saved} now={now} signal={false} />
        </>
      )}
    </Pane>
  );
}

function DeviceDetails({
  state,
  device,
  actions,
  onClose,
}: {
  state: PageState;
  device: NetworkDevice;
  actions: Actions;
  onClose: () => void;
}) {
  const status = deviceStatus(device, state.wifi);
  const active = device.connection ? state.connections.find((c) => c.uuid === device.connection) : undefined;
  // What it may connect with: the connections saved for it, not active
  const kind = device.type === 'wifi' ? 'wifi' : device.type === 'ethernet' ? 'ethernet' : null;
  const others = kind
    ? state.connections.filter(
        (c) =>
          !c.activeState &&
          (c.kind === kind || (kind === 'wifi' && c.kind === 'hotspot')) &&
          forDevices(c, [device]) &&
          (c.kind !== 'wifi' || state.networks.some((n) => n.device === device.name && n.ssid === c.ssid)),
      )
    : [];
  const capabilities = [device.band24 && '2.4 GHz', device.band5 && '5 GHz'].filter(Boolean).join(' and ');
  return (
    <Pane
      icon={<DeviceIcon device={device} size={16} />}
      name={device.name}
      onClose={onClose}
      footer={
        active && !device.external && !actions.readOnly ? (
          <Button
            label={active.kind === 'hotspot' ? 'Stop the access point' : 'Disconnect'}
            actions={actions}
            onClick={() => actions.disconnect(active)}
          />
        ) : null
      }
    >
      <dl className="net-facts">
        <Fact label="Status">
          <Dot tone={status.tone} /> {status.text}
        </Fact>
        {device.reason && device.state !== DEVICE_ACTIVATED && <Fact label="Why">{device.reason}</Fact>}
        <Fact label="Kind">{deviceKindLabel(device)}</Fact>
        {(device.vendor || device.product) && (
          <Fact label="Hardware">{[device.vendor, device.product].filter(Boolean).join(' ')}</Fact>
        )}
        {device.driver && <Fact label="Driver">{device.driver}</Fact>}
        {device.hwaddr && (
          <Fact label="MAC address">
            <span className="net-mono">{device.hwaddr}</span>
          </Fact>
        )}
        {device.speed && <Fact label="Speed">{device.speed}</Fact>}
        {device.mtu && <Fact label="MTU">{device.mtu}</Fact>}
        {device.type === 'wifi' && (
          <Fact label="Access point">{device.accessPoint ? `It can be one${capabilities ? `, on ${capabilities}` : ''}` : 'Not supported'}</Fact>
        )}
        <Fact label="IPv4">
          <Addresses list={device.ipv4} />
        </Fact>
        {device.ipv6.length > 0 && (
          <Fact label="IPv6">
            <Addresses list={device.ipv6} />
          </Fact>
        )}
        {device.gateway && <Fact label="Gateway">{device.gateway}</Fact>}
        {device.dns.length > 0 && (
          <Fact label="DNS">
            <Addresses list={device.dns} />
          </Fact>
        )}
      </dl>
      {others.length > 0 && !actions.readOnly && !device.external && (
        <>
          <h3>Connect with</h3>
          <ul className="net-choices">
            {others.map((connection) => (
              <li key={connection.uuid}>
                <KindIcon kind={connection.kind} size={15} />
                <span className="net-choice-name">{connection.name}</span>
                <Button
                  label={connection.kind === 'hotspot' ? 'Start' : 'Connect'}
                  actions={actions}
                  onClick={() => actions.connect(connection, device.name)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Pane>
  );
}

export function Details({
  selection,
  state,
  actions,
  now,
  onClose,
}: {
  selection: Selection;
  state: PageState;
  actions: Actions;
  now: number;
  onClose: () => void;
}) {
  switch (selection.type) {
    case 'network': {
      const network = state.networks.find((n) => n.device === selection.device && n.ssid === selection.ssid);
      return network ? <NetworkDetails state={state} network={network} actions={actions} now={now} onClose={onClose} /> : null;
    }
    case 'connection': {
      const connection = state.connections.find((c) => c.uuid === selection.uuid);
      return connection ? (
        <ConnectionDetails state={state} connection={connection} actions={actions} now={now} onClose={onClose} />
      ) : null;
    }
    case 'device': {
      const device = state.devices.find((d) => d.name === selection.name);
      return device ? <DeviceDetails state={state} device={device} actions={actions} onClose={onClose} /> : null;
    }
  }
}
