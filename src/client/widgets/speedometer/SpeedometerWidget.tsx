// The robot's speed on a dial, from its velocity commands (Twist or
// TwistStamped, e.g. cmd_vel): how fast it is told to go, either way, and how
// fast to turn. A command not renewed within the timeout counts as a stop, as
// base controllers take it (diff_drive_controller's cmd_vel_timeout): the
// latest one may be old, e.g. the last of a publisher gone.

import { useEffect, useMemo, useState } from 'react';

import { useTopic } from '../../connection.ts';
import { SpeedometerIcon } from '../../icons.tsx';
import { defineWidget, type WidgetProps } from '../types.ts';
import {
  DIAL_END,
  DIAL_START,
  dialAngle,
  formatSpeed,
  motionOf,
  scaleTicks,
  STOPPED,
  TWIST,
  TWIST_STAMPED,
} from './model.ts';

interface SpeedometerConfig {
  topic: string;
  maxSpeed: number;
  timeout: number;
}

// Commands a second at most: the needle eases from one to the next
const MAX_RATE = 20;

// The dial in its SVG's units: the centre and radius of the scale's arc. The
// numbers are outside it, where the needle never covers them.
const CX = 100;
const CY = 98;
const R = 72;
const SWEEP = DIAL_END - DIAL_START;

// The point at this angle (degrees clockwise from 12 o'clock) and distance
// from the centre
function polar(angle: number, radius: number): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [CX + radius * Math.sin(radians), CY - radius * Math.cos(radians)];
}

// The whole scale as one arc, SWEEP long (its pathLength): the speed's part of
// it is a dash as long as the needle's angle from the start
const [startX, startY] = polar(DIAL_START, R);
const [endX, endY] = polar(DIAL_END, R);
const ARC = `M${startX} ${startY}A${R} ${R} 0 1 1 ${endX} ${endY}`;

function Tick({ value, max, major }: { value: number; max: number; major: boolean }) {
  const angle = dialAngle(value, max);
  const [x1, y1] = polar(angle, R - 9);
  const [x2, y2] = polar(angle, R - (major ? 19 : 14));
  const [lx, ly] = polar(angle, R + 15);
  return (
    <>
      <line className={`speedometer-tick${major ? ' major' : ''}`} x1={x1} y1={y1} x2={x2} y2={y2} />
      {major && (
        <text className="speedometer-label" x={lx} y={ly}>
          {value}
        </text>
      )}
    </>
  );
}

function Dial({ speed, max }: { speed: number; max: number }) {
  const ticks = useMemo(() => scaleTicks(max), [max]);
  const angle = dialAngle(speed, max);
  const over = Math.abs(speed) > max;
  const text = formatSpeed(speed, max);
  return (
    <svg className="speedometer-dial" viewBox="0 0 200 172" role="img" aria-label={`${text} m/s`}>
      <path className="speedometer-track" d={ARC} pathLength={SWEEP} />
      <path
        className={`speedometer-value${over ? ' over' : ''}`}
        d={ARC}
        pathLength={SWEEP}
        style={{ strokeDasharray: `${angle - DIAL_START} ${SWEEP}` }}
      />
      {ticks.minor.map((value) => (
        <Tick key={`minor-${value}`} value={value} max={max} major={false} />
      ))}
      {ticks.major.map((value) => (
        <Tick key={`major-${value}`} value={value} max={max} major />
      ))}
      <g
        className="speedometer-needle"
        style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${CX}px ${CY}px` }}
      >
        <path d={`M${CX - 3.5} ${CY}L${CX} ${CY - R + 16}L${CX + 3.5} ${CY}Z`} />
        <circle cx={CX} cy={CY} r={7} />
      </g>
      <text className={`speedometer-speed${over ? ' over' : ''}`} x={CX} y={150}>
        {text}
      </text>
      <text className="speedometer-unit" x={CX} y={166}>
        m/s
      </text>
    </svg>
  );
}

function SpeedometerWidget({ config }: WidgetProps<SpeedometerConfig>) {
  const topic = config.topic.trim();
  const { message, messageType, status, error } = useTopic(topic, MAX_RATE);
  const motion = useMemo(() => motionOf(messageType, message), [messageType, message]);

  // Each command stands for the timeout, then the robot is taken as stopped
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (message === null || !(config.timeout > 0)) {
      return;
    }
    const timer = setTimeout(() => setExpired(true), config.timeout * 1000);
    return () => clearTimeout(timer);
  }, [message, config.timeout]);

  let problem: { text: string; error: boolean } | null = null;
  if (!topic) {
    problem = { text: 'No velocity topic: set one in edit mode', error: true };
  } else if (message !== null && !motion) {
    problem = { text: `${topic} is a ${messageType}, not a Twist or TwistStamped`, error: true };
  } else if (status !== 'streaming' && message === null) {
    problem = { text: error || 'Connecting…', error: status === 'error' };
  }
  const shown = motion && !expired ? motion : STOPPED;
  // A panel's file may have any number
  const max = Math.max(0.01, config.maxSpeed);
  return (
    <div className="speedometer">
      <Dial speed={shown.speed} max={max} />
      <div className="speedometer-readout">
        {problem ? (
          <span className={problem.error ? 'error' : undefined}>{problem.text}</span>
        ) : (
          <>
            <span title="Angular velocity, about z">ω {shown.turn.toFixed(2)} rad/s</span>
            <span className="speedometer-topic">{topic}</span>
          </>
        )}
      </div>
    </div>
  );
}

export const speedometerWidget = defineWidget<SpeedometerConfig>({
  type: 'speedometer',
  name: 'Speedometer',
  description: 'The robot’s speed on a dial, from its velocity commands.',
  icon: SpeedometerIcon,
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
  component: SpeedometerWidget,
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: 'cmd_vel',
      topicTypes: [TWIST, TWIST_STAMPED],
      help: 'Velocity commands, Twist or TwistStamped: e.g. those the base controller follows, twist_mux’s output',
    },
    {
      key: 'maxSpeed',
      label: 'Max speed (m/s)',
      kind: 'number',
      default: 1,
      min: 0.01,
      step: 0.05,
      help: 'The end of the scale: faster commands are shown there, in red',
    },
    {
      key: 'timeout',
      label: 'Timeout (s)',
      kind: 'number',
      default: 0.5,
      min: 0,
      step: 0.1,
      help: 'Without a new command for this long the robot is taken as stopped, as base controllers do (cmd_vel_timeout). 0: the latest command stands',
    },
  ],
});
