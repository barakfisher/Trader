/**
 * Typed client for the Python AI service.
 *
 * Types come from `src/generated/ai-api.d.ts`, which is generated from the
 * service's committed OpenAPI schema (`pnpm gen:api`). If the Python models
 * change without regenerating, this file stops compiling - which is the point.
 */

import type { components } from '../generated/ai-api.js';

export type Quote = components['schemas']['Quote'];
export type QuoteResponse = components['schemas']['QuoteResponse'];
export type InstrumentResolution = components['schemas']['InstrumentResolution'];
export type AiInstrument = components['schemas']['Instrument'];
export type FxRate = components['schemas']['FxRate'];
export type HealthResponse = components['schemas']['HealthResponse'];

export class AiServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

export interface AiClientOptions {
  baseUrl: string;
  internalApiKey: string;
  timeoutMs?: number;
}

export class AiClient {
  private readonly baseUrl: string;
  private readonly internalApiKey: string;
  private readonly timeoutMs: number;

  constructor(options: AiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.internalApiKey = options.internalApiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { requestId?: string } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-internal-key': this.internalApiKey,
          ...(init.requestId ? { 'x-request-id': init.requestId } : {}),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      if (!response.ok) {
        throw new AiServiceError(
          `AI service ${response.status} on ${path}`,
          response.status,
          body,
        );
      }
      return body as T;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiServiceError(`AI service timed out after ${this.timeoutMs}ms on ${path}`, 504);
      }
      throw new AiServiceError(
        `AI service unreachable: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  health(requestId?: string): Promise<HealthResponse> {
    return this.request<HealthResponse>('/readyz', { method: 'GET', requestId });
  }

  quotes(symbols: string[], requestId?: string): Promise<QuoteResponse> {
    return this.request<QuoteResponse>('/market/quotes', {
      method: 'POST',
      body: JSON.stringify({ symbols }),
      requestId,
    });
  }

  resolveInstrument(query: string, requestId?: string): Promise<InstrumentResolution> {
    const search = new URLSearchParams({ query });
    return this.request<InstrumentResolution>(`/market/instruments/resolve?${search}`, {
      method: 'GET',
      requestId,
    });
  }

  fxRate(base: string, quote: string, requestId?: string): Promise<FxRate> {
    const search = new URLSearchParams({ base, quote });
    return this.request<FxRate>(`/market/fx?${search}`, { method: 'GET', requestId });
  }
}
