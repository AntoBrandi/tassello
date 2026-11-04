import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { LoginPage } from './account/LoginPage.tsx';
import { App } from './App.tsx';
import { checkSession, loadAuth } from './auth.ts';
import { connection } from './connection.ts';
import { DialogProvider } from './dialogs.tsx';
import { notify } from './notifications.tsx';
import { loadPlugins } from './plugins.ts';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
const status = await loadAuth().catch(() => null);

if (!status) {
  root.render(
    <div className="login-page">
      <div className="login-card">The robot cannot be reached: reload the page when it is.</div>
    </div>,
  );
} else if (status.enabled && (!status.user || status.mustChangePassword)) {
  root.render(
    <StrictMode>
      <LoginPage status={status} />
    </StrictMode>,
  );
} else {
  connection.connect();
  // Signed out meanwhile (expired, elsewhere), or another role now
  connection.onStatusChange(() => connection.status === 'closed' && void checkSession());
  // Before rendering: the panels show the plugins' widgets
  const problems = await loadPlugins();

  root.render(
    <StrictMode>
      <DialogProvider>
        <App />
      </DialogProvider>
    </StrictMode>,
  );

  for (const problem of problems) {
    console.error(problem);
    notify(problem, 'error');
  }
}
