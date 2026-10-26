/** Deleting one's own account and exporting its data (D264). */

import { useMutation, useQuery } from '@tanstack/react-query';

import type { AccountDeletionCheck } from '@traders/shared';

import { API_BASE_URL, ApiRequestError, RATE_LIMITED, UNAUTHORIZED, api, retryAfterMinutes } from '../api/client.ts';
import { reportSessionEnded } from '../api/sessionEnded.ts';
import { t } from '../i18n/index.ts';
import { queryKeys } from './queryKeys.ts';

/** How this account confirms a deletion; read when the card shows, never cached across a sign-in. */
export function useAccountDeletionCheck() {
  return useQuery({
    queryKey: queryKeys.accountDeletion,
    queryFn: () => api.get<AccountDeletionCheck>('/account/deletion'),
    staleTime: 0,
  });
}

/**
 * The export, saved as the file the server names. Read as a blob, never parsed:
 * quantities are decimal strings and money is integers, and the file is the
 * server's document byte for byte.
 */
export function useExportAccount() {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API_BASE_URL}/account/export`, { credentials: 'include' });
      if (!response.ok) {
        // The refusals are the API's own JSON, answered as `api` answers them.
        const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        if (response.status === 401 && body.error === UNAUTHORIZED) reportSessionEnded();
        const message =
          body.error === RATE_LIMITED
            ? t('api.rateLimited', { count: retryAfterMinutes(response.headers.get('retry-after')) })
            : (body.message ?? t('api.failedWithStatus', { status: response.status }));
        throw new ApiRequestError(message, response.status, body.error ?? 'unknown_error');
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'traders-export.json';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
}
