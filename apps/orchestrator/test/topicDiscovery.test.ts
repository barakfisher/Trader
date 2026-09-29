/**
 * Auto-discovery: which recurring phrases become proposals, and which never do.
 *
 * The database and the AI service are substituted; rows are shaped as the
 * queries return them. The load-bearing assertions are the M5 exit criterion's
 * second half, as amended to a cooldown: **a theme matching a rejection inside
 * the window is never proposed**, by words (and then it is not even resolved) or
 * by instruments. Around it: only a confident resolution with enough confident
 * instruments is proposed, the open-proposal bound is respected, every phrase
 * examined leaves a reason, and a proposal nobody answers expires and frees its
 * slot.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveredPhrase, TopicResolveResponse } from '@traders/shared/ai';
import { AiServiceError } from '@traders/shared/ai';

import type { KnownThemeRow, ProposalInput } from '../src/db/queries.js';

const USER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: null,
  base_currency: 'USD',
  timezone: 'Asia/Jerusalem',
};
const COOLDOWN = 30;
const TTL = 11;
const POLICY = { cooldownDays: COOLDOWN, proposalTtlDays: TTL };

const db = vi.hoisted(() => ({
  known: [] as KnownThemeRow[],
  open: 0,
  openWeak: 0,
  inserted: [] as ProposalInput[],
  cooldownAsked: [] as number[],
  expiredHoldAsked: [] as number[],
  /** Labels `expireProposals` reports; the TTL it was asked with; call order. */
  expiring: [] as string[],
  ttlAsked: [] as number[],
  calls: [] as string[],
}));

vi.mock('../src/db/queries.js', () => ({
  listAnalysedInstruments: vi.fn(async () => [
    { id: 'i-nvda', symbol: 'NVDA', name: 'NVIDIA Corporation', asset_class: 'equity' },
  ]),
  listKnownThemes: vi.fn(async (_userId: string, cooldownDays: number, expiredDays: number) => {
    db.calls.push('listKnownThemes');
    db.cooldownAsked.push(cooldownDays);
    db.expiredHoldAsked.push(expiredDays);
    return db.known;
  }),
  expireProposals: vi.fn(async (_client: unknown, _userId: string, ttlDays: number) => {
    db.calls.push('expireProposals');
    db.ttlAsked.push(ttlDays);
    return db.expiring;
  }),
  transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({})),
  lockTopicsForWrite: vi.fn(async () => 0),
  countOpenProposals: vi.fn(async () => ({ confident: db.open, weak: db.openWeak })),
  insertProposal: vi.fn(async (_client: unknown, input: ProposalInput) => {
    db.inserted.push(input);
    return { id: `p-${db.inserted.length}` };
  }),
}));

const {
  EXPIRED_HOLD_DAYS,
  MAX_OPEN_PROPOSALS,
  MAX_OPEN_WEAK_PROPOSALS,
  MAX_RESOLVED_PER_RUN,
  MIN_PROPOSAL_INSTRUMENTS,
  MIN_WEAK_PROPOSAL_INSTRUMENTS,
  PHRASES_REQUESTED,
  HOME_COUNTRY,
  SINGLE_COUNTRY_SHARE,
  SINGLE_INSTRUMENT_SHARE,
  runTopicDiscovery,
  singleCountryReason,
  singleInstrumentReason,
} = await import('../src/services/topicDiscovery.js');

function phrase(text: string, articles = 4): DiscoveredPhrase {
  return {
    phrase: text,
    words: text.split(' '),
    story_count: articles,
    article_count: articles,
    source_count: 3,
    lead_instrument: null,
    lead_instrument_articles: 0,
    lead_country: null,
    lead_country_name: null,
    lead_country_articles: 0,
    headlines: [
      {
        article_id: `a-${text}`,
        title: `Headline about ${text}`,
        source: 'example.com',
        published_at: null,
      },
    ],
  };
}

function resolution(
  verdict: TopicResolveResponse['verdict'],
  candidates: { id: string; symbol: string; confidence?: 'confident' | 'weak' }[] = [],
): TopicResolveResponse {
  return {
    topic: 'x',
    verdict,
    best_similarity: 0.5,
    refuse_below: 0.32,
    confident_above: 0.45,
    ambiguous: false,
    interpretations: [
      {
        label: null,
        candidates: candidates.map((c) => ({
          instrument_id: c.id,
          symbol: c.symbol,
          name: null,
          asset_class: 'equity',
          sector: null,
          industry: null,
          similarity: 0.5,
          size_minor: null,
          size_currency: null,
          confidence: c.confidence ?? 'confident',
          rationale: 'A sentence.',
          held_by: [],
        })),
      },
    ],
    universe: { state: 'ready', profiles: 10, embedded: 10 },
    embedding_model: 'm',
    vector_is_semantic: true,
  };
}

const URANIUM = ['i-ccj', 'i-ura', 'i-nxe', 'i-uec'];
const uraniumCandidates = URANIUM.map((id) => ({ id, symbol: id.slice(2).toUpperCase() }));

function fakeAi(
  phrases: DiscoveredPhrase[],
  resolutions: Record<string, TopicResolveResponse | Error>,
  headlines = 12,
) {
  const resolved: string[] = [];
  const ai = {
    discoverTopics: vi.fn(async () => ({
      since: '2026-09-20T00:00:00Z',
      days: 7,
      headlines,
      min_stories: 3,
      min_sources: 2,
      phrases,
    })),
    resolveTopic: vi.fn(async (topic: string) => {
      resolved.push(topic);
      const answer = resolutions[topic];
      if (answer instanceof Error) throw answer;
      return answer ?? resolution('none');
    }),
  };
  return { ai: ai as never, resolved, raw: ai };
}

function rejected(label: string, words: string[], instrumentIds: string[]): KnownThemeRow {
  return {
    id: `r-${label}`,
    label,
    status: 'rejected',
    proposal_band: 'confident',
    match_words: words,
    instrument_ids: instrumentIds,
  };
}

beforeEach(() => {
  db.known = [];
  db.open = 0;
  db.openWeak = 0;
  db.inserted = [];
  db.cooldownAsked = [];
  db.expiredHoldAsked = [];
  db.expiring = [];
  db.ttlAsked = [];
  db.calls = [];
});

describe('rejection memory', () => {
  it('asks for rejections inside the configured cooldown', async () => {
    const { ai } = fakeAi([], {});
    await runTopicDiscovery(USER, ai, POLICY);
    expect(db.cooldownAsked).toEqual([COOLDOWN]);
  });

  it('drops a phrase whose words cover a rejected label, before resolving it', async () => {
    db.known = [rejected('uranium', ['uranium'], URANIUM)];
    const { ai, resolved } = fakeAi([phrase('uranium miners')], {
      'uranium miners': resolution('confident', uraniumCandidates),
    });

    const result = await runTopicDiscovery(USER, ai, POLICY);

    expect(resolved).toEqual([]);
    expect(db.inserted).toEqual([]);
    expect(result.notProposed['uranium miners']).toMatch(/rejected topic "uranium" by words/);
  });

  it('drops a re-wording that names mostly the rejected instruments', async () => {
    db.known = [rejected('uranium', ['uranium'], URANIUM)];
    const { ai, resolved } = fakeAi([phrase('nuclear fuel')], {
      'nuclear fuel': resolution('confident', [
        ...uraniumCandidates.slice(0, 3),
        { id: 'i-leu', symbol: 'LEU' },
      ]),
    });

    const result = await runTopicDiscovery(USER, ai, POLICY);

    expect(resolved).toEqual(['nuclear fuel']);
    expect(db.inserted).toEqual([]);
    expect(result.notProposed['nuclear fuel']).toMatch(/rejected topic "uranium" by instruments/);
  });

  it('proposes a rejected theme again once the database no longer returns it', async () => {
    // Outside the cooldown `listKnownThemes` does not return the rejection;
    // the window itself is SQL, and this pins that nothing else remembers it.
    const { ai } = fakeAi([phrase('uranium miners')], {
      'uranium miners': resolution('confident', uraniumCandidates),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.proposed.map((p) => p.label)).toEqual(['uranium miners']);
  });

  it('counts weak candidates towards the overlap, as the real resolver needs', async () => {
    // The shape measured live: confident sets that share nothing, over
    // offered sets that mostly coincide.
    db.known = [
      rejected('uranium', ['uranium'], ['i-nlr', 'i-urnj', 'i-xe', 'i-leu', 'i-nukz', 'i-ccj']),
    ];
    const { ai } = fakeAi([phrase('nuclear fuel')], {
      'nuclear fuel': resolution('confident', [
        { id: 'i-stdn', symbol: 'STDN' },
        { id: 'i-bwxt', symbol: 'BWXT' },
        { id: 'i-xe', symbol: 'XE', confidence: 'weak' },
        { id: 'i-leu', symbol: 'LEU', confidence: 'weak' },
        { id: 'i-nukz', symbol: 'NUKZ', confidence: 'weak' },
      ]),
    });

    const result = await runTopicDiscovery(USER, ai, POLICY);

    expect(db.inserted).toEqual([]);
    expect(result.notProposed['nuclear fuel']).toMatch(/rejected topic "uranium" by instruments/);
  });

  it('treats an active topic and an open proposal the same way', async () => {
    db.known = [
      {
        id: 't1',
        label: 'Lithium',
        status: 'active',
        proposal_band: null,
        match_words: null,
        instrument_ids: ['i-alb'],
      },
      {
        id: 't2',
        label: 'robotics',
        status: 'proposed',
        proposal_band: 'confident',
        match_words: ['robotic'],
        instrument_ids: ['i-isrg'],
      },
    ];
    const { ai, resolved } = fakeAi([phrase('lithium mining'), phrase('robotics')], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual([]);
    expect(result.notProposed['lithium mining']).toMatch(/active topic "Lithium"/);
    expect(result.notProposed['robotics']).toMatch(/proposed topic "robotics"/);
  });
});

describe('what may be proposed', () => {
  it('writes a confident theme with its fingerprint and verbatim evidence', async () => {
    const { ai } = fakeAi([phrase('data centre', 5)], {
      'data centre': resolution('confident', [
        { id: 'i-eqix', symbol: 'EQIX' },
        { id: 'i-dlr', symbol: 'DLR' },
        { id: 'i-weak', symbol: 'WEAK', confidence: 'weak' },
      ]),
    });

    const result = await runTopicDiscovery(USER, ai, POLICY);

    expect(result.proposed).toEqual([
      { id: 'p-1', label: 'data centre', band: 'confident', symbols: ['EQIX', 'DLR'] },
    ]);
    expect(db.inserted[0]!.band).toBe('confident');
    const [written] = db.inserted;
    expect(written!.matchWords).toEqual(['centre', 'data']);
    // The fingerprint is everything offered; the evidence names the confident ones.
    expect(written!.instrumentIds).toEqual(['i-eqix', 'i-dlr', 'i-weak']);
    expect(written!.evidence).toMatchObject({
      phrase: 'data centre',
      articleCount: 5,
      sourceCount: 3,
      headlines: [
        { articleId: 'a-data centre', title: 'Headline about data centre', source: 'example.com' },
      ],
      symbols: ['EQIX', 'DLR'],
    });
  });

  it('never proposes an empty resolution', async () => {
    const { ai } = fakeAi([phrase('nothing')], { nothing: resolution('none') });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.inserted).toEqual([]);
    expect(result.notProposed.nothing).toBe('resolver verdict is none');
  });

  it('needs enough confident instruments to be a theme', async () => {
    const { ai } = fakeAi([phrase('one company')], {
      'one company': resolution(
        'confident',
        [{ id: 'i-a', symbol: 'A' }].slice(0, MIN_PROPOSAL_INSTRUMENTS - 1),
      ),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.inserted).toEqual([]);
    expect(result.notProposed['one company']).toMatch(/a proposal needs/);
  });

  it('does not propose two phrases for the same basket in one run', async () => {
    const { ai } = fakeAi([phrase('data centre'), phrase('server farm')], {
      'data centre': resolution('confident', uraniumCandidates),
      'server farm': resolution('confident', uraniumCandidates),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.proposed.map((p) => p.label)).toEqual(['data centre']);
    expect(result.notProposed['server farm']).toMatch(
      /proposed topic "data centre" by instruments/,
    );
  });
});

describe('bounds and states', () => {
  it('resolves nothing when both kinds of proposal are already at their bounds', async () => {
    const open = (band: 'confident' | 'weak', count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${band}${i}`,
        label: `${band} theme ${i}`,
        status: 'proposed' as const,
        proposal_band: band,
        match_words: [`${band}${i}`],
        instrument_ids: [],
      }));
    db.known = [...open('confident', MAX_OPEN_PROPOSALS), ...open('weak', MAX_OPEN_WEAK_PROPOSALS)];
    const { ai, resolved } = fakeAi([phrase('data centre')], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual([]);
    expect(result.reason).toMatch(/already open/);
  });

  it('writes no more than the slots left under the lock', async () => {
    db.open = MAX_OPEN_PROPOSALS - 1;
    const phrases = ['alpha', 'beta', 'gamma'].map((p) => phrase(p));
    const { ai } = fakeAi(phrases, {
      alpha: resolution('confident', [
        { id: 'a1', symbol: 'A1' },
        { id: 'a2', symbol: 'A2' },
      ]),
      beta: resolution('confident', [
        { id: 'b1', symbol: 'B1' },
        { id: 'b2', symbol: 'B2' },
      ]),
      gamma: resolution('confident', [
        { id: 'g1', symbol: 'G1' },
        { id: 'g2', symbol: 'G2' },
      ]),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.inserted.map((p) => p.label)).toEqual(['alpha']);
    expect(result.openProposals).toBe(MAX_OPEN_PROPOSALS);
  });

  it('resolves at most the per-run bound', async () => {
    const phrases = Array.from({ length: MAX_RESOLVED_PER_RUN + 2 }, (_, i) => phrase(`theme${i}`));
    const { ai, resolved } = fakeAi(phrases, {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toHaveLength(MAX_RESOLVED_PER_RUN);
    expect(Object.keys(result.notProposed)).toHaveLength(phrases.length);
  });

  it('says there was nothing to read rather than nothing to find', async () => {
    const { ai, resolved } = fakeAi([], {}, 0);
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual([]);
    expect(result.headlines).toBe(0);
    expect(result.reason).toMatch(/news_collect/);
  });

  it('stops and degrades when there is no universe to resolve against', async () => {
    const unavailable = { ...resolution('unavailable'), interpretations: [] };
    unavailable.universe = { state: 'not_loaded', profiles: 0, embedded: 0 };
    const { ai, resolved } = fakeAi([phrase('alpha'), phrase('beta')], { alpha: unavailable });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual(['alpha']);
    expect(result.degraded).toBe(true);
    expect(result.notProposed.alpha).toMatch(/not_loaded/);
  });

  it('degrades but carries on past a failed resolve', async () => {
    const { ai } = fakeAi([phrase('alpha'), phrase('beta')], {
      alpha: new AiServiceError('boom', 502),
      beta: resolution('confident', [
        { id: 'b1', symbol: 'B1' },
        { id: 'b2', symbol: 'B2' },
      ]),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.degraded).toBe(true);
    expect(result.notProposed.alpha).toMatch(/HTTP 502/);
    expect(result.proposed.map((p) => p.label)).toEqual(['beta']);
  });
});

describe('proposal expiry', () => {
  it('expires with the configured TTL before reading what the user already has', async () => {
    // Order matters: a proposal expired this run must count as expired, not
    // as open, when the run compares phrases and counts free slots.
    const { ai } = fakeAi([], {});
    await runTopicDiscovery(USER, ai, POLICY);
    expect(db.ttlAsked).toEqual([TTL]);
    expect(db.calls).toEqual(['expireProposals', 'listKnownThemes']);
  });

  it('expires even when there are no headlines to read, and names what it expired', async () => {
    db.expiring = ['robotics', 'uranium'];
    const { ai } = fakeAi([], {}, 0);
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.headlines).toBe(0);
    expect(result.expired).toEqual(['robotics', 'uranium']);
    expect(result.proposalTtlDays).toBe(TTL);
  });

  it('holds an expired theme back for one discovery window, by words', async () => {
    db.known = [
      {
        id: 'e1',
        label: 'uranium',
        status: 'expired',
        proposal_band: 'confident',
        match_words: ['uranium'],
        instrument_ids: URANIUM,
      },
    ];
    const { ai, resolved } = fakeAi([phrase('uranium miners')], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.expiredHoldAsked).toEqual([EXPIRED_HOLD_DAYS]);
    expect(resolved).toEqual([]);
    expect(result.notProposed['uranium miners']).toMatch(/expired topic "uranium" by words/);
  });

  it('does not count an expired proposal as open', async () => {
    // Every open slot was held by now-expired proposals: they are returned as
    // `expired`, so the run resolves and proposes rather than stopping.
    db.known = Array.from({ length: MAX_OPEN_PROPOSALS }, (_, i) => ({
      id: `e${i}`,
      label: `theme ${i}`,
      status: 'expired' as const,
      proposal_band: 'confident' as const,
      match_words: [`theme${i}`],
      instrument_ids: [],
    }));
    const { ai } = fakeAi([phrase('data centre')], {
      'data centre': resolution('confident', [
        { id: 'd1', symbol: 'D1' },
        { id: 'd2', symbol: 'D2' },
      ]),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.reason).toBeUndefined();
    expect(result.proposed.map((p) => p.label)).toEqual(['data centre']);
  });
});

describe("one country's news", () => {
  /** A phrase whose `lead` articles of `articles` came from `code`'s outlets. */
  function carried(text: string, code: string, lead: number, articles = 20): DiscoveredPhrase {
    const name = code === 'AS' ? 'Australia' : code === HOME_COUNTRY ? 'United States' : code;
    return {
      ...phrase(text, articles),
      lead_country: code,
      lead_country_name: name,
      lead_country_articles: lead,
    };
  }
  const atBar = Math.ceil(SINGLE_COUNTRY_SHARE * 20);

  it('is dropped with its share and country, before it is resolved', async () => {
    const { ai, resolved } = fakeAi([carried('cash rate', 'AS', 19), phrase('uranium')], {
      uranium: resolution('confident', uraniumCandidates),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual(['uranium']);
    expect(result.notProposed['cash rate']).toBe(
      "95% of its headlines are from Australia's press: one country's news, not a theme",
    );
  });

  it('starts at the bar and not below it', () => {
    expect(singleCountryReason(carried('cash rate', 'AS', atBar))).toContain('Australia');
    expect(singleCountryReason(carried('cash rate', 'AS', atBar - 1))).toBeNull();
  });

  it('never calls the home market local news', () => {
    expect(singleCountryReason(carried('mortgage rates', HOME_COUNTRY, 20))).toBeNull();
  });

  it('leaves a phrase from outlets of no known country alone', () => {
    expect(singleCountryReason(phrase('rate cuts'))).toBeNull();
  });

  it('still says a rejected theme was rejected', async () => {
    db.known = [rejected('cash rate', ['cash', 'rate'], [])];
    const { ai } = fakeAi([carried('cash rate', 'AS', 20)], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.notProposed['cash rate']).toMatch(/rejected/);
  });
});

describe("one company's news", () => {
  /** A phrase whose `lead` articles of `articles` are about `symbol`. */
  function led(text: string, symbol: string, lead: number, articles = 20): DiscoveredPhrase {
    return { ...phrase(text, articles), lead_instrument: symbol, lead_instrument_articles: lead };
  }
  const atBar = Math.ceil(SINGLE_INSTRUMENT_SHARE * 20);

  it('is dropped with its share and symbol, before it is resolved', async () => {
    const { ai, resolved } = fakeAi([led('rogue ai', 'NVDA', 20), phrase('uranium')], {
      uranium: resolution('confident', uraniumCandidates),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual(['uranium']);
    expect(result.notProposed['rogue ai']).toBe(
      '100% of its headlines are NVDA news: one company, not a theme',
    );
    expect(result.proposed.map((p) => p.label)).toEqual(['uranium']);
  });

  it('starts at the bar and not below it', () => {
    expect(singleInstrumentReason(led('ai agents', 'NVDA', atBar))).toContain('NVDA');
    expect(singleInstrumentReason(led('ai agents', 'NVDA', atBar - 1))).toBeNull();
  });

  it('leaves a phrase with no linked instrument alone', () => {
    expect(singleInstrumentReason(phrase('rate cuts'))).toBeNull();
  });

  it('asks for enough phrases that dropped ones leave the budget something to spend', async () => {
    const { ai, raw } = fakeAi([], {});
    await runTopicDiscovery(USER, ai, POLICY);
    expect(raw.discoverTopics).toHaveBeenCalledWith(
      expect.objectContaining({ limit: PHRASES_REQUESTED }),
      undefined,
    );
    expect(PHRASES_REQUESTED).toBeGreaterThan(2 * MAX_RESOLVED_PER_RUN);
  });

  it('does not spend the resolve budget', async () => {
    const crowd = Array.from({ length: MAX_RESOLVED_PER_RUN }, (_, i) =>
      led(`nvda thing ${i}`, 'NVDA', 20),
    );
    const { ai, resolved } = fakeAi([...crowd, phrase('uranium')], {
      uranium: resolution('confident', uraniumCandidates),
    });
    await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual(['uranium']);
  });

  it('still says a rejected theme was rejected', async () => {
    db.known = [rejected('rogue ai', ['rogue', 'ai'], [])];
    const { ai } = fakeAi([led('rogue ai', 'NVDA', 20)], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.notProposed['rogue ai']).toMatch(/rejected topic "rogue ai" by words/);
  });
});

describe('weak proposals', () => {
  /** `count` weak candidates. */
  const weakCandidates = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `w${i}`,
      symbol: `W${i}`,
      confidence: 'weak' as const,
    }));
  const proposed = (band: 'confident' | 'weak', count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${band}${i}`,
      label: `${band} theme ${i}`,
      status: 'proposed' as const,
      proposal_band: band,
      match_words: [`${band}${i}`],
      instrument_ids: [],
    }));

  it('proposes a weak verdict with enough candidates, in its own band, showing all of them', async () => {
    const { ai } = fakeAi([phrase('interest rates')], {
      'interest rates': resolution('weak', weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS)),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.proposed).toEqual([
      { id: 'p-1', label: 'interest rates', band: 'weak', symbols: ['W0', 'W1', 'W2'] },
    ]);
    expect(db.inserted[0]!.band).toBe('weak');
    expect(result.openWeakProposals).toBe(1);
    expect(result.openProposals).toBe(0);
  });

  it('needs one candidate more than a confident proposal needs', async () => {
    expect(MIN_WEAK_PROPOSAL_INSTRUMENTS).toBe(MIN_PROPOSAL_INSTRUMENTS + 1);
    const { ai } = fakeAi([phrase('vague')], {
      vague: resolution('weak', weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS - 1)),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.inserted).toEqual([]);
    expect(result.notProposed.vague).toMatch(/weak proposal needs/);
  });

  it('makes a confident verdict resting on one confident instrument a weak proposal', async () => {
    const { ai } = fakeAi([phrase('treasury yields')], {
      'treasury yields': resolution('confident', [
        { id: 'i-govi', symbol: 'GOVI' },
        ...weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS - 1),
      ]),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.proposed).toEqual([
      { id: 'p-1', label: 'treasury yields', band: 'weak', symbols: ['GOVI', 'W0', 'W1'] },
    ]);
  });

  it('never takes a confident proposal slot', async () => {
    db.known = proposed('confident', MAX_OPEN_PROPOSALS);
    const { ai } = fakeAi([phrase('data centre'), phrase('interest rates')], {
      'data centre': resolution('confident', uraniumCandidates),
      'interest rates': resolution('weak', weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS)),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.notProposed['data centre']).toBe('no open confident proposal slot left this run');
    expect(result.proposed.map((p) => [p.label, p.band])).toEqual([['interest rates', 'weak']]);
  });

  it('cannot crowd out a confident proposal', async () => {
    db.known = proposed('weak', MAX_OPEN_WEAK_PROPOSALS);
    const { ai } = fakeAi([phrase('interest rates'), phrase('data centre')], {
      'interest rates': resolution('weak', weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS)),
      'data centre': resolution('confident', uraniumCandidates),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(result.notProposed['interest rates']).toBe('no open weak proposal slot left this run');
    expect(result.proposed.map((p) => [p.label, p.band])).toEqual([['data centre', 'confident']]);
  });

  it('counts each band against its own cap under the lock', async () => {
    db.openWeak = MAX_OPEN_WEAK_PROPOSALS - 1;
    const phrases = ['alpha', 'beta'].map((p) => phrase(p));
    const { ai } = fakeAi(phrases, {
      alpha: resolution('weak', weakCandidates(MIN_WEAK_PROPOSAL_INSTRUMENTS)),
      beta: resolution('weak', [
        { id: 'b0', symbol: 'B0', confidence: 'weak' },
        { id: 'b1', symbol: 'B1', confidence: 'weak' },
        { id: 'b2', symbol: 'B2', confidence: 'weak' },
      ]),
    });
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(db.inserted.map((p) => p.label)).toEqual(['alpha']);
    expect(result.notProposed.beta).toBe('no open weak proposal slot left this run');
    expect(result.openWeakProposals).toBe(MAX_OPEN_WEAK_PROPOSALS);
  });

  it('is remembered when rejected exactly as a confident one is', async () => {
    db.known = [{ ...rejected('interest rates', ['interest', 'rate'], []), proposal_band: 'weak' }];
    const { ai, resolved } = fakeAi([phrase('interest rates')], {});
    const result = await runTopicDiscovery(USER, ai, POLICY);
    expect(resolved).toEqual([]);
    expect(result.notProposed['interest rates']).toMatch(
      /rejected topic "interest rates" by words/,
    );
  });
});
