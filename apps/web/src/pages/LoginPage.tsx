import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { LineChart, LockKeyhole } from 'lucide-react';

import { Disclaimer } from '../components/Disclaimer.tsx';
import { Button, ErrorNote } from '../components/ui.tsx';
import { useStore } from '../stores/context.tsx';

export const LoginPage = observer(function LoginPage() {
  const { auth } = useStore();
  const [passphrase, setPassphrase] = useState('');

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <LineChart className="size-6 text-accent" aria-hidden />
          <h1 className="text-lg font-semibold">Traders</h1>
        </div>
        <p className="text-sm text-text-muted">
          Portfolio copilot. Sign in with this installation's passphrase - its{' '}
          <code className="text-xs">APP_PASSPHRASE</code>, in <code className="text-xs">.env</code> for
          docker compose or in the cluster's <code className="text-xs">secrets.env</code>.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void auth.login(passphrase);
          }}
          className="space-y-3 rounded-xl border border-border-subtle bg-surface-raised p-4"
        >
          <label className="block space-y-1">
            <span className="text-xs uppercase tracking-wide text-text-muted">Passphrase</span>
            <div className="flex items-center gap-2">
              <LockKeyhole className="size-4 text-text-muted" aria-hidden />
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoFocus
                autoComplete="current-password"
                className="input"
              />
            </div>
          </label>

          {auth.error && <ErrorNote message={auth.error} />}

          <Button type="submit" disabled={auth.submitting || passphrase.length === 0} className="w-full">
            {auth.submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <Disclaimer />
      </div>
    </main>
  );
});
