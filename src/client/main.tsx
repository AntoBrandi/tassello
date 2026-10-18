import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { connection } from './connection.ts';
import { DialogProvider } from './dialogs.tsx';
import { notify } from './notifications.tsx';
import { loadPlugins } from './plugins.ts';
import './styles.css';

connection.connect();
// Before rendering: the panels show the plugins' widgets
const problems = await loadPlugins();

createRoot(document.getElementById('root')!).render(
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
