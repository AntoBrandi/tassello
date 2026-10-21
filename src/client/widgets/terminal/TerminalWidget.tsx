// A terminal on the robot: the login shell of the server's user, or a command
// (htop, tmux attach), as on a terminal of the robot's own. It outlives the
// page (see src/server/terminals.ts). Touch screens get the keys they lack
// (Esc, Tab, Ctrl, Alt, the arrows...) above the on-screen keyboard.
//
// xterm.js is large: its code (TerminalView.tsx) is only fetched when a panel
// shows a terminal.

import { lazy, Suspense } from 'react';

import { ShellIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import { DEFAULT_KEYS } from './keys.ts';

export interface TerminalConfig {
  command: string;
  folder: string;
  fontSize: number;
  theme: 'auto' | 'dark' | 'light';
  extraKeys: 'touch' | 'always' | 'never';
  keys: string;
  fullScreenTyping: boolean;
}

const TerminalView = lazy(() => import('./TerminalView.tsx'));

function TerminalWidget({ config, instance, panelId, editing }: WidgetProps<TerminalConfig>) {
  return (
    <Suspense fallback={<div className="widget-message">Loading the terminal…</div>}>
      <TerminalView config={config} panelId={panelId} widgetId={instance.id} editing={editing} />
    </Suspense>
  );
}

export const terminalWidget = defineWidget<TerminalConfig>({
  type: 'terminal',
  name: 'Terminal',
  description: 'A shell on the robot, or a command. On touch screens, the keys phones lack: Esc, Tab, Ctrl, Alt, arrows.',
  icon: ShellIcon,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },
  component: TerminalWidget,
  properties: [
    {
      key: 'command',
      label: 'Command',
      kind: 'text',
      default: '',
      placeholder: 'htop',
      help: 'Run instead of a shell, by the login shell: e.g. htop, or tmux new -A -s robot for one session that every page shares. Empty: the shell',
    },
    {
      key: 'folder',
      label: 'Folder',
      kind: 'string',
      default: '~',
      placeholder: '~/ros2_ws',
      help: 'Where it starts: /…, ~/… or package://<package>/…',
    },
    {
      key: 'fontSize',
      label: 'Text size',
      kind: 'number',
      default: 13,
      min: 7,
      max: 32,
      step: 1,
      help: 'In pixels. Each device changes it with the toolbar, or by pinching',
    },
    {
      key: 'theme',
      label: 'Colours',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'The page’s, dark or light' },
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ],
    },
    {
      key: 'extraKeys',
      label: 'Extra keys',
      kind: 'select',
      default: 'touch',
      options: [
        { value: 'touch', label: 'On touch screens' },
        { value: 'always', label: 'Always' },
        { value: 'never', label: 'Never' },
      ],
      help: 'Keys the on-screen keyboard lacks, under the terminal. Ctrl, Alt and Shift apply to the next key, of the row or of the keyboard: tap twice, or hold, to keep them. Swiping up on a key types what its corner shows',
    },
    {
      key: 'keys',
      label: 'Extra keys’ layout',
      kind: 'text',
      default: DEFAULT_KEYS,
      help: 'A line per row, keys separated by spaces: ESC TAB CTRL ALT SHIFT HOME END PGUP PGDN UP DOWN LEFT RIGHT INS DEL BKSP ENTER SPACE F1…F12 KEYBOARD PASTE, or what to type (~, |, ros2). What swiping up types follows a colon: -:|',
      visible: (config) => config.extraKeys !== 'never',
    },
    {
      key: 'fullScreenTyping',
      label: 'Full screen while typing',
      kind: 'boolean',
      default: true,
      help: 'On touch screens: while the on-screen keyboard is open, the terminal fills the screen above it, the extra keys right above it',
    },
  ],
});
