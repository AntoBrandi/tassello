// The top bar's account button: who is signed in and their role, their
// password, the users (administrators), signing out.

import { useState, type FormEvent } from 'react';

import { passwordProblem, ROLE_LABELS } from '../../shared/auth.ts';
import { auth, currentUser, isGuest, may, signInUrl } from '../auth.ts';
import { Modal } from '../dialogs.tsx';
import { notify } from '../notifications.tsx';
import { UsersDialog } from './UsersDialog.tsx';

function initials(name: string): string {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

export function AccountMenu() {
  const user = currentUser();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'password' | 'users' | null>(null);
  if (!user) {
    return null;
  }
  if (isGuest()) {
    return (
      <a className="button account-sign-in" href={signInUrl()} title="Watching as a viewer: sign in to operate">
        Sign in
      </a>
    );
  }
  const choose = (next: 'password' | 'users') => {
    setOpen(false);
    setDialog(next);
  };

  return (
    <div className="menu account-menu">
      <button
        type="button"
        className="account-button"
        aria-label={`Account: ${user.displayName}, ${ROLE_LABELS[user.role]}`}
        title={`${user.displayName} · ${ROLE_LABELS[user.role]}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {initials(user.displayName)}
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onPointerDown={() => setOpen(false)} />
          <div className="menu-list" role="menu">
            <div className="account-who">
              <strong>{user.displayName}</strong>
              <span>
                {user.username} · {ROLE_LABELS[user.role]}
              </span>
            </div>
            <button type="button" role="menuitem" onClick={() => choose('password')}>
              Change password…
            </button>
            {may('admin') && (
              <button type="button" role="menuitem" onClick={() => choose('users')}>
                Users…
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => void auth.logout()}>
              Sign out
            </button>
          </div>
        </>
      )}
      {dialog === 'password' && <PasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'users' && <UsersDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const user = currentUser();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = password ? passwordProblem(password, user?.username ?? '') : null;
  const mismatch = again !== '' && again !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(current, password);
      notify('Password changed: your other devices sign in again', 'info');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Change password" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {/* For password managers: whose password it is */}
        <input type="hidden" autoComplete="username" value={user?.username ?? ''} readOnly />
        <label className="field">
          <span className="field-label">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span className="field-label">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={problem !== null}
            required
          />
          {problem && <span className="field-help error">{problem}</span>}
        </label>
        <label className="field">
          <span className="field-label">New password again</span>
          <input
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            aria-invalid={mismatch}
            required
          />
          {mismatch && <span className="field-help error">The passwords differ</span>}
        </label>
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !current || !password || problem !== null || again !== password}
          >
            Change
          </button>
        </div>
      </form>
    </Modal>
  );
}
