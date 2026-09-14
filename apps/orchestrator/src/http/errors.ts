/**
 * One error shape for the whole API, so the frontend has a single thing to
 * handle: `{ error, message, details?, requestId? }`.
 */

import type { ApiError } from '@traders/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export class ApiProblem extends HTTPException {
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(status, { message });
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiProblem(400, code, message, details);
export const unauthorized = (message = 'authentication required') =>
  new ApiProblem(401, 'unauthorized', message);
export const notFound = (message = 'not found') => new ApiProblem(404, 'not_found', message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiProblem(422, code, message, details);

export function toErrorResponse(error: unknown, context: Context): { body: ApiError; status: number } {
  const requestId = context.get('requestId') as string | undefined;
  if (error instanceof ApiProblem) {
    return {
      status: error.status,
      body: { error: error.code, message: error.message, details: error.details, requestId },
    };
  }
  if (error instanceof HTTPException) {
    return {
      status: error.status,
      body: { error: 'http_error', message: error.message, requestId },
    };
  }
  return {
    status: 500,
    body: {
      error: 'internal_error',
      message: 'Something went wrong on our side.',
      requestId,
    },
  };
}
