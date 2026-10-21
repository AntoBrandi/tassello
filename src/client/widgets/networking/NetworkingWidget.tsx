// The robot's networks, as NetworkManager has them, as a phone's settings
// show them: the Wi-Fi networks in range, joined with their password; the
// connections saved, connected to and disconnected from, edited (their
// addresses: DHCP or static), forgotten; the robot as an access point, its
// network shared by a QR code; and the interfaces, their addresses and how
// they are doing. A widget can be for some interfaces only (wlan0, eth*).
//
// The server follows NetworkManager for every page (see
// src/server/networking.ts), and says through which interface each page
// reaches the robot: the widget warns before a change that would cut it off.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import {
  needsPassword,
  WRONG_PASSWORD,
  type EditableKind,
  type NetworkConnection,
  type NetworkRequest,
  type WifiNetwork,
} from '../../../shared/networking.ts';
import { connection as robot } from '../../connection.ts';
import { useDialogs } from '../../dialogs.tsx';
import {
  BookmarkIcon,
  NetworkIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  WifiIcon,
  WifiOffIcon,
} from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { ContextMenu, type MenuItem } from '../file_manager/parts.tsx';
import { errorMessage } from '../file_manager/folders.ts';
import { defineWidget, type WidgetProps } from '../types.ts';
import {
  changeBlocked,
  cutsOff,
  interfaceFilter,
  joinSettings,
  savedGroups,
  shownDevices,
  summary,
  type PageState,
  type View,
} from './model.ts';
import { act, NetworkDialog, type DialogRequest } from './NetworkDialogs.tsx';
import { Details } from './NetworkDetails.tsx';
import { DevicesView, SavedView, WifiView, type Actions, type Selection } from './NetworkViews.tsx';
import { Dot } from './parts.tsx';

interface NetworkingConfig {
  view: View;
  interfaces: string;
  allInterfaces: boolean;
  confirm: boolean;
  readOnly: boolean;
}

// Wider than this, the details are beside the list, else under it
const DETAILS_BESIDE_PX = 620;
// Shorter than this, the details take the place of the list
const SHORT_PX = 300;

const VIEWS: { view: View; label: string; title: string; Icon: typeof WifiIcon }[] = [
  { view: 'wifi', label: 'Wi-Fi', title: 'The Wi-Fi networks in range', Icon: WifiIcon },
  { view: 'saved', label: 'Saved', title: 'The connections saved', Icon: BookmarkIcon },
  { view: 'devices', label: 'Interfaces', title: 'The interfaces, their addresses', Icon: NetworkIcon },
];

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => robot.serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(robot.serverNow()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

function NetworkingWidget({ config }: WidgetProps<NetworkingConfig>) {
  const dialogs = useDialogs();
  const [state, setState] = useState<PageState | null>(null);
  const [view, setView] = useState<View>(config.view);
  const [text, setText] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useNow(5000);

  useEffect(() => setView(config.view), [config.view]);
  useEffect(() => robot.subscribeNetwork(setState), []);

  // Measured once shown: the first update makes it
  const ready = state !== null;
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
  }, [ready]);

  const filter = useMemo(() => interfaceFilter(config.interfaces), [config.interfaces]);
  const devices = useMemo(
    () => (state ? shownDevices(state.devices, filter, config.allInterfaces) : []),
    [state, filter, config.allInterfaces],
  );
  const hasWifi = devices.some((device) => device.type === 'wifi');
  const shownView: View = view === 'wifi' && !hasWifi && state && devices.length > 0 ? 'saved' : view;

  const blocked = state ? changeBlocked(state, config.readOnly) : null;

  // Runs the request, says how it went; resolves with its error, if any
  const run = (request: Exclude<NetworkRequest, { action: 'secrets' }>, done: string | null): Promise<string | null> =>
    act(request, done, state ? cutsOff(state, request) !== null : false).then(
      () => null,
      (e: unknown) => errorMessage(e),
    );

  // Asks first if the change cuts the page off, and always if ask.always
  const confirmed = async (
    request: NetworkRequest,
    ask: { title: string; confirmLabel: string; message?: string; danger?: boolean; always: boolean },
  ): Promise<boolean> => {
    const risk = state ? cutsOff(state, request) : null;
    if (!risk && !ask.always) {
      return true;
    }
    return dialogs.confirm({
      title: ask.title,
      message: (
        <>
          {ask.message}
          {risk && <p className="net-warning">{risk}</p>}
        </>
      ),
      confirmLabel: ask.confirmLabel,
      danger: risk !== null || ask.danger,
    });
  };

  const nameOf = (connection: NetworkConnection) =>
    connection.kind === 'wifi' && connection.ssid ? connection.ssid : connection.name;

  const actions: Actions = {
    blocked,
    readOnly: config.readOnly,
    connect: async (connection, device) => {
      const request: NetworkRequest = { action: 'connect', uuid: connection.uuid, device, password: null };
      const hotspot = connection.kind === 'hotspot';
      const ask = {
        title: hotspot ? `Start ${connection.name}?` : `Switch to ${nameOf(connection)}?`,
        confirmLabel: hotspot ? 'Start' : 'Switch',
        always: false,
      };
      if (!(await confirmed(request, ask))) {
        return;
      }
      const error = await run(request, hotspot ? `The access point ${nameOf(connection)} is on` : `Connected to ${nameOf(connection)}`);
      if (!error) {
        return;
      }
      // A password changed meanwhile, or mistyped when saved
      if (error === WRONG_PASSWORD && connection.security && needsPassword(connection.security)) {
        setDialog({ kind: 'password', connection, device, error });
      } else {
        notify(`Could not ${hotspot ? 'start' : 'connect to'} ${nameOf(connection)}: ${error}`, 'error');
      }
    },
    disconnect: async (connection) => {
      const request: NetworkRequest = { action: 'disconnect', uuid: connection.uuid };
      const hotspot = connection.kind === 'hotspot';
      const ask = {
        title: hotspot ? `Stop ${connection.name}?` : `Disconnect from ${nameOf(connection)}?`,
        message: hotspot
          ? 'Whoever joined the robot’s network loses it.'
          : connection.autoconnect
            ? 'It does not connect by itself again until asked, or until the robot restarts.'
            : 'It stays saved.',
        confirmLabel: hotspot ? 'Stop' : 'Disconnect',
        danger: true,
        always: config.confirm,
      };
      if (!(await confirmed(request, ask))) {
        return;
      }
      const error = await run(request, null);
      if (error) {
        notify(`Could not ${hotspot ? 'stop' : 'disconnect from'} ${nameOf(connection)}: ${error}`, 'error');
      }
    },
    forget: async (connection) => {
      const request: NetworkRequest = { action: 'delete', uuid: connection.uuid };
      const ask = {
        title: `Forget ${connection.name}?`,
        message:
          connection.kind === 'wifi'
            ? 'Its password is deleted with it: joining the network again asks for it.'
            : 'Its settings are deleted with it.',
        confirmLabel: 'Forget',
        danger: true,
        always: true,
      };
      if (!(await confirmed(request, ask))) {
        return;
      }
      if (selection?.type === 'connection' && selection.uuid === connection.uuid) {
        setSelection(null);
      }
      const error = await run(request, `Forgot ${connection.name}`);
      if (error) {
        notify(`Could not forget ${connection.name}: ${error}`, 'error');
      }
    },
    join: async (network: WifiNetwork) => {
      if (needsPassword(network.security)) {
        setDialog({ kind: 'join', network });
        return;
      }
      const request: NetworkRequest = {
        action: 'create',
        settings: joinSettings(network, null, '', true, false, state?.connections ?? []),
        connect: true,
        device: network.device,
      };
      const ask = {
        title: `Join ${network.ssid}?`,
        message:
          network.security === 'open'
            ? 'It is open: others on it may see what the robot sends.'
            : 'It is open, its traffic encrypted (OWE).',
        confirmLabel: 'Join',
        always: network.security === 'open',
      };
      if (!(await confirmed(request, ask))) {
        return;
      }
      const error = await run(request, `Connected to ${network.ssid}`);
      if (error) {
        notify(`Could not join ${network.ssid}: ${error}`, 'error');
      }
    },
    create: (kind: EditableKind, device) => setDialog({ kind: 'create', settings: kind, device }),
    edit: (connection) => setDialog({ kind: 'edit', connection }),
    share: (connection) => setDialog({ kind: 'share', connection }),
    setWifi: async (enabled) => {
      const request: NetworkRequest = { action: 'wifi', enabled };
      const ask = {
        title: enabled ? 'Turn Wi-Fi on?' : 'Turn Wi-Fi off?',
        message: enabled ? '' : 'Every Wi-Fi interface disconnects, access points stop.',
        confirmLabel: enabled ? 'Turn on' : 'Turn off',
        danger: !enabled,
        always: !enabled && config.confirm,
      };
      if (!(await confirmed(request, ask))) {
        return;
      }
      const error = await run(request, null);
      if (error) {
        notify(`Could not turn Wi-Fi ${enabled ? 'on' : 'off'}: ${error}`, 'error');
      }
    },
  };

  const rescan = () =>
    void robot.networkAction({ action: 'rescan', device: null }).catch((e: unknown) => notify(`Could not scan: ${errorMessage(e)}`, 'error'));

  const openAdd = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const wifi = devices.filter((d) => d.type === 'wifi');
    const why = blocked;
    setMenu({
      x: box.right - 200,
      y: box.bottom + 4,
      items: [
        {
          label: 'Join a hidden network…',
          disabled: why !== null || wifi.length === 0 || !state?.wifi,
          run: () => actions.create('wifi', null),
        },
        {
          label: 'New access point…',
          disabled: why !== null || !wifi.some((d) => d.accessPoint) || !state?.wifi,
          run: () => actions.create('hotspot', null),
        },
        {
          label: 'New wired connection…',
          disabled: why !== null,
          run: () => actions.create('ethernet', null),
        },
      ],
    });
  };

  // What is selected may go: a network out of range, a connection forgotten
  useEffect(() => {
    if (!state || !selection) {
      return;
    }
    const known =
      selection.type === 'network'
        ? state.networks.some((n) => n.device === selection.device && n.ssid === selection.ssid)
        : selection.type === 'connection'
          ? state.connections.some((c) => c.uuid === selection.uuid)
          : state.devices.some((d) => d.name === selection.name);
    if (!known) {
      setSelection(null);
    }
  }, [state, selection]);

  if (!state) {
    return <div className="widget-message">Reading the networks…</div>;
  }

  const counts: Record<View, number> = {
    wifi: state.networks.filter((n) => devices.some((d) => d.name === n.device)).length,
    saved: savedGroups(state.connections, devices, '', config.allInterfaces).reduce((sum, g) => sum + g.connections.length, 0),
    devices: devices.length,
  };
  const props = {
    state,
    devices,
    text,
    all: config.allInterfaces,
    selection,
    onSelect: (next: Selection) =>
      setSelection((current) => (JSON.stringify(current) === JSON.stringify(next) ? null : next)),
    actions,
    now,
  };
  const line = summary(state, now);
  const { width, height } = size;
  const beside = width >= DETAILS_BESIDE_PX;
  const details = selection && (
    <Details selection={selection} state={state} actions={actions} now={now} onClose={() => setSelection(null)} />
  );

  let content;
  if (state.error) {
    content = <p className="net-note error">{state.error}</p>;
  } else if (shownView === 'wifi') {
    content = <WifiView {...props} />;
  } else if (shownView === 'saved') {
    content = <SavedView {...props} />;
  } else {
    content = <DevicesView {...props} />;
  }

  // The networks are not the page's, or not the server's user's, to change
  const banner =
    !config.readOnly && !state.error && blocked ? (
      <p className="net-banner" role="note">
        {blocked}
      </p>
    ) : null;

  return (
    <div
      ref={rootRef}
      className={`net${details && !beside && height > 0 && height < SHORT_PX ? ' cramped' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selection) {
          setSelection(null);
        }
      }}
    >
      <div className="net-toolbar" role="toolbar" aria-label="Networking">
        <div className="net-views" role="group" aria-label="View">
          {VIEWS.filter(({ view: v }) => v !== 'wifi' || hasWifi).map(({ view: v, label, title, Icon }) => (
            <button
              key={v}
              type="button"
              className="net-view"
              aria-pressed={shownView === v}
              title={title}
              onClick={() => {
                setView(v);
                setSelection(null);
              }}
            >
              <Icon width={14} height={14} />
              <span className="net-view-name">{label}</span>
              <span className="net-view-count">{counts[v]}</span>
            </button>
          ))}
        </div>
        {shownView !== 'devices' && (
          <label className="net-search" title="Only those whose name contains">
            <SearchIcon width={14} height={14} />
            <input
              type="search"
              value={text}
              placeholder="Filter…"
              aria-label="Only those whose name contains"
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        <div className="net-tools">
          {shownView === 'wifi' && (
            <button
              type="button"
              className={`overlay-button${state.scanning ? ' net-spinning' : ''}`}
              title={state.scanning ? 'Looking for networks…' : 'Look for networks again'}
              aria-label="Look for networks again"
              disabled={!state.wifi || state.scanning || state.error !== null}
              onClick={rescan}
            >
              <RefreshIcon width={17} height={17} />
            </button>
          )}
          {hasWifi && !config.readOnly && (
            <button
              type="button"
              className="overlay-button"
              aria-pressed={state.wifi}
              title={
                !state.wifiHardware
                  ? 'Wi-Fi is off by its hardware switch'
                  : (blocked ?? (state.wifi ? 'Wi-Fi is on: turn it off' : 'Wi-Fi is off: turn it on'))
              }
              aria-label={state.wifi ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on'}
              disabled={blocked !== null || !state.wifiHardware || state.error !== null}
              onClick={() => actions.setWifi(!state.wifi)}
            >
              {state.wifi ? <WifiIcon width={17} height={17} /> : <WifiOffIcon width={17} height={17} />}
            </button>
          )}
          {!config.readOnly && (
            <>
              <span className="overlay-separator" />
              <button
                type="button"
                className="overlay-button"
                title={blocked ?? 'A new connection: a hidden network, an access point, a cable’s'}
                aria-label="New connection"
                aria-haspopup="menu"
                disabled={blocked !== null || state.error !== null}
                onClick={openAdd}
              >
                <PlusIcon width={17} height={17} />
              </button>
            </>
          )}
        </div>
      </div>
      {banner}
      <div className={`net-body${beside ? ' beside' : ''}`}>
        <div className="net-main">{content}</div>
        {details}
      </div>
      <div className={`net-status ${line.tone}`} title={line.text}>
        <Dot tone={line.tone} />
        <span className="net-status-text">{line.text}</span>
      </div>
      {dialog && <NetworkDialog request={dialog} state={state} onClose={() => setDialog(null)} />}
      {menu && <ContextMenu x={Math.max(4, menu.x)} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

export const networkingWidget = defineWidget<NetworkingConfig>({
  type: 'networking',
  name: 'Networking',
  description: 'The robot’s networks: join Wi-Fi networks, switch between those saved, set addresses, make it an access point.',
  icon: NetworkIcon,
  defaultSize: { w: 6, h: 7 },
  minSize: { w: 3, h: 3 },
  component: NetworkingWidget,
  properties: [
    {
      key: 'view',
      label: 'View',
      kind: 'select',
      default: 'wifi',
      options: [
        { value: 'wifi', label: 'Wi-Fi networks in range' },
        { value: 'saved', label: 'Saved connections' },
        { value: 'devices', label: 'Interfaces' },
      ],
      help: 'When the panel opens: its toolbar changes it',
    },
    {
      key: 'interfaces',
      label: 'Interfaces',
      kind: 'string',
      default: '',
      placeholder: 'wlan0, eth*',
      help: 'Only these, and their connections: names or globs (*), separated by commas. All if empty',
    },
    {
      key: 'allInterfaces',
      label: 'Show every interface',
      kind: 'boolean',
      default: false,
      help: 'Also those other programs configure (docker’s bridges, VPN clients’ tunnels), the loopback, Wi-Fi P2P',
    },
    {
      key: 'confirm',
      label: 'Ask before disconnecting',
      kind: 'boolean',
      default: true,
      help: 'And before turning Wi-Fi off. A change that would cut this page off from the robot is always asked about',
    },
    {
      key: 'readOnly',
      label: 'Read-only',
      kind: 'boolean',
      default: false,
      help: 'The networks are shown, not changed: e.g. on a panel for operators',
    },
  ],
});
