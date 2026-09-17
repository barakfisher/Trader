import { observer } from 'mobx-react-lite';

import { DashboardPage } from './pages/DashboardPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { Spinner } from './components/ui.tsx';
import { useStore } from './stores/context.tsx';

export const App = observer(function App() {
  const { auth, navigation } = useStore();

  // Wait for the first session check so an authenticated reload does not flash
  // the login screen.
  if (!auth.initialised) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <Spinner label="Starting…" />
      </main>
    );
  }

  if (!auth.isAuthenticated) return <LoginPage />;
  return navigation.view === 'settings' ? <SettingsPage /> : <DashboardPage />;
});
