// Runs a bash command on the robot, as the server's user, in its environment
// (the sourced workspace). The button takes its running colour until the
// command finishes, on every page showing it; pressing it again stops it.

import { useEffect, useRef, useState } from 'react';

import { connection, useCommandState } from '../connection.ts';
import { useDialogs } from '../dialogs.tsx';
import { TerminalIcon } from '../icons.tsx';
import { notify } from '../notifications.tsx';
import type { CommandState } from '../../shared/protocol.ts';
import { defineWidget, type WidgetProps } from './types.ts';

interface ButtonConfig {
  label: string;
  command: string;
  confirm: boolean;
  allowStop: boolean;
  showOutput: boolean;
  color: string;
  runningColor: string;
}

// Gives up waiting for the server to report a command started
const START_TIMEOUT_MS = 5000;

// Black or white, whichever reads better on the colour
function textColorOn(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) {
    return '#fff';
  }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#111' : '#fff';
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function outcome(state: CommandState): { text: string; ok: boolean } {
  if (state.error) {
    return { text: state.error, ok: false };
  }
  if (state.signal) {
    return { text: `Stopped (${state.signal})`, ok: false };
  }
  if (state.exitCode === 0) {
    return { text: 'Done', ok: true };
  }
  return { text: `Exit code ${state.exitCode}`, ok: false };
}

function ButtonWidget({ config, instance, panelId, editing }: WidgetProps<ButtonConfig>) {
  const state = useCommandState(panelId, instance.id);
  const dialogs = useDialogs();
  // Clicked, and the server has not reported the command's state since
  const [starting, setStarting] = useState<{ from: CommandState | undefined; at: number } | null>(null);
  const [, setTick] = useState(0);
  const outputRef = useRef<HTMLPreElement>(null);

  const running = state?.running ?? false;
  const busy = running || starting !== null;
  const label = config.label || 'Run';

  useEffect(() => {
    if (starting && state !== starting.from) {
      setStarting(null);
    }
  }, [state, starting]);

  // Ticks the elapsed time
  useEffect(() => {
    if (!busy) {
      return;
    }
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
      setStarting((s) => (s && Date.now() - s.at > START_TIMEOUT_MS ? null : s));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const output = outputRef.current;
    if (output) {
      output.scrollTop = output.scrollHeight;
    }
  }, [state?.output]);

  const onClick = async () => {
    if (editing) {
      return;
    }
    const target = { panelId, widgetId: instance.id };
    if (running) {
      if (
        config.allowStop &&
        (await dialogs.confirm({
          title: `Stop "${label}"?`,
          message: 'The command gets SIGINT, then SIGTERM and SIGKILL if it does not stop.',
          confirmLabel: 'Stop',
          danger: true,
        }))
      ) {
        connection.send({ type: 'command.stop', ...target });
      }
      return;
    }
    if (busy) {
      return;
    }
    if (!config.command.trim()) {
      notify(`"${label}" has no command: set one in edit mode`, 'error');
      return;
    }
    if (
      config.confirm &&
      !(await dialogs.confirm({
        title: `Run "${label}"?`,
        message: <pre className="dialog-command">{config.command}</pre>,
        confirmLabel: 'Run',
      }))
    ) {
      return;
    }
    if (connection.send({ type: 'command.run', ...target })) {
      setStarting({ from: state, at: Date.now() });
    } else {
      notify('Not connected to the robot', 'error');
    }
  };

  let status: { text: string; className: string } | null = null;
  if (busy) {
    const elapsed = running && state ? duration(connection.serverNow() - state.startedAt) : '';
    status = {
      text: `Running ${elapsed}${running && config.allowStop ? ' · press to stop' : ''}`,
      className: '',
    };
  } else if (state) {
    const { text, ok } = outcome(state);
    status = { text: `${ok ? '✓' : '✗'} ${text}`, className: ok ? 'ok' : 'failed' };
  }

  const background = busy ? config.runningColor : config.color;
  return (
    <div className={`command-button${config.showOutput ? ' with-output' : ''}`}>
      <button
        type="button"
        className={`command-button-face${busy ? ' busy' : ''}`}
        style={{ backgroundColor: background, color: textColorOn(background) }}
        onClick={onClick}
        title={config.command}
        tabIndex={editing ? -1 : 0}
      >
        <span className="command-button-label">{label}</span>
        {status && <span className={`command-button-status ${status.className}`}>{status.text}</span>}
      </button>
      {config.showOutput && (
        <pre ref={outputRef} className="command-output">
          {state?.output || (busy ? '' : 'No output yet')}
        </pre>
      )}
    </div>
  );
}

export const buttonWidget = defineWidget<ButtonConfig>({
  type: 'button',
  name: 'Button',
  description: 'Run a bash command on the robot, e.g. start a service or a launch file.',
  icon: TerminalIcon,
  defaultSize: { w: 3, h: 1 },
  minSize: { w: 1, h: 1 },
  component: ButtonWidget,
  properties: [
    { key: 'label', label: 'Label', kind: 'string', default: 'Run' },
    {
      key: 'command',
      label: 'Bash command',
      kind: 'text',
      default: '',
      placeholder: 'ros2 launch my_robot navigation.launch.py',
      help: "Runs with bash -c, as the server's user, in the workspace's environment",
    },
    { key: 'confirm', label: 'Ask before running', kind: 'boolean', default: false },
    {
      key: 'allowStop',
      label: 'Press again to stop',
      kind: 'boolean',
      default: true,
      help: 'While the command runs, pressing the button stops it',
    },
    {
      key: 'showOutput',
      label: 'Show output',
      kind: 'boolean',
      default: false,
      help: 'The last lines the command printed, below the button',
    },
    { key: 'color', label: 'Colour', kind: 'color', default: '#2f6fed' },
    { key: 'runningColor', label: 'Colour while running', kind: 'color', default: '#e8890c' },
  ],
});
