import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Download, Ellipsis, FileUp, Plus, Target } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { useStore } from '../stores/context.tsx';
import { AddHoldingForm } from './AddHoldingForm.tsx';
import { Disclosure } from './Disclosure.tsx';
import { Drawer } from './Drawer.tsx';
import { Button, buttonClass } from './ui.tsx';

/**
 * What the holdings card does to the holdings (UX5): *Add holding* in a drawer
 * - the form is too long for a modal, and a phone gets it full screen - then
 * *Targets* (the page, chosen with the user over a drawer: the editor needs
 * the room), and Import and Export behind "⋯", used rarely enough not to
 * claim a button each. They used to sit in the app bar and in a card of their
 * own beside the table; they act on this card's rows, so they live on it.
 *
 * Export is shown and disabled until UX6 builds it, so the menu does not
 * change shape between the two PRs.
 */
export function HoldingsActions() {
  const { t } = useTranslation();
  const { import: importStore } = useStore();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex items-center gap-1">
      <Button onClick={() => setAdding(true)}>
        <span className="flex items-center gap-1">
          <Plus className="size-4" aria-hidden />
          {t('holdings.actions.add')}
        </span>
      </Button>
      <Link to="/targets" title={t('nav.targets')} className={buttonClass('ghost')}>
        <span className="flex items-center gap-1">
          <Target className="size-4" aria-hidden />
          {/* A phone's card header has room for the title and the primary
              action; Targets keeps its name for a screen reader there. */}
          <span className="max-sm:sr-only">{t('nav.targets')}</span>
        </span>
      </Link>
      <Disclosure label={t('holdings.actions.more')} icon={<Ellipsis className="size-5" aria-hidden />}>
        <li>
          <MenuButton onClick={importStore.openDialog} icon={<FileUp className="size-4" aria-hidden />}>
            {t('holdings.actions.import')}
          </MenuButton>
        </li>
        <li>
          <MenuButton disabled icon={<Download className="size-4" aria-hidden />}>
            {t('holdings.actions.export')}
          </MenuButton>
        </li>
      </Disclosure>
      {adding && (
        <Drawer title={t('addHolding.title')} closeLabel={t('holdings.actions.close')} onClose={() => setAdding(false)}>
          <AddHoldingForm framed={false} onAdded={() => setAdding(false)} />
        </Drawer>
      )}
    </div>
  );
}

function MenuButton({
  onClick,
  disabled = false,
  icon,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-start text-sm text-text-muted transition hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-muted"
    >
      {icon}
      {children}
    </button>
  );
}
