// The arithmetic of the arm teleop's jogs, apart from ROS (see arm.ts)

// Where a joint may be commanded: its range, if it has one, but never further
// ahead of where it is than `lead`, so that a joint that does not follow (not
// located, held at a limit, stalled) never leaves the command far behind it.
// A command already out of the range may only come back in.
export function clampCommand(
  command: number,
  previous: number,
  position: number,
  range: { lower: number | null; upper: number | null },
  lead: number,
): { value: number; limit: 'lower' | 'upper' | null } {
  let value = command;
  let limit: 'lower' | 'upper' | null = null;
  if (range.lower !== null && value < Math.min(range.lower, previous)) {
    value = Math.min(range.lower, previous);
    limit = 'lower';
  }
  if (range.upper !== null && value > Math.max(range.upper, previous)) {
    value = Math.max(range.upper, previous);
    limit = 'upper';
  }
  return { value: Math.min(position + lead, Math.max(position - lead, value)), limit };
}

// A ROS duration
export function duration(seconds: number): { sec: number; nanosec: number } {
  const sec = Math.floor(seconds);
  return { sec, nanosec: Math.round((seconds - sec) * 1e9) };
}

// A controller's name as its topics start: /arm_controller
export function controllerNamespace(name: string): string {
  return `/${name.trim().replace(/^\/+|\/+$/g, '')}`;
}
