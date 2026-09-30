/**
 * Typed client for the Python AI service.
 *
 * Types come from `src/generated/ai-api.d.ts`, which is generated from the
 * service's committed OpenAPI schema (`pnpm gen:api`). If the Python models
 * change without regenerating, this file stops compiling - which is the point.
 *
 * Static types only describe what the service promises. Every response is also
 * parsed at runtime against the schemas in `schemas.ts`, because the service is a
 * separate process whose code the compiler has never seen: a missing or null
 * field used to arrive as `undefined` and become NaN inside the valuation. The
 * header of `schemas.ts` explains how those schemas stay tied to the generated
 * types.
 */

import type { z } from 'zod';

import type { components } from '../generated/ai-api.js';
import {
  askResponseSchema,
  conceptDocumentSchema,
  conceptSearchResponseSchema,
  fxRateSchema,
  healthResponseSchema,
  backfillResponseSchema,
  priceHistoryResponseSchema,
  instrumentResolutionSchema,
  narrationConfigSchema,
  portfolioScanResponseSchema,
  topicScanResponseSchema,
  newsCollectResponseSchema,
  quoteResponseSchema,
  topicDiscoverResponseSchema,
  topicResolveResponseSchema,
} from './schemas.js';

export type Quote = components['schemas']['Quote'];
export type QuoteResponse = components['schemas']['QuoteResponse'];
export type QuoteMarket = components['schemas']['QuoteMarket'];
export type InstrumentResolution = components['schemas']['InstrumentResolution'];
export type AiInstrument = components['schemas']['Instrument'];
export type FxRate = components['schemas']['FxRate'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type NarrationConfig = components['schemas']['NarrationConfigResponse'];
export type PortfolioScanRequest = components['schemas']['PortfolioScanRequest'];
export type PortfolioScanResponse = components['schemas']['PortfolioScanResponse'];
export type TopicScanRequest = components['schemas']['TopicScanRequest'];
export type TopicScanResponse = components['schemas']['TopicScanResponse'];
export type NewsCollectRequest = components['schemas']['NewsCollectRequest'];
export type NewsCollectResponse = components['schemas']['NewsCollectResponse'];
export type ObservationOut = components['schemas']['ObservationOut'];
export type BackfillRequest = components['schemas']['BackfillRequest'];
export type BackfillResponse = components['schemas']['BackfillResponse'];
export type PriceHistoryResponse = components['schemas']['PriceHistoryResponse'];
export type ConceptDocument = components['schemas']['ConceptDocumentResponse'];
export type ConceptSection = components['schemas']['ConceptSection'];
export type ConceptSearchResponse = components['schemas']['ConceptSearchResponse'];
export type ConceptSearchMatch = components['schemas']['ConceptSearchMatch'];
export type AskRequest = components['schemas']['AskRequest'];
export type AskResponse = components['schemas']['AskResponse'];
export type AskCitation = components['schemas']['AskCitation'];
export type TopicResolveResponse = components['schemas']['TopicResolveResponse'];
export type TopicCandidate = components['schemas']['TopicCandidateOut'];
export type TopicInterpretation = components['schemas']['TopicInterpretationOut'];
export type UniverseCoverage = components['schemas']['UniverseCoverageOut'];
export type TopicDiscoverRequest = components['schemas']['TopicDiscoverRequest'];
export type TopicDiscoverResponse = components['schemas']['TopicDiscoverResponse'];
export type DiscoveredPhrase = components['schemas']['DiscoveredPhrase'];

/**
 * A scan loads history for every holding and may call a model once per finding,
 * so it needs far longer than a quote lookup. Five minutes is generous enough
 * that a slow model does not lose the work, and short enough that a wedged
 * request still ends.
 */
const SCAN_TIMEOUT_MS = 5 * 60_000;

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
    schema: z.ZodType<T>,
    init: RequestInit & { requestId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        throw new AiServiceError(`AI service ${response.status} on ${path}`, response.status, body);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        // A response that does not match the contract is an AI-service fault, so
        // it reads as 502 rather than a client bug. Callers already turn a failed
        // quote fetch into a visibly unpriced portfolio, which is exactly the
        // outcome wanted here: no number at all beats a wrong one.
        throw new AiServiceError(
          `AI service response failed validation on ${path}`,
          502,
          parsed.error.issues,
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiServiceError(`AI service timed out after ${timeoutMs}ms on ${path}`, 504);
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
    return this.request('/readyz', healthResponseSchema, { method: 'GET', requestId });
  }

  /**
   * `markets` is optional context by symbol - the instrument's asset class and
   * exchange - which decides only how long the AI service caches each quote.
   */
  quotes(
    symbols: string[],
    requestId?: string,
    markets?: Record<string, QuoteMarket>,
  ): Promise<QuoteResponse> {
    return this.request('/market/quotes', quoteResponseSchema, {
      method: 'POST',
      body: JSON.stringify(markets === undefined ? { symbols } : { symbols, markets }),
      requestId,
    });
  }

  resolveInstrument(query: string, requestId?: string): Promise<InstrumentResolution> {
    const search = new URLSearchParams({ query });
    return this.request(`/market/instruments/resolve?${search}`, instrumentResolutionSchema, {
      method: 'GET',
      requestId,
    });
  }

  /**
   * Run the analysis pipeline over a portfolio.
   *
   * Deliberately long-running compared with a quote: it loads history for every
   * holding and may call a model once per finding. The default client timeout is
   * too short for that, so this call is given its own.
   */
  portfolioScan(payload: PortfolioScanRequest, requestId?: string): Promise<PortfolioScanResponse> {
    return this.request<PortfolioScanResponse>(
      '/analysis/portfolio-scan',
      portfolioScanResponseSchema,
      { method: 'POST', body: JSON.stringify(payload), requestId, timeoutMs: SCAN_TIMEOUT_MS },
    );
  }

  /**
   * Measure each confirmed topic as an equal-weighted basket. Same timeout as a
   * portfolio scan, for the same reason: history per instrument, a model call
   * per new finding.
   */
  topicScan(payload: TopicScanRequest, requestId?: string): Promise<TopicScanResponse> {
    return this.request<TopicScanResponse>('/analysis/topic-scan', topicScanResponseSchema, {
      method: 'POST',
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

  /**
   * Fetch, match, score and store one window of news for the given instruments.
   * The AI service writes the shared news tables; this returns what it did.
   */
  collectNews(payload: NewsCollectRequest, requestId?: string): Promise<NewsCollectResponse> {
    return this.request<NewsCollectResponse>('/news/collect', newsCollectResponseSchema, {
      method: 'POST',
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

  /**
   * How narration is configured: which provider, which model, and whether that
   * model bills anything.
   *
   * Asked of this service rather than read from the orchestrator's own
   * environment, because the LLM belongs to the AI service and a second copy of
   * `LLM_MODEL` would eventually disagree with the process actually making the
   * calls - surfacing as a UI confidently naming the wrong model.
   */
  narrationConfig(requestId?: string): Promise<NarrationConfig> {
    return this.request<NarrationConfig>('/narration/config', narrationConfigSchema, {
      method: 'GET',
      requestId,
    });
  }

  /**
   * Fill the price history the analysis rules read. One provider call per
   * instrument, so it shares the scan's longer timeout rather than the quote
   * client's.
   */
  backfillHistory(payload: BackfillRequest, requestId?: string): Promise<BackfillResponse> {
    return this.request<BackfillResponse>('/market/history/backfill', backfillResponseSchema, {
      method: 'POST',
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

  /**
   * An instrument's stored daily closes - the series the analysis rules read,
   * real prices only. Read from the AI service rather than from `quotes` here,
   * because "what counts as a day's close" and "which sources this installation
   * excludes" are that service's rules, and a second copy would drift.
   */
  priceHistory(instrumentId: string, days: number, requestId?: string): Promise<PriceHistoryResponse> {
    return this.request<PriceHistoryResponse>(
      `/market/history/${encodeURIComponent(instrumentId)}?days=${days}`,
      priceHistoryResponseSchema,
      { method: 'GET', requestId },
    );
  }

  /**
   * One concept explainer, whole.
   *
   * Asked of the AI service rather than read from `kb_chunks` here, because the
   * corpus belongs to that service along with the ingester and the retrieval
   * `/ask` will add. A second reader of those tables would be a second place
   * that has to agree about section ordering and namespace filtering.
   *
   * A slug the corpus does not hold raises `AiServiceError` with status 404,
   * which the caller renders as "not available" rather than as a failure: an
   * environment that has not ingested the corpus is a real state, not a bug.
   */
  concept(slug: string, requestId?: string): Promise<ConceptDocument> {
    return this.request<ConceptDocument>(
      `/concepts/${encodeURIComponent(slug)}`,
      conceptDocumentSchema,
      { method: 'GET', requestId },
    );
  }

  /**
   * Hybrid retrieval over the corpus: the half of `/ask` that finds things.
   *
   * A diagnostic surface, not a product feature. The AI service's Python suite
   * is hermetic and has no Postgres, so nothing in CI executes a line of the
   * retrieval SQL - the same blind spot that shipped a namespace bug in the
   * previous slice. This is how that SQL gets exercised against a real database
   * before `/ask` is built on top of it.
   *
   * Deliberately no relevance floor and no refusal: deciding that the corpus
   * does not cover a question is `/ask`'s judgement, and making it here as well
   * would put one threshold in two places.
   */
  searchConcepts(query: string, limit?: number, requestId?: string): Promise<ConceptSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request<ConceptSearchResponse>(
      `/concepts/search?${params.toString()}`,
      conceptSearchResponseSchema,
      { method: 'GET', requestId },
    );
  }

  /**
   * Ask one question of the corpus or of the caller's own holdings.
   *
   * A refusal comes back as a normal 200 with `answered: false` and a
   * `refused_reason`, so a caller must branch on the body rather than on the
   * status. That is deliberate: refusing a question the corpus does not cover
   * is something the product is required to do well, and an error status would
   * make a correct refusal indistinguishable from a corpus that failed to load.
   *
   * Shares the scan's longer timeout rather than the quote client's, because a
   * concept answer may call a model and a cold embedding call adds a round
   * trip - and losing the work to a timeout would be the expensive direction.
   */
  ask(payload: AskRequest, requestId?: string): Promise<AskResponse> {
    return this.request<AskResponse>('/ask', askResponseSchema, {
      method: 'POST',
      body: JSON.stringify(payload),
      requestId,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

  /**
   * Candidate instruments for a free-text topic, each with a quoted reason.
   *
   * Branch on `verdict`, not on the status: an installation with no loaded
   * universe answers 200 with `verdict: 'unavailable'` and a `universe.state`
   * naming the missing step, which is a different statement from `none` (the
   * universe was searched and holds nothing about the topic).
   *
   * The longer timeout, because a cold call embeds the topic at a provider
   * before it searches.
   */
  /**
   * Phrases recurring across the window's collected headlines (FR-11). Reads
   * only; nothing is resolved or stored. Auto-discovery filters these against
   * the user's topics and rejection memory before resolving any of them.
   */
  discoverTopics(payload: TopicDiscoverRequest, requestId?: string): Promise<TopicDiscoverResponse> {
    return this.request<TopicDiscoverResponse>('/topics/discover', topicDiscoverResponseSchema, {
      method: 'POST',
      body: JSON.stringify(payload),
      requestId,
    });
  }

  resolveTopic(topic: string, requestId?: string): Promise<TopicResolveResponse> {
    return this.request<TopicResolveResponse>('/topics/resolve', topicResolveResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ topic }),
      requestId,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

    fxRate(base: string, quote: string, requestId?: string): Promise<FxRate> {
    const search = new URLSearchParams({ base, quote });
    return this.request(`/market/fx?${search}`, fxRateSchema, { method: 'GET', requestId });
  }
}
