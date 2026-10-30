// The Wi-Fi network the robot is on, and its signal: the Networking widget's
// follower of NetworkManager (see src/server/networking.ts), without its
// scans, which may slow the network down.

import { useEffect, useMemo, useState } from 'react';

import type { NetworkUpdate } from '../../../shared/protocol.ts';
import { connection } from '../../connection.ts';
import { WifiIcon, WifiOffIcon } from '../../icons.tsx';
import { SignalIcon } from '../networking/parts.tsx';
import { defineStatusWidget, type StatusWidgetProps } from '../types.ts';
import { wifiReading } from './model.ts';
import { StatusReadout } from './StatusReadout.tsx';

interface WifiStatusConfig {
  device: string;
  warnBelow: number;
  criticalBelow: number;
}

function useNetwork(): NetworkUpdate | null {
  const [state, setState] = useState<NetworkUpdate | null>(null);
  useEffect(() => connection.subscribeNetwork(setState, { scan: false }), []);
  return state;
}

// The robot's Wi-Fi interfaces, for the property
function useWifiDevices(): { value: string; label: string }[] {
  const state = useNetwork();
  return (state?.devices ?? [])
    .filter((device) => device.type === 'wifi')
    .map((device) => ({ value: device.name, label: device.name }));
}

function WifiStatus({ config }: StatusWidgetProps<WifiStatusConfig>) {
  const state = useNetwork();
  const reading = useMemo(
    () => wifiReading(state, config.device, config.warnBelow, config.criticalBelow),
    [state, config.device, config.warnBelow, config.criticalBelow],
  );
  const icon =
    reading.signal !== null ? (
      <SignalIcon signal={reading.signal} size={16} />
    ) : reading.tone === 'ok' ? (
      <WifiIcon width={16} height={16} />
    ) : (
      <WifiOffIcon width={16} height={16} />
    );
  return <StatusReadout icon={icon} value={reading.value} label={reading.label} tone={reading.tone} title={reading.title} />;
}

export const wifiStatusWidget = defineStatusWidget<WifiStatusConfig>({
  type: 'wifi-status',
  name: 'Wi-Fi',
  description: 'The Wi-Fi network the robot is on, and its signal, as NetworkManager has them.',
  icon: WifiIcon,
  defaultWidth: 3,
  minWidth: 1,
  component: WifiStatus,
  properties: [
    {
      key: 'device',
      label: 'Interface',
      kind: 'select',
      default: '',
      options: [{ value: '', label: 'The one connected' }],
      useOptions: useWifiDevices,
      help: 'With several Wi-Fi interfaces: the one with the default route if none is chosen',
    },
    { key: 'warnBelow', label: 'Weak below (%)', kind: 'number', default: 50, min: 0, max: 100, help: 'In yellow below this signal' },
    { key: 'criticalBelow', label: 'Too weak below (%)', kind: 'number', default: 25, min: 0, max: 100, help: 'In red below this one' },
  ],
});
