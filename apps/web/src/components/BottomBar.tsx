import { observer } from 'mobx-react-lite';
import { Link, useRouterState } from '@tanstack/react-router';
import { Briefcase } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { useBottomBarViewport } from '../lib/viewport.ts';
import { type Place, isCurrent, useMainPlaces } from './places.ts';

/**
 * A phone's way between places (D382): each is one tap, under the thumb, and
 * always showing which one this is. Always visible rather than hiding on
 * scroll: a bar that has to be scrolled back first brings back the friction it
 * removes, and Safari's own toolbar is already moving at that moment.
 *
 * Nothing here waits for data: the count and the dot appear when their queries
 * answer, and a failed query leaves the link without them - the page itself
 * says what went wrong.
 */
export function BottomBar() {
  return useBottomBarViewport() ? <Bar /> : null;
}

/**
 * Pages that belong to a place without living under its address. Only the bar
 * marks them: a phone has no other sign of where it is, and the wide header
 * keeps its own rule.
 */
const ALSO_UNDER: Partial<Record<Place['to'], string[]>> = {
  '/': ['/holdings', '/targets'],
  '/insights': ['/proposals'],
};

const Bar = observer(function Bar() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const places: Place[] = [{ to: '/', label: t('nav.portfolio'), icon: Briefcase }, ...useMainPlaces()];

  return (
    <>
      {/* The bar is out of the flow: this keeps a page's last line above it. */}
      <div aria-hidden className="h-[var(--bottom-bar-height)]" />
      <nav
        aria-label={t('nav.places')}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-surface/95 pb-[env(safe-area-inset-bottom)] safe-inline backdrop-blur"
      >
        <ul className="grid grid-cols-5">
          {places.map((place) => (
            <li key={place.to}>
              <BarLink
                place={place}
                current={[place.to, ...(ALSO_UNDER[place.to] ?? [])].some((to) => isCurrent(to, pathname))}
              />
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
});

function BarLink({ place, current }: { place: Place; current: boolean }) {
  const { t } = useTranslation();
  const Icon = place.icon;
  const counted = place.count !== undefined && place.count > 0;
  return (
    <Link
      to={place.to}
      aria-current={current ? 'page' : undefined}
      className={`flex h-14 flex-col-reverse items-center justify-center gap-1 text-xs ${
        current ? 'font-semibold text-accent' : 'text-text-muted'
      }`}
    >
      {/* First in the source, drawn below: a screen reader says the place before its count. */}
      {place.label}
      <span className="relative inline-flex">
        <Icon className="size-5" aria-hidden />
        {counted && (
          <span className="absolute -end-3 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 font-semibold text-surface">
            {place.count}
          </span>
        )}
        {place.dot && (
          <span
            role="status"
            aria-label={t('nav.unread')}
            className={`absolute -top-0.5 size-2 rounded-full bg-accent ${counted ? '-start-1.5' : '-end-1'}`}
          />
        )}
      </span>
    </Link>
  );
}
