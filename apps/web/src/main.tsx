import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './App.tsx';
import { RootStore } from './stores/RootStore.ts';
import { StoreProvider } from './stores/context.tsx';
import { applyDocumentDirection, initialDirection } from './lib/textDirection.ts';
import './index.css';

applyDocumentDirection(initialDirection(window.location.search));

const store = new RootStore();
void store.auth.loadSession();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={store.queryClient}>
      <StoreProvider store={store}>
        <App />
      </StoreProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
