// The row of extra keys under the terminal, Termux's: tapped, they type into
// the terminal without taking its focus, so that the on-screen keyboard stays.
// Ctrl, Alt and Shift light up for the next key (tap twice, or hold, to keep
// them); swiping up on a key, or holding it, types what its corner shows; the
// arrows and the like repeat while held.

import { useEffect, useRef, useState, type PointerEvent } from 'react';

import type { ExtraKey, Modifier } from './keys.ts';

export type ModifierState = 'off' | 'once' | 'locked';

// Held this long: the key repeats, its popup shows, a modifier locks
const HOLD_MS = 400;
const REPEAT_MS = 60;
// Moved up this far: the popup
const SWIPE_PX = 18;

interface Gesture {
  pointer: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Done by holding it: nothing more when let go
  held: boolean;
  popup: boolean;
}

function KeyButton({
  extraKey,
  state,
  onKey,
  onModifier,
}: {
  extraKey: ExtraKey;
  state: ModifierState;
  onKey: (key: ExtraKey) => void;
  onModifier: (modifier: Modifier, lock: boolean) => void;
}) {
  const [pressed, setPressed] = useState(false);
  const [popup, setPopup] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  // The latest, for the timers
  const handlers = useRef({ onKey, onModifier });
  handlers.current = { onKey, onModifier };

  const end = () => {
    if (gesture.current?.timer) {
      clearTimeout(gesture.current.timer);
    }
    gesture.current = null;
    setPressed(false);
    setPopup(false);
  };
  useEffect(() => end, []);

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || gesture.current) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const current: Gesture = { pointer: event.pointerId, y: event.clientY, timer: null, held: false, popup: false };
    gesture.current = current;
    setPressed(true);
    const { modifier } = extraKey;
    if (modifier) {
      current.timer = setTimeout(() => {
        current.held = true;
        handlers.current.onModifier(modifier, true);
      }, HOLD_MS);
    } else if (extraKey.repeat) {
      const repeat = () => {
        current.held = true;
        handlers.current.onKey(current.popup && extraKey.popup ? extraKey.popup : extraKey);
        current.timer = setTimeout(repeat, REPEAT_MS);
      };
      current.timer = setTimeout(repeat, HOLD_MS);
    } else if (extraKey.popup) {
      current.timer = setTimeout(() => {
        current.popup = true;
        setPopup(true);
      }, HOLD_MS);
    }
  };

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId || !extraKey.popup || current.held) {
      return;
    }
    const up = current.y - event.clientY > SWIPE_PX;
    if (up && !current.popup) {
      current.popup = true;
      setPopup(true);
    }
  };

  const up = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) {
      return;
    }
    if (!current.held) {
      if (extraKey.modifier) {
        onModifier(extraKey.modifier, false);
      } else {
        onKey(current.popup && extraKey.popup ? extraKey.popup : extraKey);
      }
    }
    end();
  };

  const title = extraKey.popup ? `${extraKey.title}; swipe up: ${extraKey.popup.title}` : extraKey.title;
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`terminal-key${pressed ? ' pressed' : ''}${extraKey.label.length > 2 ? ' word' : ''}`}
      data-state={extraKey.modifier ? state : undefined}
      aria-pressed={extraKey.modifier ? state !== 'off' : undefined}
      aria-label={title}
      title={title}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      {extraKey.label}
      {extraKey.popup && <span className="terminal-key-popup">{extraKey.popup.label}</span>}
      {popup && extraKey.popup && <span className="terminal-key-bubble">{extraKey.popup.label}</span>}
      {state === 'locked' && <span className="terminal-key-lock" aria-hidden="true" />}
    </button>
  );
}

export function ExtraKeys({
  rows,
  modifiers,
  onKey,
  onModifier,
}: {
  rows: ExtraKey[][];
  modifiers: Record<Modifier, ModifierState>;
  onKey: (key: ExtraKey) => void;
  onModifier: (modifier: Modifier, lock: boolean) => void;
}) {
  return (
    <div
      className="terminal-keys"
      role="toolbar"
      aria-label="Extra keys"
      // Not the terminal's focus: the on-screen keyboard would close
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {rows.map((row, index) => (
        <div key={index} className="terminal-keys-row">
          {row.map((key, column) => (
            <KeyButton
              key={column}
              extraKey={key}
              state={key.modifier ? modifiers[key.modifier] : 'off'}
              onKey={onKey}
              onModifier={onModifier}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
