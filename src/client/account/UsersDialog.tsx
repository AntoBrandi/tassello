// The users, for the administrators: their roles changed, disabled and
// enabled, a new password given, removed; new users added with a password
// made for them, to pass on.

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  passwordProblem,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES,
  type Role,
  type UserInfo,
} from '../../shared/auth.ts';
import { auth, currentUser, makePassword } from '../auth.ts';
import { Modal, useDialogs } from '../dialogs.tsx';
import { notify } from '../notifications.tsx';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function when(time: string | null): string {
  return time ? new Date(time).toLocaleString() : 'Never';
}

export function UsersDialog({ onClose }: { onClose: () => void }) {
  const dialogs = useDialogs();
  const me = currentUser();
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The password just set, shown once to pass on
  const [given, setGiven] = useState<{ username: string; password: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers(await auth.listUsers());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const change = async (user: UserInfo, changes: Parameters<typeof auth.updateUser>[1]) => {
    try {
      await auth.updateUser(user.username, changes);
    } catch (e) {
      notify(`Could not change ${user.username}: ${errorText(e)}`, 'error');
    }
    await refresh();
  };

  const resetPassword = async (user: UserInfo) => {
    if (
      !(await dialogs.confirm({
        title: `New password for ${user.displayName}?`,
        message: 'A password is made for them, to pass on. Their sessions end: they sign in with it.',
        confirmLabel: 'Make a password',
      }))
    ) {
      return;
    }
    const password = makePassword();
    try {
      await auth.updateUser(user.username, { password });
      setGiven({ username: user.username, password });
    } catch (e) {
      notify(`Could not change the password of ${user.username}: ${errorText(e)}`, 'error');
    }
  };

  const remove = async (user: UserInfo) => {
    if (
      await dialogs.confirm({
        title: `Remove ${user.displayName}?`,
        message: 'They are signed out, and cannot sign in again.',
        confirmLabel: 'Remove',
        danger: true,
      })
    ) {
      try {
        await auth.removeUser(user.username);
      } catch (e) {
        notify(`Could not remove ${user.username}: ${errorText(e)}`, 'error');
      }
      await refresh();
    }
  };

  return (
    <Modal title="Users" onClose={onClose} wide>
      <div className="modal-body users-dialog">
        {error && <div className="login-error">{error}</div>}
        {given && (
          <div className="users-given" role="status">
            <div>
              Password of <strong>{given.username}</strong>, shown only now: pass it on. They choose their own
              when they first sign in with it.
            </div>
            <code className="users-password">{given.password}</code>
            <div className="users-given-actions">
              <button
                type="button"
                className="button"
                onClick={() =>
                  navigator.clipboard?.writeText(given.password).then(
                    () => notify('Copied', 'info'),
                    () => notify('Copying needs HTTPS: select it instead', 'error'),
                  )
                }
              >
                Copy
              </button>
              <button type="button" className="button" onClick={() => setGiven(null)}>
                Done
              </button>
            </div>
          </div>
        )}
        {users === null ? (
          <div className="widget-message">Loading…</div>
        ) : (
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Last sign-in</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const self = user.username === me?.username;
                  return (
                    <tr key={user.username} className={user.disabled ? 'disabled' : undefined}>
                      <td>
                        <div className="users-name">{user.displayName}</div>
                        <div className="users-username">
                          {user.username}
                          {self && ' · you'}
                          {user.disabled && ' · disabled'}
                          {user.mustChangePassword && ' · to choose their password'}
                        </div>
                      </td>
                      <td>
                        <select
                          aria-label={`Role of ${user.username}`}
                          value={user.role}
                          onChange={(e) => void change(user, { role: e.target.value as Role })}
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="users-when">{when(user.lastLogin)}</td>
                      <td className="users-actions">
                        <button type="button" className="button" onClick={() => void resetPassword(user)}>
                          New password
                        </button>
                        {!self && (
                          <button
                            type="button"
                            className="button"
                            onClick={() => void change(user, { disabled: !user.disabled })}
                          >
                            {user.disabled ? 'Enable' : 'Disable'}
                          </button>
                        )}
                        {!self && (
                          <button type="button" className="button danger" onClick={() => void remove(user)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {adding ? (
          <AddUser
            onAdded={(username, password) => {
              setAdding(false);
              setGiven({ username, password });
              void refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div className="modal-actions">
            <button type="button" className="button primary" onClick={() => setAdding(true)}>
              Add a user…
            </button>
          </div>
        )}
        <dl className="users-roles">
          {ROLES.map((role) => (
            <div key={role}>
              <dt>{ROLE_LABELS[role]}</dt>
              <dd>{ROLE_DESCRIPTIONS[role]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

function AddUser({ onAdded, onCancel }: { onAdded: (username: string, password: string) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [password, setPassword] = useState(makePassword);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = passwordProblem(password, username);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await auth.addUser({ username, displayName, role, password });
      onAdded(user.username, password);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form className="users-add" onSubmit={submit}>
      <h3>New user</h3>
      <div className="users-add-fields">
        <label className="field">
          <span className="field-label">Username</span>
          <input
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <span className="users-password-field">
            <input
              autoComplete="new-password"
              spellCheck={false}
              className="mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={problem !== null}
              required
            />
            <button type="button" className="button" onClick={() => setPassword(makePassword())}>
              Make one
            </button>
          </span>
          {problem && <span className="field-help error">{problem}</span>}
        </label>
      </div>
      {error && <div className="login-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy || !username || problem !== null}>
          Add
        </button>
      </div>
    </form>
  );
}
