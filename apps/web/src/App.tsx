import { observer } from 'mobx-react-lite';

import { DashboardPage } from './pages/DashboardPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { ProposalsPage } from './pages/ProposalsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TargetsPage } from './pages/TargetsPage.tsx';
import { TopicsPage } from './pages/TopicsPage.tsx';
import { ConceptDialog } from './components/ConceptDialog.tsx';
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

  const page =
    navigation.view === 'settings' ? (
      <SettingsPage />
    ) : navigation.view === 'proposals' ? (
      <ProposalsPage />
    ) : navigation.view === 'targets' ? (
      <TargetsPage />
    ) : navigation.view === 'topics' ? (
      <TopicsPage />
    ) : (
      <DashboardPage />
    );

  // Mounted here rather than inside the feed: it is an overlay, and a concept
  // opened from one view must not be unmounted by navigating to another. It
  // renders nothing at all while no concept is open.
  return (
    <>
      {page}
      <ConceptDialog />
    </>
  );
});
