import { useState } from 'react';
import { observer } from 'mobx-react-lite';

import { timeZoneProblem } from '@traders/shared';

import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';
import { Button, ErrorNote } from './ui.tsx';

/** Every zone this browser knows, or just the given ones where it cannot list them. */
function knownZones(...always: string[]): string[] {
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([...always.filter(Boolean), ...list])].sort();
}

/**
 * The account's own time zone (D163): set from the browser at signup, changed
 * here. The server accepts only an IANA name, the same rule as here
 * (`@traders/shared`). "Today" - quiet hours, the digest, the daily snapshot -
 * moves with it from the next run on.
 */
export const TimeZoneChange = observer(function TimeZoneChange() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const saved = auth.user?.timezone ?? '';
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [zone, setZone] = useState(saved);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(): Promise<void> {
    setDone(false);
    if (timeZoneProblem(zone) !== null) return setError(t('timeZone.invalid'));
    setError(null);
    setSubmitting(true);
    try {
      await auth.changeTimeZone(zone);
      setDone(true);
    } catch {
      setError(t('timeZone.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="max-w-sm space-y-3"
    >
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-text-muted">{t('settings.timezone')}</span>
        <select
          value={zone}
          onChange={(event) => {
            setZone(event.target.value);
            setDone(false);
          }}
          dir="ltr"
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2"
        >
          {knownZones(saved, device).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {device && device !== zone && (
        <button type="button" className="text-xs text-accent underline" onClick={() => setZone(device)}>
          {t('timeZone.useDevice', { zone: device })}
        </button>
      )}
      <p className="text-xs text-text-muted">{t('settings.timezoneNote')}</p>
      {error && <ErrorNote message={error} />}
      {done && <p className="text-xs text-text-muted">{t('timeZone.saved')}</p>}
      <Button type="submit" disabled={submitting || zone === saved}>
        {t('timeZone.save')}
      </Button>
    </form>
  );
});
