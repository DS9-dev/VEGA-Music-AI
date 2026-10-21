import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { PlayerProvider } from './components/Player';
import { ToastProvider } from './components/ui';
import { installDemoApi } from './demo';

// В Electron window.api ставит preload. В обычном браузере — демо-режим для просмотра интерфейса.
if (!window.api) installDemoApi();

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <PlayerProvider>
      <App />
    </PlayerProvider>
  </ToastProvider>,
);
