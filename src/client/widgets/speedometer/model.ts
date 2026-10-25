// What a Speedometer shows of a velocity command (Twist or TwistStamped), and
// its dial: a 240° scale from 0 to the max speed, clockwise from the bottom
// left, its ticks at round steps.

export const TWIST = 'geometry_msgs/msg/Twist';
export const TWIST_STAMPED = 'geometry_msgs/msg/TwistStamped';

// Where the scale starts and ends, in degrees clockwise from 12 o'clock
export const DIAL_START = -120;
export const DIAL_END = 120;

export interface Motion {
  // Of the linear velocity, along x and y (sideways, omnidirectional robots
  // only), in m/s: negative going backwards
  speed: number;
  // About z, in rad/s: counterclockwise
  turn: number;
}

export const STOPPED: Motion = { speed: 0, turn: 0 };

function component(vector: unknown, axis: 'x' | 'y' | 'z'): number {
  const value = (vector as Record<string, unknown> | null)?.[axis];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// null: not a velocity command
export function motionOf(messageType: string | null, message: unknown): Motion | null {
  let twist: unknown;
  if (messageType === TWIST) {
    twist = message;
  } else if (messageType === TWIST_STAMPED) {
    twist = (message as { twist?: unknown } | null)?.twist;
  } else {
    return null;
  }
  const { linear, angular } = (twist ?? {}) as { linear?: unknown; angular?: unknown };
  const x = component(linear, 'x');
  const y = component(linear, 'y');
  return { speed: Math.sign(x || 1) * Math.hypot(x, y), turn: component(angular, 'z') };
}

// Where the needle points for this speed, either way: past the max speed, at
// the end of the scale
export function dialAngle(speed: number, max: number): number {
  const fraction = max > 0 ? Math.min(1, Math.abs(speed) / max) : 0;
  return DIAL_START + fraction * (DIAL_END - DIAL_START);
}

// Rounded off the float errors of adding steps up, e.g. 0.30000000000000004
function round(value: number): number {
  return Number(value.toFixed(9));
}

// The scale's labelled ticks, 1, 2, 2.5 or 5 times a power of ten apart, about
// five of them, and the small ones between
export function scaleTicks(max: number): { major: number[]; minor: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) {
    return { major: [0], minor: [] };
  }
  const rough = max / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const factor = [1, 2, 2.5, 5, 10].find((f) => f * power >= rough * (1 - 1e-9)) ?? 10;
  const step = factor * power;
  const minorStep = step / (factor === 2 ? 4 : 5);
  const major: number[] = [];
  const minor: number[] = [];
  for (let i = 0; i * minorStep <= max * (1 + 1e-9); i++) {
    const value = round(i * minorStep);
    (Math.abs(value / step - Math.round(value / step)) < 1e-6 ? major : minor).push(value);
  }
  return { major, minor };
}

// A speed, with fewer decimals on larger scales
export function formatSpeed(speed: number, max: number): string {
  const text = Math.abs(speed).toFixed(max >= 10 ? 1 : 2);
  // No "-0.00"
  return speed < 0 && Number(text) !== 0 ? `−${text}` : text;
}
