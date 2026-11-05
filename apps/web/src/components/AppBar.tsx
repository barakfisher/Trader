import type { ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { CircleUser, LogOut, Settings, ShieldCheck } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { APP_VERSION, type AppVersion, versionStamp } from '../lib/appVersion.ts';
import { getDisplayTimeZone } from '../lib/relativeTime.ts';
import { useBottomBarViewport } from '../lib/viewport.ts';
import { Disclosure } from './Disclosure.tsx';
import { SpendIndicator } from './SpendIndicator.tsx';
import { useAdminSignupCountQuery } from '../queries/admin.ts';
import { useStore } from '../stores/context.tsx';
import { BrandMark } from './BrandMark.tsx';
import { type Place, isCurrent, useMainPlaces } from './places.ts';

/**
 * The bar every signed-in page shares, rendered once by the root route.
 *
 * It used to be the dashboard's own header, so every other page carried a
 * "Back to portfolio" button and reaching Agents from Settings took two
 * clicks. Page-specific controls - the portfolio's Refresh and its price age -
 * stay on their page; this bar holds only places. Targets and Import act on
 * the holdings, so they are on the holdings card (UX5).
 *
 * At `md` and up the places sit in a row here; below it they are on the bottom
 * bar (D382), so this bar says the product's name rather than repeating
 * "Portfolio" on every page, and its logo still leads there. The account items
 * (Settings, Admin, Sign out) are behind one button at every width, Sign out
 * last behind a divider so it is never the item a thumb lands on by accident.
 * That button is a disclosure - a button that shows a list of links - rather
 * than an ARIA menu: links need no arrow-key model, Tab walks them, and Escape
 * closes and returns focus to the button.
 */
export const AppBar = observer(function AppBar() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const phone = useBottomBarViewport();
  const isAdmin = auth.user?.role === 'admin';
  // Sign-up requests waiting for the admin (D188), so one is noticed without Telegram.
  const pendingSignups = useAdminSignupCountQuery(isAdmin).data?.pending ?? 0;

  const account: Place[] = [
    { to: '/settings', label: t('nav.settings'), icon: Settings },
    // Hiding it is courtesy: the server refuses every /admin request from anyone else (decision 83).
    ...(isAdmin ? [{ to: '/admin', label: t('nav.admin'), icon: ShieldCheck, count: pendingSignups } as const] : []),
  ];
  // Back to the top, so the next sign-in starts at the portfolio rather than
  // wherever this session last was.
  const signOut = () => void auth.logout().then(() => navigate({ to: '/' }));

  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface/95 backdrop-blur">
      <nav
        aria-label={t('nav.label')}
        className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-0.5 sm:px-6 sm:py-2"
      >
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-base font-semibold text-text-primary max-sm:min-h-11"
          aria-current={pathname === '/' ? 'page' : undefined}
        >
          <BrandMark className="size-5" />
          {phone ? t('nav.brand') : t('nav.portfolio')}
        </Link>

        <VersionLabel version={APP_VERSION} timeZone={getDisplayTimeZone()} />

        {!phone && <HeaderPlaces pathname={pathname} />}

        {/* Beside the account menu at every width (D247); the chip itself is narrower on a phone. */}
        <div className="ms-auto md:ms-0">
          <SpendIndicator />
        </div>

        <Disclosure
          label={t('nav.account')}
          icon={<Flagged show={pendingSignups > 0}><CircleUser className="size-5" aria-hidden /></Flagged>}
        >
          {account.map((place) => (
            <li key={place.to}>
              <PlaceLink place={place} pathname={pathname} wide />
            </li>
          ))}
          <SignOutItem label={t('nav.signOut')} onSignOut={signOut} />
        </Disclosure>
      </nav>
    </header>
  );
});

const HeaderPlaces = observer(function HeaderPlaces({ pathname }: { pathname: string }) {
  const places = useMainPlaces();
  return (
    <ul className="flex flex-1 items-center gap-1">
      {places.map((place) => (
        <li key={place.to}>
          <PlaceLink place={place} pathname={pathname} />
        </li>
      ))}
    </ul>
  );
});

function PlaceLink({ place, pathname, wide = false }: { place: Place; pathname: string; wide?: boolean }) {
  const { t } = useTranslation();
  const current = isCurrent(place.to, pathname);
  const Icon = place.icon;
  return (
    <Link
      to={place.to}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition max-sm:min-h-11 hover:bg-surface-hover hover:text-text-primary ${
        wide ? 'w-full' : ''
      } ${current ? 'bg-surface-hover text-text-primary' : 'text-text-muted'}`}
    >
      <Icon className="size-4" aria-hidden />
      {place.label}
      {place.count !== undefined && place.count > 0 && (
        <span className="ms-auto rounded-full bg-accent px-1.5 text-xs font-semibold text-surface md:ms-1">
          {place.count}
        </span>
      )}
      {place.dot && (
        <span
          role="status"
          aria-label={t('nav.unread')}
          className={`size-2 rounded-full bg-accent ${place.count ? '' : 'ms-auto md:ms-1'}`}
        />
      )}
    </Link>
  );
}

/**
 * When the commit this page was built from landed (D351, D352), on the user's
 * clock, so production and a local checkout can be told apart at a glance.
 * Left to right in every language, so a right-to-left page keeps the date
 * before the time. A checkout with uncommitted changes gets an asterisk; the
 * full sentence, with the hash, is the tooltip and what a screen reader says.
 * Below `sm` only the time: with the spend chip beside the menu, the date
 * pushed a 375px bar past its width.
 */
export function VersionLabel({ version, timeZone }: { version: AppVersion | null; timeZone: string }) {
  const { t } = useTranslation();
  if (!version) return <span className="text-xs text-text-muted">{t('nav.versionUnknown')}</span>;
  const { commit, dirty } = version;
  const { date, time } = versionStamp(version.committedAt, timeZone);
  const values = { date, time, commit };
  const label = dirty ? t('nav.versionDirty', values) : t('nav.version', values);
  return (
    <span className="text-xs text-text-muted tabular-nums" title={label}>
      <span dir="ltr" aria-hidden>
        <span className="hidden sm:inline">{date} </span>
        {time}
        {dirty && '*'}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A dot on a closed menu's icon while something inside it is waiting - the
 * Admin link's sign-up count (D188) is otherwise out of sight until opened.
 */
function Flagged({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex">
      {children}
      {show && <span className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-accent" aria-hidden />}
    </span>
  );
}

function SignOutItem({ label, onSignOut }: { label: string; onSignOut: () => void }) {
  return (
    <li className="mt-1 border-t border-border-subtle pt-1">
      <button
        type="button"
        onClick={onSignOut}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-sm text-text-muted transition hover:bg-surface-hover hover:text-text-primary"
      >
        <LogOut className="size-4" aria-hidden />
        {label}
      </button>
    </li>
  );
}
