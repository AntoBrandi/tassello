// What a status widget shows, in a row: an icon, the reading, what it is of,
// and something filling the rest (a chart). What does not fit its width goes
// (container queries on .status-widget, see styles.css): under 50 px it keeps
// the icon or the value, under 96 px both, the label from 96 px, the rest
// from 130 px.

import type { ReactNode } from 'react';

import type { StatusTone } from './model.ts';

export type { StatusTone } from './model.ts';

export interface StatusReadoutProps {
  icon?: ReactNode;
  // 72%, Off
  value?: ReactNode;
  // What the value is of: the network's name
  label?: ReactNode;
  // Its colour: ok, warn (yellow), critical (red), off (dimmed, nothing to show)
  tone?: StatusTone;
  // The details, shown by the pointer and told by screen readers
  title?: string;
  // What it keeps under 50 px
  narrow?: 'icon' | 'value';
  // After the label, filling the rest: a chart
  children?: ReactNode;
}

export function StatusReadout({ icon, value, label, tone = 'ok', title, narrow = 'icon', children }: StatusReadoutProps) {
  return (
    <div className={`status-readout ${tone} keep-${narrow}`} title={title} aria-label={title}>
      {icon && <span className="status-readout-icon">{icon}</span>}
      {value !== undefined && <span className="status-readout-value">{value}</span>}
      {label && <span className="status-readout-label">{label}</span>}
      {children && <span className="status-readout-extra">{children}</span>}
    </div>
  );
}
