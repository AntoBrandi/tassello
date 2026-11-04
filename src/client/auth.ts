// Who is signed in on the page, and the sign-in's REST API (see
// src/shared/auth.ts). Read once when the page loads: signing in or out, or a
// change of role, loads the page again.

import type { AuthStatus, AuthUser, Role, UserInfo } from '../shared/auth.ts';
import { roleAtLeast } from '../shared/auth.ts';
import { DASHBOARD_CLIENT_HEADER } from '../shared/protocol.ts';

let status: AuthStatus | null = null;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [DASHBOARD_CLIENT_HEADER]: '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // Not our JSON error
    }
    throw new Error(message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function loadAuth(): Promise<AuthStatus> {
  status = await request<AuthStatus>('GET', '/api/auth/session');
  return status;
}

// Who signed in: an administrator if sign-in is off
export function currentUser(): AuthUser | null {
  return status?.user ?? null;
}

export function signInEnabled(): boolean {
  return status?.enabled ?? false;
}

// The page shows what the user may do; the server refuses the rest anyway
export function may(role: Role): boolean {
  const user = currentUser();
  return user !== null && roleAtLeast(user.role, role);
}

// Loads the page again: the sign-in, or the dashboard as who they are now
function restart(): void {
  location.reload();
}

export const auth = {
  login: (username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/login', { username, password }).then(restart),
  logout: () => request<void>('POST', '/api/auth/logout').finally(restart),
  changePassword: (current: string, password: string) =>
    request<void>('POST', '/api/auth/password', { current, password }),
  listUsers: () => request<UserInfo[]>('GET', '/api/auth/users'),
  addUser: (user: { username: string; displayName: string; role: Role; password: string }) =>
    request<UserInfo>('POST', '/api/auth/users', user),
  updateUser: (
    username: string,
    changes: { displayName?: string; role?: Role; password?: string; disabled?: boolean },
  ) => request<UserInfo>('PATCH', `/api/auth/users/${encodeURIComponent(username)}`, changes),
  removeUser: (username: string) => request<void>('DELETE', `/api/auth/users/${encodeURIComponent(username)}`),
};

let checking = false;

// The connection dropped or a request was refused: if the session ended (or
// the role changed), the page starts again
export async function checkSession(): Promise<void> {
  if (!status?.enabled || checking) {
    return;
  }
  checking = true;
  try {
    const now = await request<AuthStatus>('GET', '/api/auth/session');
    if (!now.user || now.user.role !== status.user?.role || now.user.username !== status.user.username) {
      restart();
    }
  } catch {
    // The robot is unreachable: the connection retries
  } finally {
    checking = false;
  }
}

// A password made for someone else, to give them: 16 characters of 64, 96
// bits (64 divides 256: each as likely)
export function makePassword(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
