// The Networking widget's dialogs: the password of a network in range to
// join (or of a saved one, found wrong), a connection made or changed (a
// Wi-Fi network, an access point, a cable's: its addresses), and a network
// shared, its name and password and the QR code phones join it by.

import { useEffect, useState, type FormEvent } from 'react';

import {
  needsPassword,
  passwordProblem,
  SECURITY_LABELS,
  settingsOf,
  settingsProblems,
  splitList,
  defaultSettings,
  type EditableKind,
  type Ipv4Method,
  type NetworkConnection,
  type NetworkRequest,
  type NetworkSecrets,
  type NetworkSettings,
  type WifiNetwork,
  type WifiSecurity,
} from '../../../shared/networking.ts';
import { connection as robot } from '../../connection.ts';
import { Modal } from '../../dialogs.tsx';
import { CopyIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { copyText, errorMessage } from '../file_manager/folders.ts';
import { bandOf, cutsOff, joinSettings, uniqueName, type PageState } from './model.ts';
import { Field, PasswordInput, QrCode, randomPassword, SignalIcon, Toggle } from './parts.tsx';
import { wifiQrText } from './qr.ts';

export type DialogRequest =
  // A network in range, not saved
  | { kind: 'join'; network: WifiNetwork }
  // A saved one, whose password was found wrong
  | { kind: 'password'; connection: NetworkConnection; device: string | null; error: string }
  | { kind: 'create'; settings: EditableKind; device: string | null }
  | { kind: 'edit'; connection: NetworkConnection }
  | { kind: 'share'; connection: NetworkConnection };

// The page's connection to the robot was lost: what moving the robot to
// another network does
function lostRobot(error: unknown): boolean {
  return /Disconnected from the robot|No answer from the robot/.test(errorMessage(error));
}

// Runs the request and says how it went (done, or what NetworkManager adds);
// rejects with why not. The robot may take the page's network with it,
// risky: that is no failure.
export async function act(
  request: Exclude<NetworkRequest, { action: 'secrets' }>,
  done: string | null,
  risky: boolean,
): Promise<void> {
  try {
    const result = await robot.networkAction(request);
    if (result.message) {
      notify(result.message, 'error');
    } else if (done) {
      notify(done);
    }
  } catch (e) {
    if (risky && lostRobot(e)) {
      notify('This page lost the robot: it moved to another network, where it is to be reached now');
      return;
    }
    throw e;
  }
}

function Problems({ risk, error }: { risk: string | null; error: string | null }) {
  return (
    <>
      {risk && <p className="net-warning">{risk}</p>}
      {error && (
        <p className="net-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function JoinDialog({
  state,
  request,
  onClose,
}: {
  state: PageState;
  request: Extract<DialogRequest, { kind: 'join' | 'password' }>;
  onClose: () => void;
}) {
  const saved = request.kind === 'password' ? request.connection : null;
  const network =
    request.kind === 'join'
      ? request.network
      : state.networks.find((n) => n.ssid === saved!.ssid && (!request.device || n.device === request.device));
  const ssid = saved?.ssid || saved?.name || network?.ssid || '';
  const security: WifiSecurity = saved?.security ?? network?.security ?? 'wpa-psk';
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState(saved?.identity ?? '');
  const [autoconnect, setAutoconnect] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(request.kind === 'password' ? request.error : null);
  const enterprise = security === 'wpa-eap';
  const problem =
    passwordProblem(security, password) ?? (enterprise && !identity.trim() ? 'Your user name on the network' : null);

  const action: Exclude<NetworkRequest, { action: 'secrets' }> = saved
    ? { action: 'connect', uuid: saved.uuid, device: request.kind === 'password' ? request.device : null, password }
    : {
        action: 'create',
        settings: joinSettings(network!, password, identity.trim(), autoconnect, false, state.connections),
        connect: true,
        device: network!.device,
      };
  const risk = cutsOff(state, action);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (problem) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await act(action, `Connected to ${ssid}`, risk !== null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={saved ? `The password of ${ssid}` : `Join ${ssid}`} onClose={onClose}>
      <form className="modal-body" onSubmit={(e) => void submit(e)}>
        {network && (
          <p className="net-dialog-meta">
            <SignalIcon signal={network.signal} size={16} />
            {[SECURITY_LABELS[security], bandOf(network.frequency), `${network.signal}%`].filter(Boolean).join(' · ')}
          </p>
        )}
        {enterprise && (
          <Field label="User name" error={tried && !identity.trim() ? 'Your user name on the network' : null}>
            {(id) => (
              <input
                id={id}
                value={identity}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setIdentity(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field
          label="Password"
          error={tried ? passwordProblem(security, password) : null}
          help={enterprise ? 'PEAP with MSCHAPv2, the server’s certificate not checked' : undefined}
        >
          {(id) => <PasswordInput id={id} value={password} autoFocus={!enterprise} onChange={setPassword} />}
        </Field>
        {!saved && (
          <Toggle
            label="Connect automatically"
            help="Whenever the robot is in its range"
            checked={autoconnect}
            onChange={setAutoconnect}
          />
        )}
        <Problems risk={risk} error={error} />
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`button ${risk ? 'danger' : 'primary'}`} disabled={busy}>
            {busy ? 'Connecting…' : saved ? 'Connect' : 'Join'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const METHODS: Record<EditableKind, { value: Ipv4Method; label: string }[]> = {
  wifi: [
    { value: 'auto', label: 'Automatic (DHCP)' },
    { value: 'manual', label: 'Manual' },
    { value: 'disabled', label: 'Disabled' },
  ],
  hotspot: [{ value: 'shared', label: 'The robot gives them' }],
  ethernet: [
    { value: 'auto', label: 'Automatic (DHCP)' },
    { value: 'manual', label: 'Manual' },
    { value: 'shared', label: 'Shared: the robot gives them, and its internet' },
    { value: 'disabled', label: 'Disabled' },
  ],
};

// 20 MHz channels most countries allow access points on: not the 5 GHz ones
// radars may claim (DFS)
const CHANNELS = {
  bg: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  a: [36, 40, 44, 48, 149, 153, 157, 161, 165],
};

const CLIENT_SECURITIES: WifiSecurity[] = ['wpa-psk', 'sae', 'wpa-eap', 'open', 'owe', 'wep'];

function initialSettings(state: PageState, request: Extract<DialogRequest, { kind: 'create' | 'edit' }>): NetworkSettings {
  if (request.kind === 'edit') {
    return settingsOf(request.connection)!;
  }
  const kind = request.settings;
  const settings = defaultSettings(kind);
  if (kind === 'hotspot') {
    // An interface that can, the page's last
    const capable = state.devices.filter((d) => d.type === 'wifi' && d.accessPoint);
    const device =
      capable.find((d) => d.name === request.device) ?? capable.find((d) => d.name !== state.via) ?? capable[0];
    const ssid = (robot.hostname || 'robot').slice(0, 32);
    return {
      ...settings,
      interface: device?.name ?? '',
      ssid,
      name: uniqueName(ssid, state.connections),
      password: randomPassword(),
      autoconnect: false,
    };
  }
  if (kind === 'ethernet') {
    return { ...settings, interface: request.device ?? '', name: uniqueName('Wired connection', state.connections) };
  }
  return { ...settings, hidden: true, interface: request.device ?? '' };
}

function ConnectionDialog({
  state,
  request,
  onClose,
}: {
  state: PageState;
  request: Extract<DialogRequest, { kind: 'create' | 'edit' }>;
  onClose: () => void;
}) {
  const editing = request.kind === 'edit' ? request.connection : null;
  const [settings, setSettings] = useState(() => initialSettings(state, request));
  const [addresses, setAddresses] = useState(settings.addresses.join(', '));
  const [dns, setDns] = useState(settings.dns.join(', '));
  const [nameTouched, setNameTouched] = useState(editing !== null);
  const [connect, setConnect] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind } = settings;
  const wireless = kind !== 'ethernet';

  const set = (changes: Partial<NetworkSettings>) =>
    setSettings((current) => {
      const next = { ...current, ...changes };
      // The name follows the network's, until typed
      if (!nameTouched && changes.ssid !== undefined && next.ssid) {
        next.name = uniqueName(next.ssid, state.connections.filter((c) => c.uuid !== editing?.uuid));
      }
      return next;
    });

  const problems = settingsProblems(settings, !editing);
  if (
    editing &&
    wireless &&
    settings.security !== (editing.security ?? 'open') &&
    needsPassword(settings.security) &&
    settings.password === null
  ) {
    problems.password = 'The network’s password, for its new security';
  }
  const shown = (field: keyof NetworkSettings) => (tried ? (problems[field] ?? null) : null);

  const action: Exclude<NetworkRequest, { action: 'secrets' }> = editing
    ? { action: 'modify', uuid: editing.uuid, settings }
    : { action: 'create', settings, connect, device: null };
  const risk = cutsOff(state, action);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(problems).length > 0) {
      return;
    }
    setBusy(true);
    setError(null);
    let done = `Saved ${settings.name}`;
    if (!editing && connect) {
      done = kind === 'hotspot' ? `The access point ${settings.ssid} is on` : `Connected to ${settings.ssid || settings.name}`;
    }
    try {
      await act(action, done, risk !== null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const wifiDevices = state.devices.filter((d) => d.type === 'wifi' && (kind !== 'hotspot' || d.accessPoint));
  const cableDevices = state.devices.filter((d) => d.type === 'ethernet');
  const device = state.devices.find((d) => d.name === settings.interface);

  let title: string;
  if (editing) {
    title = `Edit ${editing.name}`;
  } else {
    title = kind === 'hotspot' ? 'New access point' : kind === 'ethernet' ? 'New wired connection' : 'Join a hidden network';
  }
  let submitLabel = 'Save';
  if (!editing && connect) {
    submitLabel = kind === 'hotspot' ? 'Start' : kind === 'wifi' ? 'Join' : 'Connect';
  }

  const interfaceField =
    kind === 'ethernet' || wifiDevices.length > 1 || settings.interface || kind === 'hotspot' ? (
      <Field
        label="Interface"
        error={shown('interface')}
        help={
          kind === 'hotspot'
            ? undefined
            : 'Bound to it, the connection is not used by other interfaces: for a sensor’s cable, say'
        }
      >
        {(id) => (
          <select id={id} value={settings.interface} onChange={(e) => set({ interface: e.target.value })}>
            {kind !== 'hotspot' && <option value="">{wireless ? 'Any Wi-Fi interface' : 'Any wired interface'}</option>}
            {kind === 'hotspot' && !settings.interface && <option value="">Choose one</option>}
            {(wireless ? wifiDevices : cableDevices).map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.product || d.vendor ? ` (${d.product || d.vendor})` : ''}
                {d.name === state.via ? ' · this page' : ''}
              </option>
            ))}
            {settings.interface && !state.devices.some((d) => d.name === settings.interface) && (
              <option value={settings.interface}>{settings.interface} (not here)</option>
            )}
          </select>
        )}
      </Field>
    ) : null;

  const passwordHelp =
    editing && settings.password === null ? 'Unchanged: type a new one to change it' : undefined;

  return (
    <Modal title={title} onClose={onClose} wide>
      <form className="modal-body net-form" onSubmit={(e) => void submit(e)}>
        {kind === 'hotspot' && interfaceField}
        {wireless && (
          <Field
            label="Network name (SSID)"
            error={shown('ssid')}
            help={kind === 'hotspot' ? 'What phones and laptops list' : undefined}
          >
            {(id) => (
              <input
                id={id}
                value={settings.ssid}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus={!editing}
                onChange={(e) => set({ ssid: e.target.value })}
              />
            )}
          </Field>
        )}
        {wireless && (
          <div className="net-form-row">
            <Field label="Security" error={shown('security')}>
              {(id) => (
                <select
                  id={id}
                  value={settings.security}
                  onChange={(e) => {
                    const security = e.target.value as WifiSecurity;
                    set({ security, password: needsPassword(security) ? (settings.password ?? (editing ? null : '')) : null });
                  }}
                >
                  {(kind === 'hotspot' ? (['wpa-psk', 'open'] as WifiSecurity[]) : CLIENT_SECURITIES).map((s) => (
                    <option key={s} value={s}>
                      {kind === 'hotspot' && s === 'wpa-psk' ? 'WPA2 Personal' : SECURITY_LABELS[s]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {settings.security === 'wpa-eap' && (
              <Field label="User name" error={shown('identity')}>
                {(id) => (
                  <input
                    id={id}
                    value={settings.identity}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    onChange={(e) => set({ identity: e.target.value })}
                  />
                )}
              </Field>
            )}
          </div>
        )}
        {wireless && needsPassword(settings.security) && (
          <Field
            label="Password"
            error={shown('password')}
            help={
              passwordHelp ??
              (kind === 'hotspot'
                ? '8 to 63 characters: give it to who joins, or share the access point’s QR code'
                : settings.security === 'wpa-eap'
                  ? 'PEAP with MSCHAPv2, the server’s certificate not checked'
                  : undefined)
            }
          >
            {(id) => (
              <div className="net-password-row">
                <PasswordInput
                  id={id}
                  value={settings.password ?? ''}
                  placeholder={editing && settings.password === null ? 'Unchanged' : undefined}
                  initiallyShown={kind === 'hotspot' && !editing}
                  onChange={(password) => set({ password: password === '' && editing ? null : password })}
                />
                {kind === 'hotspot' && (
                  <button type="button" className="button" onClick={() => set({ password: randomPassword() })}>
                    New one
                  </button>
                )}
              </div>
            )}
          </Field>
        )}
        {kind === 'hotspot' && settings.security === 'open' && (
          <p className="net-warning">Open: anyone in range may join the robot’s network, and reach the dashboard.</p>
        )}
        {kind === 'hotspot' && (
          <div className="net-form-row">
            <Field label="Band">
              {(id) => (
                <select
                  id={id}
                  value={settings.band}
                  onChange={(e) => set({ band: e.target.value as NetworkSettings['band'], channel: 0 })}
                >
                  <option value="">Automatic</option>
                  <option value="bg" disabled={device && !device.band24}>
                    2.4 GHz: farther, every device
                  </option>
                  <option value="a" disabled={device && !device.band5}>
                    5 GHz: faster
                  </option>
                </select>
              )}
            </Field>
            <Field label="Channel" error={shown('channel')}>
              {(id) => (
                <select
                  id={id}
                  value={settings.channel}
                  disabled={!settings.band}
                  onChange={(e) => set({ channel: Number(e.target.value) })}
                >
                  <option value={0}>Automatic</option>
                  {(settings.band ? CHANNELS[settings.band] : []).map((channel) => (
                    <option key={channel} value={channel}>
                      {channel}
                    </option>
                  ))}
                  {settings.band && settings.channel !== 0 && !CHANNELS[settings.band].includes(settings.channel) && (
                    <option value={settings.channel}>{settings.channel}</option>
                  )}
                </select>
              )}
            </Field>
          </div>
        )}
        {kind === 'wifi' && (
          <Toggle
            label="Hidden network"
            help="It does not show its name: the robot looks for it by name"
            checked={settings.hidden}
            onChange={(hidden) => set({ hidden })}
          />
        )}
        {kind !== 'hotspot' && interfaceField}
        <Field label="Connection name" error={shown('name')} help="How the robot’s lists name it">
          {(id) => (
            <input
              id={id}
              value={settings.name}
              autoComplete="off"
              onChange={(e) => {
                setNameTouched(true);
                set({ name: e.target.value });
              }}
            />
          )}
        </Field>

        <h3 className="net-form-heading">Addresses</h3>
        {kind !== 'hotspot' && (
          <Field label="IPv4" error={shown('ipv4')}>
            {(id) => (
              <select id={id} value={settings.ipv4} onChange={(e) => set({ ipv4: e.target.value as Ipv4Method })}>
                {METHODS[kind].map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {(settings.ipv4 === 'manual' || settings.ipv4 === 'shared') && (
          <Field
            label={settings.ipv4 === 'manual' ? 'The robot’s address' : 'The robot’s address on the network it gives'}
            error={shown('addresses')}
            help={
              settings.ipv4 === 'manual'
                ? 'With its network’s size: 192.168.1.20/24. Several: separated by commas'
                : 'Optional: 10.42.0.1/24 if empty. The others get addresses of its network'
            }
          >
            {(id) => (
              <input
                id={id}
                value={addresses}
                placeholder={settings.ipv4 === 'manual' ? '192.168.1.20/24' : '10.42.0.1/24'}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setAddresses(e.target.value);
                  set({ addresses: splitList(e.target.value) });
                }}
              />
            )}
          </Field>
        )}
        {settings.ipv4 !== 'disabled' && kind !== 'hotspot' && (
          <div className="net-form-row">
            {settings.ipv4 === 'manual' && (
              <Field label="Gateway" error={shown('gateway')} help="Optional: the way to other networks">
                {(id) => (
                  <input
                    id={id}
                    value={settings.gateway}
                    placeholder="192.168.1.1"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => set({ gateway: e.target.value.trim() })}
                  />
                )}
              </Field>
            )}
            <Field
              label="DNS servers"
              error={shown('dns')}
              help={settings.ipv4 === 'manual' ? 'Optional, separated by commas' : 'Optional: besides the network’s'}
            >
              {(id) => (
                <input
                  id={id}
                  value={dns}
                  placeholder="1.1.1.1, 8.8.8.8"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setDns(e.target.value);
                    set({ dns: splitList(e.target.value) });
                  }}
                />
              )}
            </Field>
          </div>
        )}

        <h3 className="net-form-heading">When</h3>
        <Toggle
          label={kind === 'hotspot' ? 'Start automatically' : 'Connect automatically'}
          help={
            kind === 'hotspot'
              ? 'When the robot starts: it is then the robot’s network wherever it goes'
              : kind === 'wifi'
                ? 'Whenever the robot is in its range'
                : 'Whenever a cable is plugged in'
          }
          checked={settings.autoconnect}
          onChange={(autoconnect) => set({ autoconnect })}
        />
        {settings.autoconnect && (
          <Field
            label="Priority"
            error={shown('priority')}
            help="Of the connections that connect automatically, the highest first"
          >
            {(id) => (
              <input
                id={id}
                type="number"
                min={-999}
                max={999}
                step={1}
                value={Number.isFinite(settings.priority) ? settings.priority : ''}
                onChange={(e) => set({ priority: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
            )}
          </Field>
        )}
        {!editing && (
          <Toggle
            label={kind === 'hotspot' ? 'Start it now' : 'Connect now'}
            checked={connect}
            onChange={setConnect}
          />
        )}
        <Problems risk={risk} error={error} />
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={`button ${risk ? 'danger' : 'primary'}`} disabled={busy}>
            {busy ? (connect && !editing ? 'Connecting…' : 'Saving…') : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CopyButton({ text, what }: { text: string; what: string }) {
  return (
    <button
      type="button"
      className="overlay-button"
      title={`Copy the ${what}`}
      aria-label={`Copy the ${what}`}
      onClick={() =>
        copyText(text).then(
          () => notify(`Copied the ${what}`),
          (e: unknown) => notify(`Could not copy the ${what}: ${errorMessage(e)}`, 'error'),
        )
      }
    >
      <CopyIcon width={15} height={15} />
    </button>
  );
}

function ShareDialog({ connection, onClose }: { connection: NetworkConnection; onClose: () => void }) {
  const [secrets, setSecrets] = useState<NetworkSecrets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let current = true;
    robot.networkAction({ action: 'secrets', uuid: connection.uuid }).then(
      (value) => current && setSecrets(value),
      (e: unknown) => current && setError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [connection.uuid]);

  const ssid = secrets?.ssid ?? connection.ssid;
  const security = secrets?.security ?? connection.security ?? 'open';
  const open = !needsPassword(security);
  const readable = open || !!secrets?.password;
  // Phones join WPA (any version) and WEP networks by QR code, not
  // enterprise ones
  const qr =
    secrets && readable && security !== 'wpa-eap'
      ? wifiQrText(ssid, secrets.password, open ? 'nopass' : security === 'wep' ? 'WEP' : 'WPA', secrets.hidden)
      : null;

  let body;
  if (error) {
    body = <p className="net-error">{error}</p>;
  } else if (!secrets) {
    body = <p className="net-muted">Reading the password…</p>;
  } else {
    body = (
      <>
        {qr && (
          <div className="net-share-code">
            <QrCode text={qr} label={`QR code to join ${ssid}`} />
            <p className="net-muted">Point a phone’s camera at it to join {ssid}</p>
          </div>
        )}
        <dl className="net-facts net-share-facts">
          <div>
            <dt>Network</dt>
            <dd>
              <span>{ssid}</span>
              <CopyButton text={ssid} what="network’s name" />
            </dd>
          </div>
          <div>
            <dt>Security</dt>
            <dd>{SECURITY_LABELS[security]}</dd>
          </div>
          {!open && (
            <div>
              <dt>Password</dt>
              <dd>
                {readable ? (
                  <>
                    <span className="net-secret">{shown ? secrets.password : '•'.repeat(Math.min(16, secrets.password.length))}</span>
                    <button
                      type="button"
                      className="overlay-button"
                      title={shown ? 'Hide the password' : 'Show the password'}
                      aria-label={shown ? 'Hide the password' : 'Show the password'}
                      aria-pressed={shown}
                      onClick={() => setShown((on) => !on)}
                    >
                      {shown ? 'Hide' : 'Show'}
                    </button>
                    <CopyButton text={secrets.password} what="password" />
                  </>
                ) : (
                  <span className="net-muted">
                    Not readable: the server’s user may not read NetworkManager’s secrets, or they are kept by
                    a desktop’s keyring
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
      </>
    );
  }

  return (
    <Modal title={`Share ${ssid || connection.name}`} onClose={onClose}>
      <div className="modal-body">
        {body}
        <div className="modal-actions">
          <button type="button" className="button primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function NetworkDialog({
  request,
  state,
  onClose,
}: {
  request: DialogRequest;
  state: PageState;
  onClose: () => void;
}) {
  switch (request.kind) {
    case 'join':
    case 'password':
      return <JoinDialog state={state} request={request} onClose={onClose} />;
    case 'create':
    case 'edit':
      return <ConnectionDialog state={state} request={request} onClose={onClose} />;
    case 'share':
      return <ShareDialog connection={request.connection} onClose={onClose} />;
  }
}
