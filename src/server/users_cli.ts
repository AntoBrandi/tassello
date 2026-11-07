// tassello users ...: the users who sign in, managed on the robot, e.g. the
// first administrator, or one who forgot their password. Changes the users
// file a running server reads again, and ends the sessions a new password or
// a disabled user should end.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { isRole, ROLE_LABELS, type Role } from '../shared/auth.ts';
import { DEFAULT_ADMIN, INITIAL_PASSWORD_FILE } from './auth.ts';
import { UserStore } from './users.ts';
import { defaultAuthDirectory, errorMessage } from './util.ts';

export const USERS_USAGE = `Usage: tassello users <command> [--auth-dir <dir>]

  list                          the users, their roles and last sign-in
  add <username> [--role <role>] [--name <display name>]
                                a new user (role: viewer, operator, admin;
                                operator if not given)
  passwd <username>             sets a user's password: they sign in again
  role <username> <role>        changes a user's role
  disable <username>            the user cannot sign in, until enabled
  enable <username>
  remove <username>

Passwords are asked for on the terminal, or read from the first line of the
standard input when it is not one (echo "$PASSWORD" | tassello users add ada).
They are the user's own: not asked to be changed at the first sign-in.
The server's first start, without users, creates admin with a random password
in initial-admin-password next to them (TASSELLO_ADMIN_PASSWORD: that one).
The users are in ~/.local/share/tassello/auth/users.json unless --auth-dir:
run the command as the server's user.`;

// A line typed without showing it, or the next line of a pipe
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const lines = createInterface({ input });
    for await (const line of lines) {
      lines.close();
      return line;
    }
    return '';
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let typed = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done();
          resolve(typed);
          return;
        }
        if (char === '\u0003') {
          done();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          typed = [...typed].slice(0, -1).join('');
        } else if (char >= ' ') {
          typed += char;
        }
      }
    };
    const done = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
    };
    input.on('data', onData);
  });
}

async function newPassword(): Promise<string> {
  const password = await readSecret('Password: ');
  if (process.stdin.isTTY && (await readSecret('Again: ')) !== password) {
    throw new Error('The passwords differ');
  }
  return password;
}

function role(value: string | undefined): Role {
  if (!isRole(value)) {
    throw new Error(`A role is viewer, operator or admin, not "${value ?? ''}"`);
  }
  return value;
}

function when(time: string | null): string {
  return time ? new Date(time).toLocaleString() : 'never';
}

// The exit code
export async function usersCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      'auth-dir': { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [command, username, extra] = positionals;
  const dir = values['auth-dir'] ? path.resolve(values['auth-dir']) : defaultAuthDirectory();
  const users = new UserStore(path.join(dir, 'users.json'));
  try {
    await users.load();
    switch (command) {
      case 'list': {
        const all = users.list();
        if (all.length === 0) {
          console.log(`No users in ${users.file}: add one with tassello users add <username> --role admin`);
        }
        for (const user of all) {
          const state = user.disabled ? ', disabled' : '';
          console.log(`${user.username}\t${ROLE_LABELS[user.role]}${state}\t${user.displayName}\tlast sign-in: ${when(user.lastLogin)}`);
        }
        return 0;
      }
      case 'add': {
        requireName(username);
        const added = await users.add({
          username,
          displayName: values.name,
          role: values.role === undefined ? 'operator' : role(values.role),
          password: await newPassword(),
        });
        console.log(`Added ${added.username}, ${ROLE_LABELS[added.role].toLowerCase()}`);
        return 0;
      }
      case 'passwd':
        requireName(username);
        await users.update(username, { password: await newPassword() });
        await forgetInitialPassword(username, dir);
        console.log(`Password of ${username} changed: their sessions are over`);
        return 0;
      case 'role': {
        requireName(username);
        const changed = await users.update(username, { role: role(extra) });
        console.log(`${changed.username} is now ${ROLE_LABELS[changed.role].toLowerCase()}`);
        return 0;
      }
      case 'disable':
      case 'enable':
        requireName(username);
        await users.update(username, { disabled: command === 'disable' });
        console.log(`${username} ${command}d`);
        return 0;
      case 'remove':
        requireName(username);
        await users.remove(username);
        await forgetInitialPassword(username, dir);
        console.log(`Removed ${username}`);
        return 0;
      default:
        console.error(`Unknown command "${command ?? ''}"\n\n${USERS_USAGE}`);
        return 2;
    }
  } catch (e) {
    console.error(`tassello users: ${errorMessage(e)}`);
    return 1;
  }
}

// The default administrator's first password, once changed or gone
async function forgetInitialPassword(username: string, dir: string): Promise<void> {
  if (username.trim().toLowerCase() === DEFAULT_ADMIN) {
    await fs.rm(path.join(dir, INITIAL_PASSWORD_FILE), { force: true });
  }
}

function requireName(username: string | undefined): asserts username is string {
  if (!username) {
    throw new Error('Which user? tassello users --help');
  }
}
