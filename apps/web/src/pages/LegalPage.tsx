import { useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LineChart } from 'lucide-react';

import { LEGAL_DOCUMENTS, UI_LANGUAGES, type LegalDocument, type UiLanguage } from '@traders/shared';

import { currentLanguage, useTranslation } from '../i18n/index.ts';
import { legalPath, legalText } from '../legal/legalText.ts';
import { directionOf } from '../lib/textDirection.ts';

/** The document a path opens, or null: `/privacy` and `/terms` (D265). */
export function legalDocumentAt(pathname: string): LegalDocument | null {
  return LEGAL_DOCUMENTS.find((document) => legalPath(document) === pathname) ?? null;
}

const components: Components = {
  h1: ({ children }) => <h1 className="text-xl font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="pt-2 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="font-semibold">{children}</h3>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 ps-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 ps-5">{children}</ol>,
  a: ({ href, children }) => (
    <a href={href} className="text-accent hover:underline">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full text-start text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border-subtle px-2 py-1 text-start font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border-subtle px-2 py-1">{children}</td>,
};

/**
 * The privacy policy or the terms (D265), outside the router and both gates
 * so they open signed out, as a stranger deciding whether to join reads them.
 * Shown in the interface's language, and either language can be chosen: each
 * is its own text, marked with its own `lang` and direction, so a Hebrew
 * reader of the English text gets it left to right inside a mirrored page.
 * Never HTML or images from the file - words, lists, tables and links.
 */
export function LegalPage({ document }: { document: LegalDocument }) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<UiLanguage>(currentLanguage);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <a href="/" className="flex items-center gap-2 text-sm text-accent hover:underline">
          <LineChart className="size-5" aria-hidden />
          {t('legal.backToApp')}
        </a>
        <div role="group" aria-label={t('legal.language')} className="flex gap-1 text-sm">
          {UI_LANGUAGES.map((option) => (
            <button
              key={option}
              type="button"
              lang={option}
              aria-pressed={language === option}
              onClick={() => setLanguage(option)}
              className={`rounded-md px-2 py-1 ${language === option ? 'bg-surface-hover font-medium' : 'text-text-muted hover:bg-surface-hover'}`}
            >
              {t(`languages.${option}`)}
            </button>
          ))}
        </div>
      </header>
      <nav aria-label={t('legal.documents')} className="flex gap-4 border-b border-border-subtle text-sm">
        {LEGAL_DOCUMENTS.map((option) => (
          <a
            key={option}
            href={legalPath(option)}
            aria-current={option === document ? 'page' : undefined}
            className={`-mb-px border-b-2 pb-2 ${option === document ? 'border-accent font-medium' : 'border-transparent text-text-muted hover:text-text-primary'}`}
          >
            {t(`legal.${option}`)}
          </a>
        ))}
      </nav>
      <article lang={language} dir={directionOf(language)} className="space-y-3 text-sm text-text-primary">
        <Markdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={['img']} skipHtml>
          {legalText(language, document)}
        </Markdown>
      </article>
    </main>
  );
}
