import type { NewsArticle } from '@traders/shared';

import { formatAge } from '../lib/relativeTime.ts';
import { SERVER_ENGLISH } from '../lib/textDirection.ts';

/**
 * Articles about some instruments, newest first: a topic's week, or a holding's.
 * Each says which instrument brought it here, because a link is evidence.
 */
export function NewsList({ articles, showSymbols = true }: { articles: NewsArticle[]; showSymbols?: boolean }) {
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
            {article.publishedAt === null && ' (found; publish date unknown)'}
            {showSymbols &&
              article.instruments.length > 0 &&
              ` · about ${article.instruments.map((i) => i.symbol).join(', ')}`}
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
      return `ticker $${link.symbol} in the text`;
    case 'exchange_prefix':
      return `listing ${link.matchedText ?? link.symbol} in the text`;
    case 'company_name':
      return `matched by name${link.matchedText ? ` “${link.matchedText}”` : ''}`;
    default:
      return link.matchMethod;
  }
}
