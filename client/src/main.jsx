import './theme-init.js';
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
    <ErrorBoundary title="KubePilot hit an unexpected error">
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
