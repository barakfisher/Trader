/**
 * What an empty news list says.
 *
 * Kept out of the component for the reason `observationPresentation.ts` is: the
 * sentence makes a claim ("a quiet week"), and a claim is worth a test.
 */

import type { NewsCollectionState } from '@traders/shared';

import { t } from '../i18n/index.ts';

/**
 * Three different situations look identical as an empty array, and only one of
 * them is "a quiet week": the page must not call a week quiet when the app could
 * not read the news.
 */
export function newsEmptyMessage(
  collection: NewsCollectionState | null | undefined,
  days: number,
  /** What the news is about: one holding's symbol. */
  subject: string,
): string {
  // Undefined too: an orchestrator older than this field sends none, and that
  // must not read as a failed collection.
  if (!collection) {
    return t('news.empty.notCollected');
  }
  if (collection.status === 'ok' || collection.status === 'skipped') {
    return t('news.empty.quiet', { subject, days });
  }
  const who =
    collection.failedProviders.length > 0
      ? t('news.empty.failedProviders', { providers: collection.failedProviders.join(t('common.listSeparator')) })
      : '';
  return t('news.empty.unreachable', { who });
}
