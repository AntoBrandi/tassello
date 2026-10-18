// Jogs the arm. In joint mode, one
// slider per joint of its trajectory controllers: held off centre, the joint
// moves, faster the further; released, it springs back and the joint stops.
// In Cartesian mode, two pads move the end effector along the robot's x and y,
// and z, through move_group's IK; the joints of the other controllers (the
// gripper) keep their sliders. The server streams the controllers positions
// just ahead of the arm, see src/server/arm.ts.

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import type { ArmJointState, ArmUpdate } from '../../shared/protocol.ts';
import { connection, useConnectionStatus } from '../connection.ts';
import { ArmIcon } from '../icons.tsx';
import { Joystick } from './Joystick.tsx';
import { defineWidget, type WidgetProps } from './types.ts';

interface ArmTeleopConfig {
  cartesian: boolean;
  controllers: string;
  jointSpeed: number;
  cartesianSpeed: number;
  group: string;
  link: string;
  frameId: string;
  rate: number;
  jointStatesTopic: string;
  descriptionTopic: string;
  calibrationTopic: string;
}

interface Vector {
  x: number;
  y: number;
  z: number;
}

const STILL: Vector = { x: 0, y: 0, z: 0 };
// Around the centre, small deflections read as zero
const DEAD_ZONE = 0.06;

function degrees(radians: number): string {
  // No -0.0
  return `${((radians * 180) / Math.PI).toFixed(1).replace(/^-(0\.0)$/, '$1')}°`;
}

function controllerNames(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

// A slider that springs back to the centre: its deflection, -1..1, is the
// speed, finer near the centre
function JogSlider({ disabled, onChange }: { disabled: boolean; onChange: (deflection: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const [knob, setKnob] = useState(0);
  const [active, setActive] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const move = (value: number) => {
    setKnob(value);
    const magnitude = Math.max(0, (Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE));
    onChangeRef.current(Math.sign(value) * magnitude * magnitude);
  };
  const track = (event: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const half = rect.width / 2;
    move(Math.max(-1, Math.min(1, (event.clientX - (rect.left + half)) / half)));
  };
  const release = (event?: PointerEvent) => {
    if (pointerId.current === null || (event && event.pointerId !== pointerId.current)) {
      return;
    }
    pointerId.current = null;
    setActive(false);
    move(0);
  };
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
    <div
      ref={ref}
      className={`jog-slider${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
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
      <div className="jog-slider-track" />
      <div className="jog-slider-knob" style={{ left: `${50 + knob * 46}%` }} />
    </div>
  );
}

// Where the joint is within its range
function RangeBar({ joint }: { joint: ArmJointState }) {
  const { position, lower, upper } = joint;
  if (position === null || lower === null || upper === null || upper <= lower) {
    return <div className="arm-range empty" />;
  }
  const at = (value: number) => `${Math.max(0, Math.min(100, ((value - lower) / (upper - lower)) * 100))}%`;
  return (
    <div className="arm-range" title={`${degrees(lower)} … ${degrees(upper)}`}>
      {lower < 0 && upper > 0 && <div className="arm-range-zero" style={{ left: at(0) }} />}
      <div className="arm-range-position" style={{ left: at(position) }} />
    </div>
  );
}

function JointRow({
  joint,
  disabled,
  onChange,
}: {
  joint: ArmJointState;
  disabled: boolean;
  onChange: (deflection: number) => void;
}) {
  const refusal = joint.drivable ? '' : joint.located ? 'Not driven by the hardware' : 'Not located: calibrate it';
  return (
    <div className={`arm-joint${joint.drivable ? '' : ' undriven'}`} title={refusal}>
      <span className="arm-joint-name">{joint.name}</span>
      <JogSlider disabled={disabled || !joint.drivable} onChange={onChange} />
      <div className="arm-joint-readout">
        <span className={joint.located ? '' : 'relative'}>
          {joint.position === null ? '–' : degrees(joint.position)}
        </span>
        <RangeBar joint={joint} />
      </div>
    </div>
  );
}

function ArmTeleopWidget({ config, editing }: WidgetProps<ArmTeleopConfig>) {
  const online = useConnectionStatus() === 'open';
  const [arm, setArm] = useState<ArmUpdate | null>(null);
  const armId = useRef<number | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  // Deflections, -1..1
  const joints = useRef<Record<string, number>>({});
  const cartesian = useRef<Vector>(STILL);
  const moving = useRef(false);

  const { controllers, jointStatesTopic, descriptionTopic, calibrationTopic } = config;
  useEffect(() => {
    setArm(null);
    const { id, unsubscribe } = connection.subscribeArm(
      { controllers: controllerNames(controllers), jointStatesTopic, descriptionTopic, calibrationTopic },
      setArm,
    );
    armId.current = id;
    return () => {
      armId.current = null;
      unsubscribe();
    };
  }, [controllers, jointStatesTopic, descriptionTopic, calibrationTopic]);

  const send = useCallback(() => {
    const { jointSpeed, cartesianSpeed, group, link, frameId } = configRef.current;
    if (armId.current === null) {
      return;
    }
    const speeds: Record<string, number> = {};
    for (const [name, deflection] of Object.entries(joints.current)) {
      speeds[name] = deflection * jointSpeed;
    }
    const c = cartesian.current;
    connection.send({
      type: 'arm.jog',
      id: armId.current,
      joints: speeds,
      cartesian: { x: c.x * cartesianSpeed, y: c.y * cartesianSpeed, z: c.z * cartesianSpeed },
      ik: { group, link, frameId },
    });
  }, []);

  // Starting and stopping go out at once, the rest at the rate
  const changed = useCallback(() => {
    const active =
      Object.values(joints.current).some((v) => v !== 0) || Object.values(cartesian.current).some((v) => v !== 0);
    if (active !== moving.current) {
      moving.current = active;
      send();
    }
  }, [send]);

  useEffect(() => {
    const timer = setInterval(() => moving.current && send(), 1000 / Math.min(50, Math.max(1, config.rate)));
    return () => clearInterval(timer);
  }, [config.rate, send]);

  // Released when the mode changes, or the widget goes away
  const stop = useCallback(() => {
    joints.current = {};
    cartesian.current = STILL;
    if (moving.current) {
      moving.current = false;
      send();
    }
  }, [send]);
  useEffect(() => stop, [config.cartesian, stop]);

  const setJoint = (name: string, deflection: number) => {
    joints.current = { ...joints.current, [name]: deflection };
    changed();
  };
  const setCartesian = (change: Partial<Vector>) => {
    cartesian.current = { ...cartesian.current, ...change };
    changed();
  };

  const disabled = editing || !online;
  const allJoints = arm?.joints ?? [];
  // In Cartesian mode the pads move the first controller's joints
  const firstController = controllerNames(config.controllers)[0];
  const sliderJoints = config.cartesian ? allJoints.filter((j) => j.controller !== firstController) : allJoints;
  const anyDrivable = allJoints.some((j) => j.drivable);

  let status: { text: string; className: string };
  if (!online) {
    status = { text: 'Disconnected', className: 'error' };
  } else if (!arm) {
    status = { text: 'Connecting…', className: '' };
  } else if (arm.jog.state === 'blocked') {
    status = { text: arm.jog.message, className: 'error' };
  } else if (arm.problems.length > 0) {
    status = { text: arm.problems.join(' · '), className: 'error' };
  } else if (arm.jog.state === 'moving') {
    status = { text: 'Moving…', className: 'active' };
  } else {
    status = {
      text: config.cartesian
        ? `Pads: x forward, y left, z up (${config.frameId}). Release to stop`
        : 'Hold a slider off centre to move its joint, release to stop',
      className: '',
    };
  }

  return (
    <div className="arm-teleop">
      {arm?.calibrating && <div className="arm-banner">Calibrating: the joints' limits are lifted</div>}
      {config.cartesian && (
        <div className="teleop-pads two arm-pads">
          <Joystick
            axes="xy"
            label="x · y"
            disabled={disabled || !anyDrivable}
            onMove={(px, py) => setCartesian({ x: py, y: -px })}
          />
          <Joystick
            axes="y"
            label="z"
            disabled={disabled || !anyDrivable}
            onMove={(_, py) => setCartesian({ z: py })}
          />
        </div>
      )}
      {sliderJoints.length > 0 && (
        <div className={`arm-joints${config.cartesian ? ' compact' : ''}`}>
          {sliderJoints.map((joint) => (
            <JointRow
              key={joint.name}
              joint={joint}
              disabled={disabled}
              onChange={(deflection) => setJoint(joint.name, deflection)}
            />
          ))}
        </div>
      )}
      {arm && allJoints.length === 0 && arm.problems.length === 0 && (
        <div className="widget-message">No joints in {config.controllers}</div>
      )}
      <div className={`arm-status ${status.className}`} title={status.text}>
        {status.text}
      </div>
    </div>
  );
}

export const armTeleopWidget = defineWidget<ArmTeleopConfig>({
  type: 'arm-teleop',
  name: 'Arm Teleop',
  description: 'Jog the arm: a slider per joint, or the end effector along x, y and z.',
  icon: ArmIcon,
  defaultSize: { w: 5, h: 5 },
  minSize: { w: 3, h: 3 },
  component: ArmTeleopWidget,
  properties: [
    {
      key: 'cartesian',
      label: 'Cartesian mode',
      kind: 'boolean',
      default: false,
      help: 'Pads moving the end effector along x, y and z, through MoveIt. Otherwise a slider per joint',
    },
    {
      key: 'controllers',
      label: 'Trajectory controllers',
      kind: 'string',
      default: 'arm_controller',
      help: 'Their joints get a slider each. In Cartesian mode the pads move the first one, the others keep their sliders',
    },
    {
      key: 'jointSpeed',
      label: 'Joint speed (rad/s)',
      kind: 'number',
      default: 0.3,
      min: 0.01,
      max: 2,
      step: 0.05,
      help: 'With a slider at its end; slower nearer the centre',
    },
    {
      key: 'cartesianSpeed',
      label: 'Cartesian speed (m/s)',
      kind: 'number',
      default: 0.03,
      min: 0.005,
      max: 0.3,
      step: 0.005,
      visible: (config) => config.cartesian,
    },
    {
      key: 'group',
      label: 'Planning group',
      kind: 'string',
      default: 'arm',
      visible: (config) => config.cartesian,
    },
    {
      key: 'link',
      label: 'End effector link',
      kind: 'string',
      default: 'tool0',
      help: 'The IK tip of the planning group, whose position the pads move (keeping its orientation free)',
      visible: (config) => config.cartesian,
    },
    {
      key: 'frameId',
      label: 'Frame of the pads',
      kind: 'string',
      default: 'base_link',
      visible: (config) => config.cartesian,
    },
    {
      key: 'rate',
      label: 'Rate (Hz)',
      kind: 'number',
      default: 20,
      min: 5,
      max: 50,
      step: 1,
      help: 'How often the jog is sent while held',
    },
    {
      key: 'jointStatesTopic',
      label: 'Joint states topic',
      kind: 'topic',
      default: '/joint_states',
      topicTypes: ['sensor_msgs/msg/JointState'],
    },
    {
      key: 'descriptionTopic',
      label: 'Robot description topic',
      kind: 'topic',
      default: '/robot_description',
      topicTypes: ['std_msgs/msg/String'],
      help: "The joints' limits, unless the calibration state gives them",
    },
    {
      key: 'calibrationTopic',
      label: 'Calibration state topic',
      kind: 'topic',
      default: '',
      placeholder: 'none',
      topicTypes: ['std_msgs/msg/String'],
      help: "Optional: a hardware interface's calibration state (JSON, see the README), whose limits replace the URDF's",
    },
  ],
});
