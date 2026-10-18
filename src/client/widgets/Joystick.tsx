// A touch/mouse pad: the knob follows the pointer that grabbed it, within the
// pad, and springs back to the centre when released. Several pads work at once,
// one finger each.

import { useEffect, useRef, useState, type PointerEvent } from 'react';

// Knob travel from the centre, in percent of the pad's size
const TRAVEL_PERCENT = 34;
// Around the centre, small offsets read as zero
const DEAD_ZONE = 0.08;

function deadZone(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude < DEAD_ZONE ? 0 : (Math.sign(value) * (magnitude - DEAD_ZONE)) / (1 - DEAD_ZONE);
}

export interface JoystickProps {
  // 'x': horizontal only, 'y': vertical only
  axes: 'xy' | 'x' | 'y';
  // Within -1..1, x to the right, y up
  onMove: (x: number, y: number) => void;
  disabled: boolean;
  label: string;
}

export function Joystick({ axes, onMove, disabled, label }: JoystickProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const move = (x: number, y: number) => {
    setKnob({ x, y });
    onMoveRef.current(deadZone(x), deadZone(y));
  };

  const track = (event: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const travel = (rect.width * TRAVEL_PERCENT) / 100;
    let x = axes === 'y' ? 0 : (event.clientX - (rect.left + rect.width / 2)) / travel;
    let y = axes === 'x' ? 0 : -(event.clientY - (rect.top + rect.height / 2)) / travel;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    move(x, y);
  };

  const release = (event?: PointerEvent) => {
    if (pointerId.current === null || (event && event.pointerId !== pointerId.current)) {
      return;
    }
    pointerId.current = null;
    setActive(false);
    move(0, 0);
  };

  // A pad held while the page is hidden (app switched, screen locked) never
  // gets its pointer up: let go of it
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    const onVisibility = () => document.hidden && releaseRef.current();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (disabled) {
      releaseRef.current();
    }
  }, [disabled]);

  return (
    <div className="joystick-slot">
      <div
        ref={ref}
        className={`joystick${axes === 'x' ? ' horizontal' : axes === 'y' ? ' vertical' : ''}${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
        onPointerDown={(event) => {
          if (disabled || pointerId.current !== null || event.button !== 0) {
            return;
          }
          pointerId.current = event.pointerId;
          setActive(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          track(event);
        }}
        onPointerMove={(event) => event.pointerId === pointerId.current && track(event)}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <div className="joystick-track" />
        <div
          className="joystick-knob"
          style={{
            left: `${50 + knob.x * TRAVEL_PERCENT}%`,
            top: `${50 - knob.y * TRAVEL_PERCENT}%`,
          }}
        />
      </div>
      <span className="joystick-label">{label}</span>
    </div>
  );
}
