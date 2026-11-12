// Who may do what: the users' roles, the role each message of the pages needs
// (the server enforces it, the page only hides what a role cannot use), and
// the REST API of the sign-in (src/server/auth.ts).
//
//   GET    /api/auth/session            AuthStatus, signed in or not
//   POST   /api/auth/login              {username, password} -> AuthStatus
//   POST   /api/auth/logout
//   POST   /api/auth/password           {current, password}: one's own
//   GET    /api/auth/users              [UserInfo], administrators only
//   POST   /api/auth/users              {username, displayName, role, password}
//   PATCH  /api/auth/users/<username>   {displayName?, role?, password?, disabled?}
//   DELETE /api/auth/users/<username>

import type { ClientMessage } from './protocol.ts';

// Each can do what those before it can
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  admin: 'Administrator',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Watches: cameras, maps, logs, diagnostics, plots, parameters',
  operator: 'Drives and operates: teleop, goals, buttons, topics, services, parameters, rosbags',
  admin: 'Everything: panels, terminals, files, networks, behavior tree files, users',
};

export function isRole(value: unknown): value is Role {
  return ROLES.includes(value as Role);
}

export function roleAtLeast(role: Role, needed: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

// Who is signed in, as the pages and the plugins see them
export interface AuthUser {
  username: string;
  displayName: string;
  role: Role;
  // Where the account comes from: 'local' (Tassello's own users), 'none'
  // (sign-in turned off)
  provider: string;
}

// A user as the administrators list them
export interface UserInfo {
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  // ISO times
  created: string;
  passwordChanged: string;
  lastLogin: string | null;
  // Their password was made for them (the default administrator's, or set by
  // an administrator): they choose their own before anything else
  mustChangePassword: boolean;
}

export interface AuthStatus {
  // false: anyone who opens the page is an administrator (--no-auth)
  enabled: boolean;
  // null: not signed in
  user: AuthUser | null;
  // Not signed in, watching as a viewer (--anonymous-role viewer): signing in
  // operates
  anonymous: boolean;
  // The user signed in must choose a new password before anything else
  mustChangePassword: boolean;
  hostname: string;
  minPasswordLength: number;
}

// What usernames may be: an email address too, for the identity providers
// to come
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,63}$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export const MIN_PASSWORD_LENGTH = 12;
// scrypt hashes any length, but a megabyte is only a way to make it work hard
export const MAX_PASSWORD_LENGTH = 256;

// What is wrong with a new password, null if nothing. Length over
// composition rules, as NIST SP 800-63B and OWASP ASVS ask.
export function passwordProblem(password: string, username: string): string | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `At least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `At most ${MAX_PASSWORD_LENGTH} characters`;
  }
  const lower = password.toLowerCase();
  const name = normalizeUsername(username);
  if (name && lower.includes(name)) {
    return 'It must not contain the username';
  }
  if (new Set(lower).size < 4) {
    return 'Too repetitive';
  }
  // Little more than a common one: Password1234!
  if (COMMON.some((common) => lower.includes(common)) && lower.replace(COMMON_PATTERN, '').length < 8) {
    return 'Too common';
  }
  return null;
}

// Passwords' usual bases: a password that is little more than one of them
const COMMON = ['password', 'passw0rd', 'qwerty', 'azerty', '123456', 'abcdef', 'letmein', 'welcome', 'admin', 'tassello', 'robot'];
const COMMON_PATTERN = new RegExp(COMMON.join('|'), 'g');

// The role each message needs. A Record, so that a new message type does not
// compile until it says which.
const MESSAGE_ROLES: Record<ClientMessage['type'], Role> = {
  // Watching
  'image.subscribe': 'viewer',
  'grid.subscribe': 'viewer',
  'tf.subscribe': 'viewer',
  'path.subscribe': 'viewer',
  'overlay.subscribe': 'viewer',
  'topic.subscribe': 'viewer',
  'services.subscribe': 'viewer',
  'logs.subscribe': 'viewer',
  unsubscribe: 'viewer',
  'frame.ack': 'viewer',
  'arm.subscribe': 'viewer',
  'plugin.subscribe': 'viewer',
  'bt.subscribe': 'viewer',
  // Played in the widget, nothing published
  'bt.playback': 'viewer',
  'bt.playback.control': 'viewer',

  'rosout.subscribe': 'viewer',
  'diagnostics.subscribe': 'viewer',
  'graph.subscribe': 'viewer',
  'topic.info.subscribe': 'viewer',
  'topic.monitor': 'viewer',
  'interface.get': 'viewer',
  'action.subscribe': 'viewer',
  'params.subscribe': 'viewer',
  'params.dump': 'viewer',
  'bags.subscribe': 'viewer',
  'system.subscribe': 'viewer',
  'points.subscribe': 'viewer',
  'octomap.subscribe': 'viewer',
  'tf.frames': 'viewer',
  'twistmux.subscribe': 'viewer',
  // The addresses, interfaces and networks in range
  'network.subscribe': 'operator',
  // A file of the robot, whole: the File Manager's is an operator's too
  'bt.file.subscribe': 'operator',
  // Operating the robot
  twist: 'operator',
  pose: 'operator',
  'arm.jog': 'operator',
  'command.run': 'operator',
  'command.stop': 'operator',
  'service.action': 'operator',
  'ros.publish': 'operator',
  'ros.call': 'operator',
  'topic.publish': 'operator',
  'action.send': 'operator',
  'action.cancel': 'operator',
  'params.set': 'operator',
  'params.load': 'operator',
  // A twist_mux's locks, its joystick relay's turbo and priority
  'twistmux.control': 'operator',
  'bt.record': 'operator',
  'bags.action': 'operator',
  // Each plugin handler's own role is checked by the PluginHost: an
  // operator's unless it says otherwise
  'plugin.request': 'viewer',
  // The robot's system: a shell, its networks, its files
  'terminal.open': 'admin',
  'terminal.input': 'admin',
  'terminal.resize': 'admin',
  'terminal.ack': 'admin',
  'terminal.restart': 'admin',
  'network.action': 'admin',
  'bt.file.save': 'admin',
};

// Why a message or a request is refused for the user's role: the page shows
// it as it is
const NOT_ALLOWED = 'Not allowed for your role';

// A refusal for the role, as the server words it: not worth trying again
export function isNotAllowed(message: string): boolean {
  return message.startsWith(NOT_ALLOWED);
}

export function notAllowedMessage(needed: Role): string {
  return `${NOT_ALLOWED}: it takes ${needed === 'admin' ? 'an administrator' : `an ${ROLE_LABELS[needed].toLowerCase()}`}`;
}

// The role a message needs; unknown ones, the highest
export function requiredRole(message: ClientMessage): Role {
  const action = (message as { request?: { action?: unknown } }).request?.action;
  if (message.type === 'network.action' && action === 'rescan') {
    return 'operator';
  }
  if (message.type === 'bags.action' && action === 'delete') {
    return 'admin';
  }
  // Own keys only: not toString's
  return Object.hasOwn(MESSAGE_ROLES, message.type) ? MESSAGE_ROLES[message.type] : 'admin';
}
