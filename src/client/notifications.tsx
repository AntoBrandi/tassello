// Short messages at the bottom of the page, from anywhere: notify(...)

import { useSyncExternalStore } from 'react';

export interface Notification {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const DURATION_MS = 5000;

let notifications: Notification[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: Notification[]): void {
  notifications = next;
  listeners.forEach((listener) => listener());
}

function dismiss(id: number): void {
  set(notifications.filter((n) => n.id !== id));
}

export function notify(
  message: string,
  kind: Notification['kind'] = 'info',
  action?: Notification['action'],
): void {
  const id = nextId++;
  // The same message again replaces the previous one instead of piling up
  set([...notifications.filter((n) => n.message !== message), { id, message, kind, action }].slice(-4));
  setTimeout(() => dismiss(id), DURATION_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function Notifications() {
  const list = useSyncExternalStore(subscribe, () => notifications);
  return (
    <div className="notifications" role="status" aria-live="polite">
      {list.map((n) => (
        <div key={n.id} className={`notification ${n.kind}`}>
          <span>{n.message}</span>
          {n.action && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                n.action?.run();
                dismiss(n.id);
              }}
            >
              {n.action.label}
            </button>
          )}
          <button type="button" className="notification-close" aria-label="Dismiss" onClick={() => dismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
