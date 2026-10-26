import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { RouterProvider } from '@tanstack/react-router';

import { AccountClosedPage } from './pages/AccountClosedPage.tsx';
import { LegalAcceptancePage } from './pages/LegalAcceptancePage.tsx';
import { LegalPage, legalDocumentAt } from './pages/LegalPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { PasswordRequiredPage } from './pages/PasswordRequiredPage.tsx';
import { RESET_PATH, ResetPage } from './pages/ResetPage.tsx';
import { VERIFY_PATH, VerifyPage } from './pages/VerifyPage.tsx';
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

  // A mailed link (D259) opens signed out as well as in: before both gates.
  if (window.location.pathname === VERIFY_PATH) return <VerifyPage />;
  if (window.location.pathname === RESET_PATH) return <ResetPage />;
  // The privacy policy and terms (D265): read before joining, so before both gates too.
  const legalDocument = legalDocumentAt(window.location.pathname);
  if (legalDocument !== null) return <LegalPage document={legalDocument} />;

  // Wait for the first session check so an authenticated reload does not flash
  // the login screen.
  if (!auth.initialised) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <Spinner label={t('common.starting')} />
      </main>
    );
  }

  // Just closed at the user's request (D264): when it goes, and how to undo it.
  if (!auth.isAuthenticated && auth.closed !== null) return <AccountClosedPage />;
  // The address is left as it is, so signing in lands on the view that was asked for.
  if (!auth.isAuthenticated) return <LoginPage />;
  // The admin's one-time password (D162): nothing else until it is changed.
  if (auth.user?.mustChangePassword) return <PasswordRequiredPage />;
  // A legal version not yet accepted (D265): nothing else until it is.
  if (auth.user?.legalAcceptanceRequired) return <LegalAcceptancePage version={auth.user.legalAcceptanceRequired} />;

  return <RouterProvider router={router} />;
});
