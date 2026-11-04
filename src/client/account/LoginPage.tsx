// The page before the dashboard: the username and password, then, for one
// whose password was made for them (the default administrator's first one, or
// one an administrator set), their own new password.

import { useState, type FormEvent } from 'react';

import type { AuthStatus, AuthUser } from '../../shared/auth.ts';
import { passwordProblem } from '../../shared/auth.ts';
import { auth } from '../auth.ts';
import { TasselloIcon } from '../icons.tsx';

function errorText(e: unknown): string {
  return e instanceof TypeError ? 'The robot cannot be reached' : e instanceof Error ? e.message : String(e);
}

export function LoginPage({ status }: { status: AuthStatus }) {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <TasselloIcon width={34} height={34} />
          <div>
            <div className="login-title">{status.hostname}</div>
            <div className="login-subtitle">Tassello</div>
          </div>
        </div>
        {status.user && status.mustChangePassword ? (
          <NewPasswordForm user={status.user} minLength={status.minPasswordLength} />
        ) : (
          <SignInForm />
        )}
      </div>
    </div>
  );
}

function SignInForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(username, password);
    } catch (e) {
      setError(errorText(e));
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <h1>Sign in</h1>
      <label className="field">
        <span className="field-label">Username</span>
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          required
        />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && (
        <div className="login-error" role="alert">
          {error}
        </div>
      )}
      <button type="submit" className="button primary login-submit" disabled={busy || !username || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="login-hint">Forgot it? An administrator sets a new one, or on the robot: tassello users passwd &lt;username&gt;</p>
    </form>
  );
}

// Signed in with a password made for them: they choose their own, the
// current one typed again so that a page left open cannot be taken over
function NewPasswordForm({ user, minLength }: { user: AuthUser; minLength: number }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = password ? passwordProblem(password, user.username) : null;
  const mismatch = again !== '' && again !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(current, password);
      location.reload();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form className="login-form" onSubmit={submit}>
      <h1>Choose your password</h1>
      <p className="login-hint">
        Signed in as <strong>{user.username}</strong> with a password made for you: choose your own to go on.
      </p>
      <input type="hidden" name="username" autoComplete="username" value={user.username} readOnly />
      <label className="field">
        <span className="field-label">Current password</span>
        <input
          name="current-password"
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
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={problem !== null}
          required
        />
        <span className={`field-help${problem ? ' error' : ''}`}>{problem ?? `At least ${minLength} characters: a few words are easiest`}</span>
      </label>
      <label className="field">
        <span className="field-label">New password again</span>
        <input
          name="new-password-again"
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
      <button
        type="submit"
        className="button primary login-submit"
        disabled={busy || !current || problem !== null || !password || again !== password}
      >
        {busy ? 'Saving…' : 'Save and go on'}
      </button>
      <button type="button" className="link-button" onClick={() => void auth.logout()}>
        Sign out
      </button>
    </form>
  );
}
