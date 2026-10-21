// The Networking widget's views: the Wi-Fi networks in range of each Wi-Fi
// interface (and the robot's access points), the connections saved, by
// kind, and the interfaces. A row says how it is doing and has its main
// action; clicked, it shows its details.

import type { ReactNode } from 'react';

import {
  DEVICE_ACTIVATED,
  type EditableKind,
  type NetworkConnection,
  type NetworkDevice,
  type WifiNetwork,
} from '../../../shared/networking.ts';
import { HotspotIcon, LockIcon, PlusIcon, WifiOffIcon } from '../../icons.tsx';
import {
  activityFor,
  bandOf,
  deviceKindLabel,
  deviceStatus,
  hotspotsFor,
  lastUsedText,
  networkRows,
  savedGroups,
  type PageState,
  type Tone,
} from './model.ts';
import { DeviceIcon, Dot, KindIcon, SignalIcon } from './parts.tsx';

export type Selection =
  | { type: 'network'; device: string; ssid: string }
  | { type: 'connection'; uuid: string }
  | { type: 'device'; name: string };

export interface Actions {
  // Why the page may not change the networks; null if it may
  blocked: string | null;
  // The widget only shows them
  readOnly: boolean;
  connect: (connection: NetworkConnection, device: string | null) => void;
  disconnect: (connection: NetworkConnection) => void;
  forget: (connection: NetworkConnection) => void;
  // A network in range, not saved
  join: (network: WifiNetwork) => void;
  create: (kind: EditableKind, device: string | null) => void;
  edit: (connection: NetworkConnection) => void;
  share: (connection: NetworkConnection) => void;
  setWifi: (enabled: boolean) => void;
}

export interface ViewProps {
  state: PageState;
  // Those the widget shows
  devices: NetworkDevice[];
  text: string;
  all: boolean;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  actions: Actions;
  now: number;
}

function isSelected(selection: Selection | null, wanted: Selection): boolean {
  return JSON.stringify(selection) === JSON.stringify(wanted);
}

export function ActionButton({
  label,
  busy,
  primary = false,
  actions,
  onClick,
}: {
  label: string;
  busy?: string | null;
  primary?: boolean;
  actions: Actions;
  onClick: () => void;
}) {
  if (actions.readOnly) {
    return null;
  }
  return (
    <button
      type="button"
      className={`net-action${primary ? ' primary' : ''}`}
      disabled={!!busy || actions.blocked !== null}
      title={actions.blocked ?? undefined}
      onClick={onClick}
    >
      {busy ?? label}
    </button>
  );
}

function Row({
  selected,
  icon,
  name,
  tags,
  sub,
  tone,
  action,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  name: string;
  tags?: ReactNode;
  sub: string;
  tone: Tone | '';
  action?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <li className={`net-row${selected ? ' selected' : ''}`}>
      <button type="button" className="net-row-main" aria-pressed={selected} onClick={onSelect}>
        <span className={`net-row-icon ${tone}`}>{icon}</span>
        <span className="net-row-text">
          <span className="net-row-name">
            <span className="net-row-label" title={name}>
              {name}
            </span>
            {tags}
          </span>
          <span className={`net-row-sub ${tone}`} title={sub}>
            {(tone === 'busy' || tone === 'failed') && <Dot tone={tone} />}
            <span className="net-row-sub-text">{sub}</span>
          </span>
        </span>
      </button>
      {action && <div className="net-row-actions">{action}</div>}
    </li>
  );
}

function ViaTag({ state, device }: { state: PageState; device: string | null }) {
  return device && device === state.via ? (
    <span className="net-tag accent" title="This page reaches the robot through it">
      this page
    </span>
  ) : null;
}

function address(device: NetworkDevice | undefined): string {
  return device?.ipv4[0]?.split('/')[0] ?? '';
}

export function ConnectionRow({ connection, ...props }: ViewProps & { connection: NetworkConnection }) {
  const { state, actions, selection, onSelect, now } = props;
  const device = state.devices.find((d) => d.name === connection.device);
  const { running, failed } = activityFor(
    state.activity,
    { uuid: connection.uuid, ssid: connection.ssid || null, device: connection.device },
    now,
  );
  const hotspot = connection.kind === 'hotspot';
  let sub: string;
  let tone: Tone | '' = '';
  if (running) {
    sub = `${running.label}…`;
    tone = 'busy';
  } else if (connection.activeState === 'activated') {
    sub = [hotspot ? `On, on ${connection.device}` : `Connected on ${connection.device}`, address(device)]
      .filter(Boolean)
      .join(' · ');
    tone = 'on';
  } else if (connection.activeState === 'activating') {
    sub = device ? deviceStatus(device, state.wifi).text : 'Connecting…';
    tone = 'busy';
  } else if (connection.activeState === 'deactivating') {
    sub = 'Disconnecting…';
    tone = 'busy';
  } else if (failed) {
    sub = failed.error ?? '';
    tone = 'failed';
  } else {
    const detail =
      connection.kind === 'ethernet' && connection.ipv4Method === 'manual'
        ? connection.addresses.join(', ')
        : hotspot && connection.ssid !== connection.name
          ? connection.ssid
          : '';
    sub = [detail, lastUsedText(connection.lastUsed, now), connection.autoconnect ? '' : 'not automatic']
      .filter(Boolean)
      .join(' · ');
  }
  const active = connection.activeState !== null;
  const wanted: Selection = { type: 'connection', uuid: connection.uuid };
  // Bound to an interface: worth saying if the robot has others of its kind
  const bound = state.devices.find((d) => d.name === connection.interface);
  const boundTag = bound && state.devices.filter((d) => d.type === bound.type).length > 1;
  return (
    <Row
      selected={isSelected(selection, wanted)}
      icon={<KindIcon kind={connection.kind} />}
      name={connection.name}
      tags={
        <>
          <ViaTag state={state} device={connection.device} />
          {boundTag && <span className="net-tag">{connection.interface}</span>}
        </>
      }
      sub={sub}
      tone={tone}
      onSelect={() => onSelect(wanted)}
      action={
        connection.external ? null : active ? (
          <ActionButton
            label={hotspot ? 'Stop' : 'Disconnect'}
            busy={running ? '…' : null}
            actions={actions}
            onClick={() => actions.disconnect(connection)}
          />
        ) : (
          <ActionButton
            label={hotspot ? 'Start' : 'Connect'}
            busy={running ? '…' : null}
            primary
            actions={actions}
            onClick={() => actions.connect(connection, null)}
          />
        )
      }
    />
  );
}

function NetworkRow({
  network,
  saved,
  device,
  ...props
}: ViewProps & { network: WifiNetwork; saved: NetworkConnection | null; device: NetworkDevice }) {
  const { state, actions, selection, onSelect, now } = props;
  const { running, failed } = activityFor(
    state.activity,
    { uuid: saved?.uuid ?? null, ssid: network.ssid, device: device.name },
    now,
  );
  const active = network.active && device.connection !== null;
  const activeConnection = active ? state.connections.find((c) => c.uuid === device.connection) : undefined;
  const band = bandOf(network.frequency);
  let sub: string;
  let tone: Tone | '' = '';
  if (running) {
    sub = `${running.label}…`;
    tone = 'busy';
  } else if (active) {
    const status = deviceStatus(device, state.wifi);
    sub = device.state === DEVICE_ACTIVATED ? ['Connected', address(device), band].filter(Boolean).join(' · ') : status.text;
    tone = status.tone;
  } else if (failed) {
    sub = failed.error ?? '';
    tone = 'failed';
  } else {
    sub = [saved ? 'Saved' : '', network.securityText || 'Open', band].filter(Boolean).join(' · ');
  }
  const wanted: Selection = { type: 'network', device: device.name, ssid: network.ssid };
  let action: ReactNode;
  if (active && activeConnection) {
    action = (
      <ActionButton label="Disconnect" actions={actions} onClick={() => actions.disconnect(activeConnection)} />
    );
  } else if (!active) {
    action = (
      <ActionButton
        label={saved ? 'Connect' : 'Join'}
        busy={running ? '…' : null}
        primary
        actions={actions}
        onClick={() => (saved ? actions.connect(saved, device.name) : actions.join(network))}
      />
    );
  }
  return (
    <Row
      selected={isSelected(selection, wanted)}
      icon={<SignalIcon signal={network.signal} />}
      name={network.ssid}
      tags={
        <>
          {network.security !== 'open' && network.security !== 'owe' && (
            <LockIcon className="net-lock" width={12} height={12} />
          )}
          {active && <ViaTag state={state} device={device.name} />}
        </>
      }
      sub={sub}
      tone={active && tone === '' ? 'on' : tone}
      action={action}
      onSelect={() => onSelect(wanted)}
    />
  );
}

function AddRow({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: string | null; onClick: () => void }) {
  return (
    <li className="net-row">
      <button type="button" className="net-row-main net-add" disabled={disabled !== null} title={disabled ?? undefined} onClick={onClick}>
        <span className="net-row-icon">{icon}</span>
        <span className="net-row-label">{label}</span>
      </button>
    </li>
  );
}

function WifiDevice({ device, many, ...props }: ViewProps & { device: NetworkDevice; many: boolean }) {
  const { state, text, actions } = props;
  const active = state.connections.find((c) => c.device === device.name && (c.kind === 'wifi' || c.kind === 'hotspot'));
  const rows = networkRows(state, device.name, text);
  // Connected to a network the scan does not list (hidden, or not scanned yet)
  const unlisted = active?.kind === 'wifi' && !rows.some((row) => row.network.active) ? active : null;
  const hotspots = device.accessPoint ? hotspotsFor(state.connections, device.name).filter((c) => c.uuid !== active?.uuid) : [];
  let empty: string | null = null;
  if (rows.length === 0) {
    if (text.trim()) {
      empty = `No network matches “${text.trim()}”`;
    } else if (active?.kind === 'hotspot') {
      empty = 'An access point does not look for networks: stop it to join one';
    } else {
      empty = state.scanning ? 'Looking for networks…' : 'No network in range';
    }
  }
  const disabled = actions.blocked;
  return (
    <section className="net-section" aria-label={`Wi-Fi of ${device.name}`}>
      {many && (
        <h3 className="net-heading">
          {device.name}
          {(device.product || device.vendor) && <span className="net-heading-detail">{device.product || device.vendor}</span>}
        </h3>
      )}
      <ul className="net-list">
        {active?.kind === 'hotspot' && <ConnectionRow {...props} connection={active} />}
        {unlisted && <ConnectionRow {...props} connection={unlisted} />}
        {rows.map((row) => (
          <NetworkRow key={row.network.ssid} {...props} network={row.network} saved={row.saved} device={device} />
        ))}
      </ul>
      {empty && <p className="net-note">{empty}</p>}
      {!text.trim() && (
        <ul className="net-list net-extra">
          {hotspots.map((connection) => (
            <ConnectionRow key={connection.uuid} {...props} connection={connection} />
          ))}
          {!actions.readOnly && (
            <>
              <AddRow
                icon={<PlusIcon width={16} height={16} />}
                label="Join a hidden network…"
                disabled={disabled}
                onClick={() => actions.create('wifi', device.name)}
              />
              {device.accessPoint && (
                <AddRow
                  icon={<HotspotIcon width={16} height={16} />}
                  label="New access point…"
                  disabled={disabled}
                  onClick={() => actions.create('hotspot', device.name)}
                />
              )}
            </>
          )}
        </ul>
      )}
    </section>
  );
}

export function WifiView(props: ViewProps) {
  const { state, devices, actions } = props;
  const wifi = devices.filter((device) => device.type === 'wifi');
  if (!state.wifi) {
    return (
      <div className="net-empty">
        <WifiOffIcon width={28} height={28} />
        <p>{state.wifiHardware ? 'Wi-Fi is off' : 'Wi-Fi is off by its hardware switch'}</p>
        {state.wifiHardware && !actions.readOnly && (
          <button
            type="button"
            className="button primary"
            disabled={actions.blocked !== null}
            title={actions.blocked ?? undefined}
            onClick={() => actions.setWifi(true)}
          >
            Turn Wi-Fi on
          </button>
        )}
      </div>
    );
  }
  if (wifi.length === 0) {
    return (
      <div className="net-empty">
        <WifiOffIcon width={28} height={28} />
        <p>No Wi-Fi interface</p>
      </div>
    );
  }
  return (
    <div className="net-scroll">
      {wifi.map((device) => (
        <WifiDevice key={device.name} {...props} device={device} many={wifi.length > 1} />
      ))}
    </div>
  );
}

export function SavedView(props: ViewProps) {
  const { state, devices, text, all, actions } = props;
  const groups = savedGroups(state.connections, devices, text, all);
  return (
    <div className="net-scroll">
      {groups.length === 0 && (
        <p className="net-note">{text.trim() ? `No connection matches “${text.trim()}”` : 'No connection saved'}</p>
      )}
      {groups.map((group) => (
        <section key={group.kind} className="net-section" aria-label={group.title}>
          <h3 className="net-heading">
            {group.title}
            <span className="net-heading-detail">{group.connections.length}</span>
          </h3>
          <ul className="net-list">
            {group.connections.map((connection) => (
              <ConnectionRow key={connection.uuid} {...props} connection={connection} />
            ))}
          </ul>
        </section>
      ))}
      {!text.trim() && !actions.readOnly && (
        <ul className="net-list net-extra">
          <AddRow
            icon={<PlusIcon width={16} height={16} />}
            label="New wired connection…"
            disabled={actions.blocked}
            onClick={() => actions.create('ethernet', null)}
          />
        </ul>
      )}
    </div>
  );
}

export function DevicesView(props: ViewProps) {
  const { state, devices, selection, onSelect, actions } = props;
  if (devices.length === 0) {
    return <p className="net-note">No interface</p>;
  }
  return (
    <div className="net-scroll">
      <ul className="net-list">
        {devices.map((device) => {
          const status = deviceStatus(device, state.wifi);
          const connection = device.connection ? state.connections.find((c) => c.uuid === device.connection) : undefined;
          const wanted: Selection = { type: 'device', name: device.name };
          return (
            <Row
              key={device.name}
              selected={isSelected(selection, wanted)}
              icon={<DeviceIcon device={device} />}
              name={device.name}
              tags={
                <>
                  <ViaTag state={state} device={device.name} />
                  <span className="net-row-detail">{device.product || device.vendor || deviceKindLabel(device)}</span>
                </>
              }
              sub={[status.text, address(device)].filter(Boolean).join(' · ')}
              tone={status.tone}
              onSelect={() => onSelect(wanted)}
              action={
                connection && !device.external && device.state === DEVICE_ACTIVATED ? (
                  <ActionButton
                    label={connection.kind === 'hotspot' ? 'Stop' : 'Disconnect'}
                    actions={actions}
                    onClick={() => actions.disconnect(connection)}
                  />
                ) : null
              }
            />
          );
        })}
      </ul>
    </div>
  );
}
