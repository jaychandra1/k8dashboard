import './theme-init.js';
// The UI typeface: Proxima Nova where it's installed, else Figtree (OFL),
// bundled so it works offline. Only the upright variable font: one ~20 kB
// file covers every weight (accented letters load on demand).
import '@fontsource-variable/figtree/wght.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider } from './components/Toast.jsx';
import ErrorBoundary from './components/ui/ErrorBoundary.jsx';
import { bootstrapTokenFromHash } from './lib/api.js';

// Pull `#token=…` (Electron / server-console deep link) into sessionStorage
// before anything renders or requests.
bootstrapTokenFromHash();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary title="K8Board hit an unexpected error">
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
