import { useTranslation } from '../i18n/index.ts';

/** The not-advice line of each real-portfolio view, by its observation's kind (D392, D393). */
const LINE_OF_KIND = {
  research_view: 'proposal.research.notAdvice',
  assistant_view: 'proposal.assistant.notAdvice',
  research: 'proposal.research.notAdvice',
  assistant: 'proposal.assistant.notAdvice',
} as const;

/**
 * The catalogue's line under a model's view on the real portfolio, wherever its
 * words are shown (D385): the inbox, a decided proposal, the findings feed. `kind`
 * is an observation's or a proposal's; any other kind has no such line here.
 */
export function AcknowledgedNotAdvice({ kind }: { kind: string }) {
  const { t } = useTranslation();
  const key = LINE_OF_KIND[kind as keyof typeof LINE_OF_KIND];
  return key === undefined ? null : <p className="text-xs text-text-muted">{t(key)}</p>;
}
