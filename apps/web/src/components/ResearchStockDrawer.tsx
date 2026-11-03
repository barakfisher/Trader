import { useNavigate } from '@tanstack/react-router';
import { Play } from 'lucide-react';

import { useTranslation } from '../i18n/index.ts';
import { researchRefusalText } from '../lib/researchRefusals.ts';
import { useModelAccess } from '../queries/modelAccess.ts';
import { useStartResearch } from '../queries/research.ts';
import { Drawer } from './Drawer.tsx';
import { OwnKeyNotice } from './OwnKeyNotice.tsx';
import { Button } from './ui.tsx';

/**
 * "Research this stock" (D369): the research agent rates this one stock now,
 * held or not. It spends the agent's model - a call, or two when a check
 * refuses the first answer - so it is confirmed first; once started, the
 * research page opens at the stock, where the rating lands.
 */
export function ResearchStockDrawer({
  symbol,
  instrumentId,
  agentName,
  onClose,
}: {
  symbol: string;
  instrumentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const start = useStartResearch();
  const access = useModelAccess();
  const refusal = researchRefusalText(start.error);

  const confirm = () =>
    start.mutateAsync(instrumentId).then(
      () => {
        onClose();
        void navigate({ to: '/research', hash: symbol });
      },
      () => {
        // The refusal is shown from `start.error`.
      },
    );

  return (
    <Drawer title={t('holdings.researchStock.title', { symbol })} closeLabel={t('holdings.actions.close')} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>{t('holdings.researchStock.explained', { symbol, agent: agentName })}</p>
        <p className="text-xs text-text-muted">{t('holdings.researchStock.cost')}</p>
        <p className="text-xs text-text-muted">{t('research.notAdvice')}</p>
        <OwnKeyNotice access={access} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void confirm()} disabled={start.isPending || access.block !== null}>
            <span className="flex items-center gap-1">
              <Play className="size-4" aria-hidden />
              {t('holdings.researchStock.confirm')}
            </span>
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
        {refusal && <p className="text-xs text-loss">{refusal}</p>}
      </div>
    </Drawer>
  );
}
