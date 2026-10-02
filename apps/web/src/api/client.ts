/**
 * Thin fetch wrapper for the orchestrator API.
 *
 * Every call sends cookies (the session lives in an httpOnly cookie) and unwraps
 * the API's single error shape into an ApiRequestError, so components never have
 * to inspect response status codes.
 */

import type { ApiError } from '@traders/shared';

import { t } from '../i18n/index.ts';

// Relative: the API is served on the page's own origin, by nginx in the image
// and by Vite's proxy in development (vite.config.ts), so the session cookie
// always belongs to the address the page was opened at.
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '');

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiRequestError(t('api.unreachable'), 0, 'network_error');
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const error = (body ?? {}) as ApiError;
    throw new ApiRequestError(
      error.message ?? t('api.failedWithStatus', { status: response.status }),
      response.status,
      error.error ?? 'unknown_error',
      error.details,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * The sentence to show for a failed request: the server's own message when it
 * sent one, or the caller's description of what could not be done.
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}
