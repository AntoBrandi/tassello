// Drives the robot with velocity commands (Twist or TwistStamped). One pad
// (forward x, rotation z), or two in omnidirectional mode (forward x and
// sideways y, rotation z). Streams at the configured rate while a pad is
// held, then one zero; see the server's watchdog in src/server/teleop.ts.

import { useCallback, useEffect, useRef, useState } from 'react';

import { connection, useConnectionStatus } from '../connection.ts';
import { GamepadIcon } from '../icons.tsx';
import { Joystick } from './Joystick.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

interface TeleopConfig {
  topic: string;
  omnidirectional: boolean;
  stamped: boolean;
  frameId: string;
  maxLinear: number;
  maxAngular: number;
  rate: number;
}

// Normalized -1..1: x forward, y to the left, z counterclockwise
interface Axes {
  x: number;
  y: number;
  z: number;
}

const STOPPED: Axes = { x: 0, y: 0, z: 0 };

function isStopped(axes: Axes): boolean {
  return axes.x === 0 && axes.y === 0 && axes.z === 0;
}

function send(config: TeleopConfig, axes: Axes): void {
  connection.send({
    type: 'twist',
    topic: config.topic,
    stamped: config.stamped,
    frameId: config.frameId,
    linear: { x: axes.x * config.maxLinear, y: axes.y * config.maxLinear },
    angular: { z: axes.z * config.maxAngular },
  });
}

function TeleopWidget({ config, editing }: WidgetProps<TeleopConfig>) {
  const online = useConnectionStatus() === 'open';
  const [axes, setAxes] = useState<Axes>(STOPPED);
  const axesRef = useRef<Axes>(STOPPED);
  const configRef = useRef(config);
  configRef.current = config;
  const moving = useRef(false);

  const update = useCallback((change: Partial<Axes>) => {
    const next = { ...axesRef.current, ...change };
    axesRef.current = next;
    setAxes(next);
    // Starting and stopping go out at once, the rest at the rate
    if (!isStopped(next) && !moving.current) {
      moving.current = true;
      send(configRef.current, next);
    } else if (isStopped(next) && moving.current) {
      moving.current = false;
      send(configRef.current, STOPPED);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(
      () => moving.current && send(configRef.current, axesRef.current),
      1000 / Math.min(50, Math.max(1, config.rate)),
    );
    return () => clearInterval(timer);
  }, [config.rate]);

  // Stops the robot on the old topic when it changes while driving, or when
  // the widget goes away
  const { topic, stamped } = config;
  useEffect(
    () => () => {
      if (moving.current) {
        moving.current = false;
        send({ ...configRef.current, topic, stamped }, STOPPED);
      }
    },
    [topic, stamped],
  );

  const disabled = editing || !online;
  const { maxLinear, maxAngular } = config;
  return (
    <div className="teleop">
      <div className={`teleop-pads${config.omnidirectional ? ' two' : ''}`}>
        {config.omnidirectional ? (
          <>
            <Joystick
              axes="xy"
              label="x · y"
              disabled={disabled}
              onMove={(px, py) => update({ x: py, y: -px })}
            />
            <Joystick axes="x" label="z" disabled={disabled} onMove={(px) => update({ z: -px })} />
          </>
        ) : (
          <Joystick
            axes="xy"
            label="x · z"
            disabled={disabled}
            onMove={(px, py) => update({ x: py, y: 0, z: -px })}
          />
        )}
      </div>
      <div className="teleop-readout">
        {online || editing ? (
          <>
            <span>x {(axes.x * maxLinear).toFixed(3)}</span>
            {config.omnidirectional && <span>y {(axes.y * maxLinear).toFixed(3)}</span>}
            <span>z {(axes.z * maxAngular).toFixed(3)}</span>
            <span className="teleop-topic">{config.topic}</span>
          </>
        ) : (
          <span className="offline">Disconnected</span>
        )}
      </div>
    </div>
  );
}

export const teleopWidget = defineWidget<TeleopConfig>({
  type: 'teleop',
  name: 'Teleop',
  description: 'Drive the robot with on-screen pads, publishing velocity commands.',
  icon: GamepadIcon,
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  component: TeleopWidget,
  properties: [
    {
      key: 'topic',
      label: 'Topic',
      kind: 'topic',
      default: 'cmd_vel',
      topicTypes: ['geometry_msgs/msg/Twist', 'geometry_msgs/msg/TwistStamped'],
      help: 'With twist_mux, one of its inputs, above autonomous navigation and below the joysticks',
    },
    {
      key: 'omnidirectional',
      label: 'Omnidirectional',
      kind: 'boolean',
      default: false,
      help: 'Two pads: x and y, and z. Otherwise one: x and z',
    },
    {
      key: 'stamped',
      label: 'TwistStamped',
      kind: 'boolean',
      default: false,
      help: 'Publish geometry_msgs/TwistStamped instead of Twist',
    },
    {
      key: 'frameId',
      label: 'Frame id',
      kind: 'string',
      default: 'base_link',
      visible: (config) => config.stamped,
    },
    {
      key: 'maxLinear',
      label: 'Max linear speed (m/s)',
      kind: 'number',
      default: 0.2,
      min: 0,
      step: 0.01,
    },
    {
      key: 'maxAngular',
      label: 'Max angular speed (rad/s)',
      kind: 'number',
      default: 0.5,
      min: 0,
      step: 0.01,
    },
    {
      key: 'rate',
      label: 'Rate (Hz)',
      kind: 'number',
      default: 10,
      min: 1,
      max: 50,
      step: 1,
      help: 'How often the command is published while a pad is held',
    },
  ],
});
