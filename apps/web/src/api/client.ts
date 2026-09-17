/**
 * Thin fetch wrapper for the orchestrator API.
 *
 * Every call sends cookies (the session lives in an httpOnly cookie) and unwraps
 * the API's single error shape into an ApiRequestError, so components never have
 * to inspect response status codes.
 */

import type { ApiError } from '@traders/shared';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

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
    throw new ApiRequestError('Cannot reach the server. Is the orchestrator running?', 0, 'network_error');
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const error = (body ?? {}) as ApiError;
    throw new ApiRequestError(
      error.message ?? `Request failed with status ${response.status}`,
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
