// What the Networking widget's views and dialogs share: the icons of the
// signals and of the kinds of connection, the form's fields, and the QR code
// that joins a network.

import { useId, useMemo, useState, type ReactNode } from 'react';

import type { ConnectionKind, NetworkDevice } from '../../../shared/networking.ts';
import { EthernetIcon, EyeIcon, EyeOffIcon, HotspotIcon, NetworkIcon, ShieldIcon, WifiIcon } from '../../icons.tsx';
import { qrCode } from './qr.ts';
import { signalLevel, type Tone } from './model.ts';

// Wi-Fi's arcs, those above the signal dimmed
export function SignalIcon({ signal, size = 18 }: { signal: number; size?: number }) {
  const level = signalLevel(signal);
  const lit = (from: number) => (level >= from ? undefined : 0.22);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="net-signal"
    >
      <path d="M2.5 9a14 14 0 0 1 19 0" opacity={lit(4)} />
      <path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" opacity={lit(3)} />
      <path d="M8.6 15.9a5 5 0 0 1 6.8 0" opacity={lit(2)} />
      <circle cx="12" cy="19.3" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function KindIcon({ kind, size = 18 }: { kind: ConnectionKind; size?: number }) {
  const props = { width: size, height: size };
  switch (kind) {
    case 'wifi':
      return <WifiIcon {...props} />;
    case 'hotspot':
      return <HotspotIcon {...props} />;
    case 'ethernet':
      return <EthernetIcon {...props} />;
    case 'vpn':
      return <ShieldIcon {...props} />;
    default:
      return <NetworkIcon {...props} />;
  }
}

export function DeviceIcon({ device, size = 18 }: { device: NetworkDevice; size?: number }) {
  return (
    <KindIcon
      kind={device.type === 'wifi' ? 'wifi' : device.type === 'ethernet' ? 'ethernet' : device.type === 'tun' || device.type === 'wireguard' ? 'vpn' : 'other'}
      size={size}
    />
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`net-dot ${tone}`} aria-hidden="true" />;
}

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? <p className="field-help error">{error}</p> : help && <p className="field-help">{help}</p>}
    </div>
  );
}

export function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="field">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="toggle-switch" aria-hidden="true" />
        <span className="field-label">{label}</span>
      </label>
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

// A password, shown on demand. Browsers are not to offer theirs: it is the
// network's, not the dashboard's.
export function PasswordInput({
  id,
  value,
  placeholder,
  autoFocus = false,
  initiallyShown = false,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  // A password made for it, which no one has seen yet
  initiallyShown?: boolean;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(initiallyShown);
  return (
    <div className="net-password">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete="new-password"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="overlay-button"
        title={shown ? 'Hide the password' : 'Show the password'}
        aria-label={shown ? 'Hide the password' : 'Show the password'}
        aria-pressed={shown}
        onClick={() => setShown((on) => !on)}
      >
        {shown ? <EyeOffIcon width={16} height={16} /> : <EyeIcon width={16} height={16} />}
      </button>
    </div>
  );
}

// Dark on white whatever the theme, with the quiet zone readers need
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const modules = qrCode(text);
    if (!modules) {
      return null;
    }
    // A rectangle per run of dark modules of a row
    let d = '';
    modules.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) {
          continue;
        }
        let run = 1;
        while (x + run < row.length && row[x + run]) {
          run++;
        }
        d += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
        x += run - 1;
      }
    });
    return { d, size: modules.length + 8 };
  }, [text]);
  if (!path) {
    return null;
  }
  return (
    <svg className="net-qr" viewBox={`0 0 ${path.size} ${path.size}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

// 12 characters, none that read alike (0 O, 1 l I)
export function randomPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}
