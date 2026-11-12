// What an operator does with a twist_mux from its inspector: its joystick
// relay's priority (Autonomous or Manual) and turbo steps, as a joystick's
// buttons do, in a bar under the toolbar; its locks, locked or released, from
// their cards (MuxDiagram.tsx). Each asks the server (twistmux.control), which
// sends the relay's goals and publishes the locks' messages; what changes
// comes back with the mux's state.

import { useCallback, useEffect, useState } from 'react';

import type { MuxControl, MuxRelay, RelayAction, StepRange } from '../../../shared/twist_mux.ts';
import { may } from '../../auth.ts';
import { connection } from '../../connection.ts';
import { GamepadIcon, MinusIcon, PlusIcon, UndoIcon } from '../../icons.tsx';
import { notify } from '../../notifications.tsx';
import { stepText, turboSpeeds } from './model.ts';

// Beyond this many steps, the meter is its text only
const MAX_SEGMENTS = 10;
// A second click within this long confirms a release
export const CONFIRM_MS = 3000;

export interface MuxControls {
  // An operator's, or more
  allowed: boolean;
  // The control being sent, by key: the others wait
  pending: string | null;
  send: (key: string, control: MuxControl) => void;
}

export function useMuxControls(node: string): MuxControls {
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => setPending(null), [node]);
  const send = useCallback(
    (key: string, control: MuxControl) => {
      setPending(key);
      connection
        .controlTwistMux(node, control)
        .catch((e: unknown) => notify(`${node}: ${e instanceof Error ? e.message : String(e)}`, 'error'))
        .finally(() => setPending((current) => (current === key ? null : current)));
    },
    [node],
  );
  return { allowed: may('operator'), pending, send };
}

// A button that asks twice: the first click arms it for CONFIRM_MS
export function useConfirm(): { armed: boolean; arm: () => void; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return { armed, arm: () => setArmed(true), disarm: () => setArmed(false) };
}

const NOT_ALLOWED = 'Takes an operator';

function StepMeter({ range, steps, label }: { range: StepRange | null; steps: number; label: string }) {
  const text = stepText(range, steps);
  return (
    <span className="mux-step" role="img" aria-label={`${label}: step ${text}`}>
      {steps <= MAX_SEGMENTS && (
        <span className="mux-step-bars" aria-hidden="true">
          {Array.from({ length: steps }, (_, i) => {
            const step = i + 1;
            const kind = !range ? 'maybe' : step <= range.low ? 'on' : step <= range.high ? 'maybe' : 'off';
            const height = 6 + (8 * i) / Math.max(1, steps - 1);
            return <span key={step} className={`mux-step-bar ${kind}`} style={{ height }} />;
          })}
        </span>
      )}
      <span className="mux-step-text">{text}</span>
    </span>
  );
}

function Stepper({
  label,
  title,
  range,
  steps,
  down,
  up,
  relay,
  controls,
}: {
  label: string;
  title: string;
  range: StepRange | null;
  steps: number;
  down: RelayAction;
  up: RelayAction;
  relay: MuxRelay;
  controls: MuxControls;
}) {
  const busy = controls.pending !== null;
  const button = (action: RelayAction, atEnd: boolean, what: string, end: number) => {
    const why = !controls.allowed
      ? NOT_ALLOWED
      : !relay.actions.includes(action)
        ? `${relay.node} serves no ${action}`
        : atEnd
          ? `Already at step ${end}`
          : '';
    return (
      <button
        type="button"
        className={`mux-step-button${controls.pending === action ? ' pending' : ''}`}
        disabled={busy || why !== ''}
        title={why || `${what}: ${relay.node}’s ${action}`}
        aria-label={`${label} ${what.toLowerCase()}`}
        onClick={() => controls.send(action, { kind: 'relay', action })}
      >
        {action === up ? <PlusIcon width={13} height={13} /> : <MinusIcon width={13} height={13} />}
      </button>
    );
  };
  return (
    <span className="mux-stepper" title={title}>
      <span className="mux-control-label">{label}</span>
      {button(down, range !== null && range.high <= 1, 'Slower', 1)}
      <StepMeter range={range} steps={steps} label={label} />
      {button(up, range !== null && range.low >= steps, 'Faster', steps)}
    </span>
  );
}

// The relay's priority and turbo, under the toolbar
export function RelayBar({ relay, controls }: { relay: MuxRelay; controls: MuxControls }) {
  const busy = controls.pending !== null;
  const { turbo } = relay;
  const speeds = turboSpeeds(relay);
  const relayTitle = [
    `${relay.node}: twist_mux’s joystick relay`,
    relay.inputTopic && `Takes the joystick’s commands on ${relay.inputTopic}`,
    relay.outputTopic && `Publishes them, scaled by its turbo, on ${relay.outputTopic}${relay.input ? ` (the mux’s input ${relay.input})` : ''}`,
    relay.priorityTopic &&
      `Publishes its priority on ${relay.priorityTopic}${relay.lock ? ` (the mux’s lock ${relay.lock})` : ''}`,
    relay.error,
  ]
    .filter(Boolean)
    .join('\n');

  const canToggle = relay.actions.includes('priority');
  const mode = (manual: boolean) => {
    const active = relay.manual === manual;
    const why = !controls.allowed
      ? NOT_ALLOWED
      : !canToggle
        ? `${relay.node} serves no priority action`
        : relay.manual === null
          ? 'Its priority is not known yet'
          : '';
    const title = manual
      ? `Manual: the joystick’s commands pass${relay.lock ? `, and its lock ${relay.lock} masks the inputs below it` : ''}`
      : 'Autonomous: the joystick’s commands do not pass, the other inputs drive';
    return (
      <button
        type="button"
        className={`mux-mode-button${active ? ' active' : ''}${manual ? ' manual' : ''}`}
        aria-pressed={active}
        disabled={busy || (!active && why !== '')}
        title={active ? title : why || `${title}. Toggles ${relay.node}’s priority`}
        onClick={() => {
          if (!active) {
            controls.send('priority', { kind: 'relay', action: 'priority' });
          }
        }}
      >
        {manual ? 'Manual' : 'Autonomous'}
      </button>
    );
  };

  const resetWhy = !controls.allowed
    ? NOT_ALLOWED
    : !relay.actions.includes('turbo-reset')
      ? `${relay.node} serves no turbo reset`
      : '';
  return (
    <div className="mux-controls" role="toolbar" aria-label="Joystick relay">
      <span className="mux-relay" title={relayTitle}>
        <GamepadIcon width={15} height={15} />
        {relay.error && <span className="mux-relay-error" aria-hidden="true" />}
      </span>
      <span className={`mux-mode${controls.pending === 'priority' ? ' pending' : ''}`} role="group" aria-label="Joystick priority">
        {mode(false)}
        {mode(true)}
      </span>
      {turbo && (
        <>
          <Stepper
            label="Speed"
            title="The turbo step of the linear velocities (and, up or down, of turning too)"
            range={relay.linearStep}
            steps={turbo.steps}
            down="turbo-decrease"
            up="turbo-increase"
            relay={relay}
            controls={controls}
          />
          {(relay.actions.includes('turbo-angular-increase') || relay.actions.includes('turbo-angular-decrease')) && (
            <Stepper
              label="Turn"
              title="The turbo step of turning alone"
              range={relay.angularStep}
              steps={turbo.steps}
              down="turbo-angular-decrease"
              up="turbo-angular-increase"
              relay={relay}
              controls={controls}
            />
          )}
          <button
            type="button"
            className={`mux-step-button${controls.pending === 'turbo-reset' ? ' pending' : ''}`}
            disabled={busy || resetWhy !== ''}
            title={resetWhy || `Reset the turbo: back to step ${turbo.initStep}`}
            aria-label="Reset the turbo"
            onClick={() => controls.send('turbo-reset', { kind: 'relay', action: 'turbo-reset' })}
          >
            <UndoIcon width={13} height={13} />
          </button>
        </>
      )}
      {speeds && (
        <span className="mux-speeds" title={speeds.title}>
          {speeds.text}
        </span>
      )}
    </div>
  );
}
