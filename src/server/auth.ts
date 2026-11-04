// Signing in: who the requests and the WebSockets come from, and the REST API
// of the sign-in and of the users (see src/shared/auth.ts).
//
// A sign-in opens a session: 32 random bytes in an HttpOnly, SameSite=Strict
// cookie (Secure over HTTPS), named after the port, as robots on one host
// share cookies. The server keeps the SHA-256 of each, never the token
// itself, in sessions.json next to the users (0600), so that a restart signs
// no one out. A session ends when signed out, after IDLE_MS without a request
// or a message from its pages, SESSION_MS after the sign-in, or when its
// user's password changes, or the user is disabled or removed.
//
// Failed sign-ins slow down, by username and by address: after a few, each
// waits twice as long as the one before, up to 15 minutes. Unknown usernames
// take as long as known ones, and get the same answer.
//
// A robot without users gets one, admin, an administrator whose password is
// made at random and written in initial-admin-password (0600) next to the
// users; the log says where, never what. Signed in with it, they choose their
// own before anything else, as anyone whose password an administrator made:
// until then, their session can only change it. TASSELLO_ADMIN_PASSWORD gives
// that first password instead (a fleet's provisioning), not to be changed.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import {
  isRole,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  roleAtLeast,
  type AuthStatus,
  type AuthUser,
  type Role,
} from '../shared/auth.ts';
import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';
import { HttpError } from './panels.ts';
import { hashPassword, needsRehash, verifyNothing, verifyPassword } from './passwords.ts';
import { checkUsername, publicUser, type StoredUser, type UserStore } from './users.ts';
import { errorMessage, ownPage, type Logger } from './util.ts';

export const DEFAULT_IDLE_HOURS = 12;
const SESSION_MS = 7 * 24 * 3600_000;
// lastSeen is saved at most this often
const TOUCH_MS = 60_000;
const SAVE_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export const DEFAULT_ADMIN = 'admin';
export const INITIAL_PASSWORD_FILE = 'initial-admin-password';
// The default administrator's first password, if given
const ADMIN_PASSWORD_VARIABLE = 'TASSELLO_ADMIN_PASSWORD';

// Who anyone is without sign-in (--no-auth)
const ANONYMOUS: AuthUser = { username: 'anonymous', displayName: 'Anyone', role: 'admin', provider: 'none' };

interface StoredSession {
  username: string;
  // ms since the epoch
  created: number;
  lastSeen: number;
  // The user's passwordChanged when signed in: a later password ends it
  passwordChanged: string;
  address: string;
  agent: string;
}

// Who a request comes from, and their session (null without sign-in)
export interface Identity {
  user: AuthUser;
  session: string | null;
  // Their password was made for them: they can only change it
  mustChangePassword: boolean;
}

export interface AuthOptions {
  // false: no sign-in, everyone an administrator
  enabled: boolean;
  users: UserStore;
  // sessions.json's and initial-admin-password's folder
  dir: string;
  port: number;
  // Served over HTTPS: the cookie is Secure
  tls: boolean;
  idleHours: number;
  hostname: string;
  logger: Logger;
}

// ── Failed attempts ──

const FREE_FAILURES = { user: 5, address: 20 };
const FIRST_WAIT_MS = 1000;
const MAX_WAIT_MS = 15 * 60_000;
// Failures forgotten after this long without another
const FORGET_MS = 24 * 3600_000;
const MAX_ENTRIES = 10_000;

export class Throttle {
  private readonly entries = new Map<string, { failures: number; last: number }>();
  private readonly free: number;

  constructor(free: number) {
    this.free = free;
  }

  // How long until the next attempt (0: now)
  waitMs(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry || entry.failures < this.free) {
      return 0;
    }
    const wait = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (entry.failures - this.free));
    return Math.max(0, entry.last + wait - now);
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.entries.get(key);
    const failures = entry && now - entry.last < FORGET_MS ? entry.failures + 1 : 1;
    this.entries.delete(key);
    this.entries.set(key, { failures, last: now });
    // The oldest go first
    for (const old of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) {
        break;
      }
      this.entries.delete(old);
    }
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }
}

// ── Cookies ──

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) {
      const name = part.slice(0, at).trim();
      if (!cookies.has(name)) {
        cookies.set(name, part.slice(at + 1).trim());
      }
    }
  }
  return cookies;
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 16 characters of 64 (which divides 256: each as likely), 96 bits
export function randomPassword(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
}

function authUser(user: StoredUser): AuthUser {
  return { username: user.username, displayName: user.displayName, role: user.role, provider: 'local' };
}

function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// Emits 'changed' (username) when what a user may do changed, or their
// sessions ended: their pages connect again, as who they are now
export class Auth extends EventEmitter<{ changed: [username: string] }> {
  readonly enabled: boolean;
  private readonly options: AuthOptions;
  private readonly users: UserStore;
  private readonly cookieName: string;
  private readonly sessionsFile: string;
  private readonly idleMs: number;
  private sessions = new Map<string, StoredSession>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly byUser = new Throttle(FREE_FAILURES.user);
  private readonly byAddress = new Throttle(FREE_FAILURES.address);

  constructor(options: AuthOptions) {
    super();
    this.options = options;
    this.enabled = options.enabled;
    this.users = options.users;
    this.cookieName = `tassello_session_${options.port}`;
    this.sessionsFile = path.join(options.dir, 'sessions.json');
    this.idleMs = options.idleHours * 3600_000;
    this.users.on('changed', (username) => this.emit('changed', username));
  }

  async init(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.users.load();
    try {
      const data = JSON.parse(await fs.readFile(this.sessionsFile, 'utf8')) as Record<string, StoredSession>;
      const now = Date.now();
      this.sessions = new Map(Object.entries(data).filter(([, session]) => this.alive(session, now)));
    } catch {
      this.sessions = new Map();
    }
    this.saveTimer = setInterval(() => void this.save(), SAVE_MS);
    this.saveTimer.unref();
    await this.createDefaultAdmin();
  }

  // Without users: admin, with a password made at random (written where only
  // the server's user reads it) or given by TASSELLO_ADMIN_PASSWORD
  private async createDefaultAdmin(): Promise<void> {
    if (!this.users.isEmpty()) {
      return;
    }
    const { logger } = this.options;
    const given = process.env[ADMIN_PASSWORD_VARIABLE];
    if (given !== undefined) {
      const problem = passwordProblem(given, DEFAULT_ADMIN);
      if (problem) {
        throw new Error(`${ADMIN_PASSWORD_VARIABLE}: ${problem}`);
      }
    }
    const password = given ?? randomPassword();
    const file = path.join(this.options.dir, INITIAL_PASSWORD_FILE);
    try {
      await this.users.add({
        username: DEFAULT_ADMIN,
        displayName: 'Administrator',
        role: 'admin',
        password,
        mustChangePassword: given === undefined,
      });
    } catch (e) {
      // Another server of the same users made one meanwhile
      if (e instanceof HttpError && e.status === 409) {
        return;
      }
      throw e;
    }
    if (given !== undefined) {
      logger.info(`Created the user ${DEFAULT_ADMIN}, an administrator, with the password of ${ADMIN_PASSWORD_VARIABLE}`);
      return;
    }
    await fs.writeFile(file, `${password}\n`, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    logger.warn(
      `No users yet: created the user ${DEFAULT_ADMIN}, an administrator. Its password is in ${file} ` +
        `(cat it as the server's user); signed in, it is changed at once.`,
    );
  }

  async stop(): Promise<void> {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    await this.save();
  }

  // ── Who it is ──

  // Who the request comes from; null if not signed in
  async identify(req: IncomingMessage): Promise<Identity | null> {
    if (!this.enabled) {
      return { user: ANONYMOUS, session: null, mustChangePassword: false };
    }
    const token = parseCookies(req.headers.cookie).get(this.cookieName);
    if (!token || token.length > 128) {
      return null;
    }
    const key = tokenKey(token);
    const user = await this.sessionUser(key);
    if (!user) {
      return null;
    }
    this.touch(key);
    return { user: authUser(user), session: key, mustChangePassword: user.mustChangePassword };
  }

  // The user of a session, if it is still one; ends it otherwise
  async lookup(key: string): Promise<AuthUser | null> {
    if (!this.enabled) {
      return ANONYMOUS;
    }
    const user = await this.sessionUser(key);
    return user && authUser(user);
  }

  private async sessionUser(key: string): Promise<StoredUser | null> {
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }
    await this.users.reload().catch((e: unknown) => this.options.logger.error(`Users: ${errorMessage(e)}`));
    const user = this.users.get(session.username);
    if (!user || user.disabled || user.passwordChanged !== session.passwordChanged || !this.alive(session)) {
      this.end(key);
      return null;
    }
    return user;
  }

  // Its pages are in use: the session is not idle
  touch(key: string): void {
    const session = this.sessions.get(key);
    const now = Date.now();
    if (session && now - session.lastSeen > TOUCH_MS) {
      session.lastSeen = now;
      this.dirty = true;
    }
  }

  // Whether a page's WebSocket may open: from the dashboard's own pages (a
  // browser lets another site's open WebSockets anywhere), for a signed-in
  // user. Else the HTTP status it is refused with.
  async verifyUpgrade(req: IncomingMessage): Promise<Identity | { status: number; reason: string }> {
    if (!ownPage(req.headers)) {
      this.options.logger.warn(
        `WebSocket refused: from another site's page (${JSON.stringify(req.headers.origin)}), at ${clientAddress(req)}`,
      );
      return { status: 403, reason: 'Only from the dashboard’s pages' };
    }
    const identity = await this.identify(req);
    if (identity?.mustChangePassword) {
      return { status: 403, reason: 'Choose a new password first' };
    }
    return identity ?? { status: 401, reason: 'Sign in first' };
  }

  // Throws unless the request comes from a user of at least that role
  async require(req: IncomingMessage, role: Role): Promise<Identity> {
    const identity = await this.identify(req);
    if (!identity) {
      throw new HttpError(401, 'Sign in first');
    }
    if (identity.mustChangePassword) {
      throw new HttpError(403, 'Choose a new password first');
    }
    if (!roleAtLeast(identity.user.role, role)) {
      throw new HttpError(403, `Only for ${role === 'admin' ? 'administrators' : `${role}s and above`}`);
    }
    return identity;
  }

  // ── The REST API: /api/auth/<route> ──

  async handle(req: IncomingMessage, res: ServerResponse, route: string[]): Promise<void> {
    const method = req.method ?? 'GET';
    const [resource, name, ...rest] = route;
    if (method !== 'GET' && typeof req.headers[DASHBOARD_CLIENT_HEADER.toLowerCase()] !== 'string') {
      // Another site's page cannot send the header: no sign-in through it
      throw new HttpError(403, 'Only from the dashboard’s pages');
    }
    if (resource === 'session' && name === undefined && method === 'GET') {
      return send(res, 200, await this.status(req));
    }
    if (!this.enabled) {
      throw new HttpError(404, 'Sign-in is turned off (--no-auth)');
    }
    if (resource === 'login' && name === undefined && method === 'POST') {
      return this.login(req, res);
    }
    if (resource === 'logout' && name === undefined && method === 'POST') {
      return this.logout(req, res);
    }
    if (resource === 'password' && name === undefined && method === 'POST') {
      return this.changeOwnPassword(req, res);
    }
    if (resource === 'users' && rest.length === 0) {
      const { user } = await this.require(req, 'admin');
      return this.manageUsers(req, res, method, name, user);
    }
    throw new HttpError(404, `No API at ${req.url}`);
  }

  private async status(req: IncomingMessage): Promise<AuthStatus> {
    const identity = await this.identify(req);
    return {
      enabled: this.enabled,
      user: identity?.user ?? null,
      mustChangePassword: identity?.mustChangePassword ?? false,
      hostname: this.options.hostname,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    let username: string;
    try {
      username = checkUsername(body.username);
    } catch {
      username = '';
    }
    const address = clientAddress(req);
    this.checkThrottle(username, address);

    await this.users.reload();
    const user = username ? this.users.get(username) : undefined;
    const valid = user ? await verifyPassword(password, user.password) : await verifyNothing(password);
    if (!user || !valid || user.disabled) {
      this.byUser.fail(username || '');
      this.byAddress.fail(address);
      this.options.logger.warn(
        `Sign-in refused: ${JSON.stringify(username || String(body.username).slice(0, 64))} from ${address}${user?.disabled && valid ? ' (disabled)' : ''}`,
      );
      // The same answer whatever was wrong
      throw new HttpError(401, 'Wrong username or password');
    }
    this.byUser.succeed(username);
    this.byAddress.succeed(address);
    await this.users.recordLogin(user.username, needsRehash(user.password) ? await hashPassword(password) : null);
    this.options.logger.info(`Signed in: ${user.username} (${user.role}) from ${address}`);
    this.startSession(req, res, this.users.get(user.username) ?? user);
    send(res, 200, this.statusFor(this.users.get(user.username) ?? user));
  }

  private checkThrottle(username: string, address: string): void {
    const wait = Math.max(this.byUser.waitMs(username), this.byAddress.waitMs(address));
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpError(429, `Too many failed attempts: try again in ${seconds} s`, { 'Retry-After': String(seconds) });
    }
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identity = await this.identify(req);
    if (identity?.session) {
      this.end(identity.session);
      this.options.logger.info(`Signed out: ${identity.user.username}`);
      this.emit('changed', identity.user.username);
    }
    res.setHeader('Set-Cookie', this.cookie(req, '', 0));
    res.writeHead(204).end();
  }

  private async changeOwnPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Not require(): those who must change it may
    const identity = await this.identify(req);
    if (!identity) {
      throw new HttpError(401, 'Sign in first');
    }
    const body = await readJson(req);
    const address = clientAddress(req);
    const { username } = identity.user;
    this.checkThrottle(username, address);
    const user = this.users.get(username);
    if (!user || !(await verifyPassword(String(body.current ?? ''), user.password))) {
      this.byUser.fail(username);
      this.byAddress.fail(address);
      throw new HttpError(403, 'The current password is wrong');
    }
    const next = String(body.password ?? '');
    if (next === body.current) {
      throw new HttpError(400, 'Choose another password than the current one');
    }
    const changed = await this.users.update(username, { password: next });
    if (username === DEFAULT_ADMIN) {
      await this.forgetInitialPassword();
    }
    // Every other session of theirs ends; this one goes on
    this.endSessionsOf(username, identity.session);
    const session = identity.session ? this.sessions.get(identity.session) : undefined;
    if (session) {
      session.passwordChanged = changed.passwordChanged;
      this.dirty = true;
      void this.save();
    }
    this.options.logger.info(`Password changed: ${username}, from ${address}`);
    res.writeHead(204).end();
  }

  private async manageUsers(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    name: string | undefined,
    admin: AuthUser,
  ): Promise<void> {
    const { logger } = this.options;
    if (name === undefined && method === 'GET') {
      await this.users.reload();
      return send(res, 200, this.users.list().map(publicUser));
    }
    if (name === undefined && method === 'POST') {
      const body = await readJson(req);
      const user = await this.users.add({
        username: String(body.username ?? ''),
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        role: isRole(body.role) ? body.role : ('' as Role),
        password: String(body.password ?? ''),
        // Theirs to choose
        mustChangePassword: true,
      });
      logger.info(`User added by ${admin.username}: ${user.username} (${user.role})`);
      return send(res, 201, publicUser(user));
    }
    if (name !== undefined && method === 'PATCH') {
      const body = await readJson(req);
      const user = await this.users.update(name, {
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        role: body.role === undefined ? undefined : isRole(body.role) ? body.role : ('' as Role),
        password: body.password === undefined ? undefined : String(body.password),
        // A password an administrator made: theirs to change
        mustChangePassword: body.password !== undefined,
        disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
      });
      if (body.password !== undefined || user.disabled) {
        this.endSessionsOf(user.username, null);
      }
      const what = Object.keys(body).filter((key) => ['displayName', 'role', 'password', 'disabled'].includes(key));
      logger.info(`User changed by ${admin.username}: ${user.username} (${what.join(', ')})`);
      return send(res, 200, publicUser(user));
    }
    if (name !== undefined && method === 'DELETE') {
      await this.users.remove(name);
      this.endSessionsOf(name.toLowerCase(), null);
      if (name.toLowerCase() === DEFAULT_ADMIN) {
        await this.forgetInitialPassword();
      }
      logger.info(`User removed by ${admin.username}: ${name}`);
      res.writeHead(204).end();
      return;
    }
    throw new HttpError(405, `${method} not allowed on ${req.url}`);
  }

  // The default administrator's first password, no longer of use
  private async forgetInitialPassword(): Promise<void> {
    await fs.rm(path.join(this.options.dir, INITIAL_PASSWORD_FILE), { force: true });
  }

  // ── Sessions ──

  private statusFor(user: StoredUser): AuthStatus {
    return {
      enabled: true,
      user: authUser(user),
      mustChangePassword: user.mustChangePassword,
      hostname: this.options.hostname,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  }

  private startSession(req: IncomingMessage, res: ServerResponse, user: StoredUser): void {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(tokenKey(token), {
      username: user.username,
      created: now,
      lastSeen: now,
      passwordChanged: user.passwordChanged,
      address: clientAddress(req),
      agent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    });
    this.dirty = true;
    void this.save();
    res.setHeader('Set-Cookie', this.cookie(req, token, Math.floor(SESSION_MS / 1000)));
  }

  private cookie(req: IncomingMessage, value: string, maxAge: number): string {
    const secure = this.options.tls || req.headers['x-forwarded-proto'] === 'https';
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  private alive(session: StoredSession, now = Date.now()): boolean {
    return now - session.created < SESSION_MS && now - session.lastSeen < this.idleMs;
  }

  private end(key: string): void {
    if (this.sessions.delete(key)) {
      this.dirty = true;
      void this.save();
    }
  }

  private endSessionsOf(username: string, except: string | null): void {
    for (const [key, session] of this.sessions) {
      if (session.username === username && key !== except) {
        this.sessions.delete(key);
        this.dirty = true;
      }
    }
    void this.save();
    this.emit('changed', username);
  }

  private async save(): Promise<void> {
    if (!this.enabled || !this.dirty) {
      return;
    }
    this.dirty = false;
    const now = Date.now();
    const alive = Object.fromEntries([...this.sessions].filter(([, session]) => this.alive(session, now)));
    const temporary = `${this.sessionsFile}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(alive), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.sessionsFile);
    } catch (e) {
      await fs.rm(temporary, { force: true });
      this.dirty = true;
      this.options.logger.error(`Cannot save the sessions: ${errorMessage(e)}`);
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object');
  }
  return value as Record<string, unknown>;
}
