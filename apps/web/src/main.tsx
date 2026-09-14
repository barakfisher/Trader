import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { RootStore } from './stores/RootStore.ts';
import { StoreProvider } from './stores/context.tsx';
import './index.css';

const store = new RootStore();
void store.auth.loadSession();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </React.StrictMode>,
);
