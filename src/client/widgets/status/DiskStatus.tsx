// A disk's use, as the file manager's overview has it (see
// src/server/disks.ts): of the one mounted where chosen, else of the fullest,
// with a bar of it. The disks are read every 30 s while the page is shown, as
// the file manager reads them, once for all the page's disk status widgets.

import { useEffect, useMemo, useState } from 'react';

import type { FsDisk } from '../../../shared/file_manager.ts';
import { fsApi } from '../../api.ts';
import { HardDriveIcon } from '../../icons.tsx';
import { defineStatusWidget, type StatusWidgetProps } from '../types.ts';
import { diskReading } from './model.ts';
import { StatusReadout } from './StatusReadout.tsx';

interface DiskStatusConfig {
  mount: string;
  show: 'used' | 'free';
  warnAbove: number;
  criticalAbove: number;
  bar: boolean;
}

interface Disks {
  // null until read
  disks: FsDisk[] | null;
  // Of the last reading; the disks read before are kept
  error: string | null;
}

const DISKS_MS = 30_000;

const listeners = new Set<(disks: Disks) => void>();
let latest: Disks = { disks: null, error: null };
let timer: ReturnType<typeof setInterval> | null = null;
let reading = false;

function publish(disks: Disks): void {
  latest = disks;
  for (const listener of listeners) {
    listener(disks);
  }
}

function read(): void {
  if (reading || document.visibilityState !== 'visible') {
    return;
  }
  reading = true;
  fsApi
    .disks()
    .then(
      (disks) => publish({ disks, error: null }),
      (e: unknown) => publish({ disks: latest.disks, error: e instanceof Error ? e.message : String(e) }),
    )
    .finally(() => {
      reading = false;
    });
}

// Shown again: read now rather than at the next tick
function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    read();
  }
}

// Returns the unwatch function
function watchDisks(listener: (disks: Disks) => void): () => void {
  listeners.add(listener);
  listener(latest);
  if (!timer) {
    read();
    timer = setInterval(read, DISKS_MS);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

function useDisks(): Disks {
  const [disks, setDisks] = useState(latest);
  useEffect(() => watchDisks(setDisks), []);
  return disks;
}

// The robot's disks, for the property
function useMounts(): { value: string; label: string }[] {
  const { disks } = useDisks();
  return (disks ?? []).map((disk) => ({ value: disk.mount, label: disk.mount }));
}

function DiskStatus({ config }: StatusWidgetProps<DiskStatusConfig>) {
  const { disks, error } = useDisks();
  const reading = useMemo(
    () => diskReading(disks, error, config.mount, config.show, config.warnAbove, config.criticalAbove),
    [disks, error, config.mount, config.show, config.warnAbove, config.criticalAbove],
  );
  return (
    <StatusReadout
      icon={<HardDriveIcon width={16} height={16} />}
      value={reading.value}
      label={reading.label}
      tone={reading.tone}
      title={reading.title}
      narrow="value"
    >
      {config.bar && reading.share !== null && (
        <span className="status-meter" aria-hidden="true">
          <span style={{ width: `${Math.min(1, reading.share) * 100}%` }} />
        </span>
      )}
    </StatusReadout>
  );
}

export const diskStatusWidget = defineStatusWidget<DiskStatusConfig>({
  type: 'disk-status',
  name: 'Disk',
  description: 'How full a disk of the robot is, or the fullest of them, as the File Manager shows them.',
  icon: HardDriveIcon,
  defaultWidth: 3,
  minWidth: 1,
  component: DiskStatus,
  properties: [
    {
      key: 'mount',
      label: 'Disk',
      kind: 'select',
      default: '',
      options: [
        { value: '', label: 'The fullest' },
        { value: '/', label: '/' },
      ],
      useOptions: useMounts,
      help: 'By where it is mounted. The fullest of those written to, if none is chosen: it changes as they fill',
    },
    {
      key: 'show',
      label: 'Show',
      kind: 'select',
      default: 'used',
      options: [
        { value: 'used', label: 'The share used' },
        { value: 'free', label: 'The space free' },
      ],
    },
    { key: 'warnAbove', label: 'Filling above (%)', kind: 'number', default: 85, min: 0, max: 100, help: 'In yellow above this use, of its space or of its inodes' },
    { key: 'criticalAbove', label: 'Full above (%)', kind: 'number', default: 95, min: 0, max: 100, help: 'In red above this one' },
    { key: 'bar', label: 'Bar', kind: 'boolean', default: true, help: 'Its use, when the widget is wide enough' },
  ],
});
