import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { RouterProvider } from '@tanstack/react-router';

import { LoginPage } from './pages/LoginPage.tsx';
import { Spinner } from './components/ui.tsx';
import { createAppRouter } from './router.tsx';
import { useStore } from './stores/context.tsx';
import { useTranslation } from './i18n/index.ts';

export const App = observer(function App({
  router: given,
}: {
  /** Tests pass a router on a memory history; the app makes its own. */
  router?: ReturnType<typeof createAppRouter>;
}) {
  const { auth } = useStore();
  const { t } = useTranslation();
  const [router] = useState(() => given ?? createAppRouter());

  // Wait for the first session check so an authenticated reload does not flash
  // the login screen.
  if (!auth.initialised) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <Spinner label={t('common.starting')} />
      </main>
    );
  }

  // The address is left as it is, so signing in lands on the view that was asked for.
  if (!auth.isAuthenticated) return <LoginPage />;

  return <RouterProvider router={router} />;
});
