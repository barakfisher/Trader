import type { ReactNode } from 'react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Bot,
  CircleUser,
  Lightbulb,
  LineChart,
  LogOut,
  Menu,
  MessageCircleQuestion,
  Microscope,
  Settings,
  ShieldCheck,
  Tags,
  X,
} from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { APP_VERSION, type AppVersion } from '../lib/appVersion.ts';
import { Disclosure } from './Disclosure.tsx';
import { SpendIndicator } from './SpendIndicator.tsx';
import { useAdminSignupCountQuery } from '../queries/admin.ts';
import { unreadCount, useInsightsDaysQuery } from '../queries/insightsDays.ts';
import { openProposals, useProposalsQuery } from '../queries/proposals.ts';
import { useStore } from '../stores/context.tsx';

/**
 * The bar every signed-in page shares, rendered once by the root route.
 *
 * It used to be the dashboard's own header, so every other page carried a
 * "Back to portfolio" button and reaching Topics from Settings took two
 * clicks. Page-specific controls - the portfolio's Refresh and its price age -
 * stay on their page; this bar holds only places. Targets and Import act on
 * the holdings, so they are on the holdings card (UX5).
 *
 * At `md` and up the places sit in a row and the account items (Settings,
 * Admin, Sign out) behind one button; below `md` everything is behind a
 * hamburger, with Sign out last behind a divider so it is never the item a
 * thumb lands on by accident. Both are disclosures - a button that shows a
 * list of links - rather than ARIA menus: links need no arrow-key model, Tab
 * walks them, and Escape closes and returns focus to the button.
 */
export const AppBar = observer(function AppBar() {
  const { auth } = useStore();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Open questions, on Insights: a question that expires unanswered because
  // nobody knew it was there is what the inbox exists to prevent.
  const openCount = openProposals(useProposalsQuery().data).length;
  // Unread findings are a dot beside the count, not a second number (the user,
  // 2026-10-11): the number is what has a deadline.
  const hasUnread = unreadCount(useInsightsDaysQuery().data) > 0;
  const isAdmin = auth.user?.role === 'admin';
  // Sign-up requests waiting for the admin (D188), so one is noticed without Telegram.
  const pendingSignups = useAdminSignupCountQuery(isAdmin).data?.pending ?? 0;

  const places: Place[] = [
    // Proposals is a tab of Insights (decision 134), so its count is here.
    { to: '/insights', label: t('nav.insights'), icon: Lightbulb, count: openCount, dot: hasUnread },
    { to: '/agents', label: t('nav.agents'), icon: Bot },
    { to: '/topics', label: t('nav.topics'), icon: Tags },
    { to: '/research', label: t('nav.research'), icon: Microscope },
    { to: '/ask', label: t('nav.ask'), icon: MessageCircleQuestion },
    // Targets is on the holdings card (UX5): it is about those rows.
  ];
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
        className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2 sm:px-6"
      >
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-base font-semibold text-text-primary"
          aria-current={pathname === '/' ? 'page' : undefined}
        >
          <LineChart className="size-5 text-accent" aria-hidden />
          {t('nav.portfolio')}
        </Link>

        <VersionLabel version={APP_VERSION} />

        <ul className="hidden flex-1 items-center gap-1 md:flex">
          {places.map((place) => (
            <li key={place.to}>
              <PlaceLink place={place} pathname={pathname} />
            </li>
          ))}
        </ul>

        {/* Beside the account menu at every width (D247); the chip itself is narrower on a phone. */}
        <div className="ms-auto md:ms-0">
          <SpendIndicator />
        </div>

        <div className="hidden md:block">
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
        </div>

        <div className="md:hidden">
          <Disclosure
            label={t('nav.menu')}
            icon={<Flagged show={pendingSignups > 0}><Menu className="size-5" aria-hidden /></Flagged>}
            openIcon={<X className="size-5" aria-hidden />}
          >
            {[...places, ...account].map((place) => (
              <li key={place.to}>
                <PlaceLink place={place} pathname={pathname} wide />
              </li>
            ))}
            <SignOutItem label={t('nav.signOut')} onSignOut={signOut} />
          </Disclosure>
        </div>
      </nav>
    </header>
  );
});

type Place = {
  to: '/insights' | '/agents' | '/topics' | '/research' | '/ask' | '/settings' | '/admin';
  label: string;
  icon: typeof Bot;
  count?: number;
  /** Something new to read there (decision 133), shown beside the count. */
  dot?: boolean;
};

/** A place is current on its own address and below it: /agents/x is still Agents. */
function isCurrent(to: string, pathname: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function PlaceLink({ place, pathname, wide = false }: { place: Place; pathname: string; wide?: boolean }) {
  const { t } = useTranslation();
  const current = isCurrent(place.to, pathname);
  const Icon = place.icon;
  return (
    <Link
      to={place.to}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition hover:bg-surface-hover hover:text-text-primary ${
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
 * The commit this page was built from (D351), so production and a local
 * checkout can be told apart at a glance. Left to right in every language: it
 * is a code, and a right-to-left page would otherwise put the hash first. A
 * checkout with uncommitted changes gets an asterisk; the full sentence is the
 * tooltip and what a screen reader says. Below `sm` only the hash: with the
 * spend chip beside the menu, the date pushed a 375px bar past its width, and
 * the hash is the part that tells two builds apart.
 */
export function VersionLabel({ version }: { version: AppVersion | null }) {
  const { t } = useTranslation();
  if (!version) return <span className="text-xs text-text-muted">{t('nav.versionUnknown')}</span>;
  const { date, commit, dirty } = version;
  const label = dirty ? t('nav.versionDirty', { date, commit }) : t('nav.version', { date, commit });
  return (
    <span className="text-xs text-text-muted tabular-nums" title={label}>
      <span dir="ltr" aria-hidden>
        <span className="hidden sm:inline">{date} · </span>
        {commit}
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
