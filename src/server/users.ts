// Tassello's own users: a JSON file only the server's user can read (0600, in
// a 0700 folder), written whole by a rename. The command line (tassello
// users ...) changes it while the server runs: the server reads it again when
// it changes, at most once a second.
//
//   {"version": 1, "users": [{"username": "ada", "displayName": "Ada",
//     "role": "admin", "password": "scrypt$...", "disabled": false,
//     "created": "<ISO>", "passwordChanged": "<ISO>", "lastLogin": null,
//     "mustChangePassword": false}]}

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  isRole,
  normalizeUsername,
  passwordProblem,
  USERNAME_PATTERN,
  type Role,
  type UserInfo,
} from '../shared/auth.ts';
import { HttpError } from './panels.ts';
import { hashPassword } from './passwords.ts';

export interface StoredUser extends UserInfo {
  // Its scrypt hash (passwords.ts)
  password: string;
}

export interface NewUser {
  username: string;
  displayName?: string;
  role: Role;
  password: string;
  // Made for them: they choose their own at their first sign-in
  mustChangePassword?: boolean;
}

export interface UserChanges {
  displayName?: string;
  role?: Role;
  // With mustChangePassword: whether it was made for them (false if not given)
  password?: string;
  mustChangePassword?: boolean;
  disabled?: boolean;
}

const RELOAD_MS = 1000;

export function checkUsername(input: unknown): string {
  const username = typeof input === 'string' ? normalizeUsername(input) : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, 'A username is 1 to 64 letters, digits and . _ @ -, starting with a letter or a digit');
  }
  return username;
}

function checkPassword(password: unknown, username: string): string {
  if (typeof password !== 'string') {
    throw new HttpError(400, 'password must be a string');
  }
  const problem = passwordProblem(password, username);
  if (problem) {
    throw new HttpError(400, `Password: ${problem}`);
  }
  return password;
}

function checkDisplayName(input: unknown, username: string): string {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length > 100) {
    throw new HttpError(400, 'A name is at most 100 characters');
  }
  return name || username;
}

function readUser(value: unknown): StoredUser | null {
  const user = value as Partial<StoredUser> | null;
  if (
    !user ||
    typeof user.username !== 'string' ||
    !USERNAME_PATTERN.test(user.username) ||
    !isRole(user.role) ||
    typeof user.password !== 'string'
  ) {
    return null;
  }
  const now = new Date(0).toISOString();
  return {
    username: user.username,
    displayName: typeof user.displayName === 'string' && user.displayName ? user.displayName : user.username,
    role: user.role,
    password: user.password,
    disabled: user.disabled === true,
    created: typeof user.created === 'string' ? user.created : now,
    passwordChanged: typeof user.passwordChanged === 'string' ? user.passwordChanged : now,
    lastLogin: typeof user.lastLogin === 'string' ? user.lastLogin : null,
    mustChangePassword: user.mustChangePassword === true,
  };
}

export function publicUser({ password: _, ...info }: StoredUser): UserInfo {
  return info;
}

// Emits 'changed' (username) when a user is added, changed or removed, here
// or by another process
export class UserStore extends EventEmitter<{ changed: [username: string] }> {
  readonly file: string;
  private users = new Map<string, StoredUser>();
  private loadedVersion = '';
  private checkedAt = 0;
  // One write at a time, in order
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    super();
    this.file = file;
  }

  // Reads the file, created empty if missing; throws if it cannot be read
  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await this.reload(true);
  }

  // Reads the file again if it changed, at most once a second (force: now)
  async reload(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.checkedAt < RELOAD_MS) {
      return;
    }
    this.checkedAt = now;
    const stat = await fs.stat(this.file).catch(() => null);
    const version = stat ? `${stat.size}-${stat.mtimeMs}-${stat.ino}` : 'none';
    if (version === this.loadedVersion) {
      return;
    }
    let users = new Map<string, StoredUser>();
    if (stat) {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as { users?: unknown[] };
      users = new Map(
        (Array.isArray(data.users) ? data.users : []).flatMap((value) => {
          const user = readUser(value);
          return user ? [[user.username, user] as const] : [];
        }),
      );
    }
    const before = this.users;
    this.users = users;
    this.loadedVersion = version;
    if (this.listenerCount('changed') > 0) {
      for (const name of new Set([...before.keys(), ...users.keys()])) {
        if (JSON.stringify(before.get(name)) !== JSON.stringify(users.get(name))) {
          this.emit('changed', name);
        }
      }
    }
  }

  get(username: string): StoredUser | undefined {
    return this.users.get(normalizeUsername(username));
  }

  list(): StoredUser[] {
    return [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  isEmpty(): boolean {
    return this.users.size === 0;
  }

  async add(input: NewUser): Promise<StoredUser> {
    const username = checkUsername(input.username);
    if (!isRole(input.role)) {
      throw new HttpError(400, 'role must be viewer, operator or admin');
    }
    const password = checkPassword(input.password, username);
    const displayName = checkDisplayName(input.displayName, username);
    return this.change(async (users) => {
      if (users.has(username)) {
        throw new HttpError(409, `A user "${username}" exists already`);
      }
      const now = new Date().toISOString();
      const user: StoredUser = {
        username,
        displayName,
        role: input.role,
        password: await hashPassword(password),
        disabled: false,
        created: now,
        passwordChanged: now,
        lastLogin: null,
        mustChangePassword: input.mustChangePassword === true,
      };
      users.set(username, user);
      return user;
    }, username);
  }

  async update(username: string, changes: UserChanges): Promise<StoredUser> {
    const name = normalizeUsername(username);
    if (changes.role !== undefined && !isRole(changes.role)) {
      throw new HttpError(400, 'role must be viewer, operator or admin');
    }
    const password = changes.password === undefined ? undefined : checkPassword(changes.password, name);
    const hash = password === undefined ? undefined : await hashPassword(password);
    return this.change((users) => {
      const user = users.get(name);
      if (!user) {
        throw new HttpError(404, `No user "${name}"`);
      }
      const next: StoredUser = { ...user };
      if (changes.displayName !== undefined) {
        next.displayName = checkDisplayName(changes.displayName, name);
      }
      if (changes.role !== undefined) {
        next.role = changes.role;
      }
      if (changes.disabled !== undefined) {
        next.disabled = changes.disabled === true;
      }
      if (hash !== undefined) {
        next.password = hash;
        next.passwordChanged = new Date().toISOString();
        next.mustChangePassword = changes.mustChangePassword === true;
      }
      users.set(name, next);
      if (!hasActiveAdmin(users)) {
        throw new HttpError(409, 'There must be an administrator left who can sign in');
      }
      return next;
    }, name);
  }

  async remove(username: string): Promise<void> {
    const name = normalizeUsername(username);
    await this.change((users) => {
      if (!users.delete(name)) {
        throw new HttpError(404, `No user "${name}"`);
      }
      if (!hasActiveAdmin(users) && users.size > 0) {
        throw new HttpError(409, 'There must be an administrator left who can sign in');
      }
    }, name);
  }

  // Without telling: a sign-in, not a change of the user
  async recordLogin(username: string, rehashed: string | null): Promise<void> {
    await this.change(
      (users) => {
        const user = users.get(username);
        if (user) {
          users.set(username, { ...user, lastLogin: new Date().toISOString(), password: rehashed ?? user.password });
        }
      },
      null,
    ).catch(() => {});
  }

  // Applies change to the users as the file has them now, then writes them
  private change<T>(change: (users: Map<string, StoredUser>) => T | Promise<T>, changed: string | null): Promise<T> {
    const result = this.writing.then(async () => {
      await this.reload(true);
      const users = new Map(this.users);
      const value = await change(users);
      await this.write(users);
      this.users = users;
      if (changed) {
        this.emit('changed', changed);
      }
      return value;
    });
    this.writing = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async write(users: Map<string, StoredUser>): Promise<void> {
    const text = `${JSON.stringify({ version: 1, users: [...users.values()] }, null, 2)}\n`;
    const temporary = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
    } catch (e) {
      await fs.rm(temporary, { force: true });
      throw e;
    }
    const stat = await fs.stat(this.file);
    this.loadedVersion = `${stat.size}-${stat.mtimeMs}-${stat.ino}`;
  }
}

function hasActiveAdmin(users: Map<string, StoredUser>): boolean {
  return [...users.values()].some((user) => user.role === 'admin' && !user.disabled);
}
