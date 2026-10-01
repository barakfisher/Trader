import type { NewsArticle } from '@traders/shared';

import { t as translate, useTranslation } from '../i18n/index.ts';
import { formatAge } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';

/**
 * Articles about some instruments, newest first: a topic's week, or a holding's.
 * Each says which instrument brought it here, because a link is evidence.
 */
export function NewsList({ articles, showSymbols = true }: { articles: NewsArticle[]; showSymbols?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-2">
      {articles.map((article) => (
        <li key={article.id} className="text-sm">
          <a
            {...SERVER_ENGLISH}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words hover:text-accent hover:underline"
          >
            {article.title}
          </a>
          <p className="text-xs text-text-muted">
            {article.source} · {formatAge(article.publishedAt ?? article.fetchedAt)}
            {article.publishedAt === null && t('news.publishDateUnknown')}
            {showSymbols &&
              article.instruments.length > 0 &&
              t('news.about', {
                symbols: article.instruments.map((i) => i.symbol).join(t('common.listSeparator')),
              })}
            {!showSymbols && article.instruments[0] && ` · ${matchText(article.instruments[0])}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** How the link was made, in words: a name match is weaker evidence than a ticker. */
export function matchText(link: NewsArticle['instruments'][number]): string {
  switch (link.matchMethod) {
    case 'cashtag':
      return translate('news.cashtag', { symbol: link.symbol });
    case 'exchange_prefix':
      return translate('news.exchangePrefix', { listing: link.matchedText ?? link.symbol });
    case 'company_name':
      return link.matchedText
        ? translate('news.companyNameQuoted', { text: link.matchedText })
        : translate('news.companyName');
    default:
      return link.matchMethod;
  }
}
