-- Rows at head, one for every value a CHECK constraint enumerates.
--
-- The migration round trip steps down to base over these rows and back up.
-- CI's other jobs migrate an empty database, which proves only that the SQL
-- parses: a constraint is exercised by data, and the downgrades that broke
-- (0006 retyping `runs_kind_check`, 0021 relabelling over a live CHECK) broke
-- only with a row present. `test_migrations.py` reads every enumerated value
-- from `pg_constraint` and fails if one is missing here, so a migration that
-- adds a value cannot pass CI until a row carries it through the downgrade.

-- Three active users because settings are one row per user and each severity
-- column enumerates three values; one of them is the admin role. An active
-- non-admin needs a spend cap (0058).
INSERT INTO users (id, role, status, llm_cap_micro_usd) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin', 'active', NULL),
  ('00000000-0000-0000-0000-00000000000b', 'user', 'active', 10000000),
  ('00000000-0000-0000-0000-00000000000c', 'user', 'active', 10000000);
-- The other three statuses (0058). A pending and a rejected user never had an
-- agent; the disabled one was active first, so it keeps its primary. They make
-- 0058's downgrade refuse: the older schema would make them ordinary users.
INSERT INTO users (id, role, email) VALUES
  ('00000000-0000-0000-0000-00000000000d', 'user', 'pending@example.test');
INSERT INTO users (id, role, email, status) VALUES
  ('00000000-0000-0000-0000-00000000000e', 'user', 'rejected@example.test', 'rejected');
INSERT INTO users (id, role, email, status, llm_cap_micro_usd) VALUES
  ('00000000-0000-0000-0000-00000000000f', 'user', 'disabled@example.test', 'active', 0);
UPDATE users SET status = 'disabled' WHERE id = '00000000-0000-0000-0000-00000000000f';
-- `language` (0034) enumerates two values; the third row keeps the default.
INSERT INTO user_settings (user_id, proposal_severity, notify_severity, quiet_hours_start, quiet_hours_end, language) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'notable', 'info', '22:00', '07:00', 'en'),
  ('00000000-0000-0000-0000-00000000000b', 'high', 'notable', NULL, NULL, 'he'),
  ('00000000-0000-0000-0000-00000000000c', 'info', 'high', NULL, NULL, 'en');
-- A monthly safety limit on own-key spend (0068, D250).
UPDATE user_settings SET llm_safety_limit_micro_usd = 20000000
 WHERE user_id = '00000000-0000-0000-0000-00000000000c';

-- Agents (0036). The users' primaries were made by the `users_seed_primary_agent`
-- trigger; they are given known ids here so the rows below can name them. The
-- two simulated agents carry the states a primary may not, and make 0036's
-- downgrade refuse (it would fold their rows into the real portfolio).
UPDATE agents SET id = ('90000000-0000-0000-0000-00000000000' || right(user_id::text, 1))::uuid;
INSERT INTO agents (id, user_id, slug, name, persona, budget_minor, state) VALUES
  ('90000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'paused-agent', 'Paused agent', 'Cautious.', 100000, 'paused'),
  ('90000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'archived-agent', 'Archived agent', NULL, 50000, 'archived');
-- Mandates (0057): every horizon and thesis style, each rule set somewhere.
INSERT INTO agents (id, user_id, slug, name, persona, budget_minor, state) VALUES
  ('90000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000000a', 'mandated-agent', 'Mandated agent', NULL, 100000, 'archived');
UPDATE agents SET risk_level = 2, horizon = 'long', thesis_style = 'academic', max_position_bps = 1000,
       cash_buffer_bps = 2000, max_holdings = 8, allow_etfs = false, market_caps = '{large,mega}',
       sectors = '{Energy}', industries = '{Uranium}', etf_categories = '{"Large Blend"}',
       blocked_symbols = '{EQTY}'
 WHERE id = '90000000-0000-0000-0000-0000000000a1';
UPDATE agents SET risk_level = 9, horizon = 'short', thesis_style = 'growth'
 WHERE id = '90000000-0000-0000-0000-0000000000a2';
UPDATE agents SET risk_level = 5, horizon = 'medium', thesis_style = 'contrarian'
 WHERE id = '90000000-0000-0000-0000-0000000000a3';

INSERT INTO instruments (id, symbol, asset_class) VALUES
  ('10000000-0000-0000-0000-000000000001', 'EQTY', 'equity'),
  ('10000000-0000-0000-0000-000000000002', 'FUND', 'etf'),
  ('10000000-0000-0000-0000-000000000003', 'COIN-USD', 'crypto'),
  ('10000000-0000-0000-0000-000000000004', 'EURUSD=X', 'fx'),
  ('10000000-0000-0000-0000-000000000005', '^IDX', 'index'),
  ('10000000-0000-0000-0000-000000000006', 'MYST', 'unknown');

INSERT INTO holdings (user_id, agent_id, instrument_id, quantity)
VALUES ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1.5');
INSERT INTO target_weights (user_id, agent_id, instrument_id, weight)
VALUES ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '0.5');
INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source)
VALUES ('10000000-0000-0000-0000-000000000001', '2026-09-01T20:00:00Z', 12345, 'USD', 'fixture');
INSERT INTO portfolio_snapshots (user_id, agent_id, as_of, total_minor, currency)
VALUES ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '2026-09-01', 18517, 'USD');

INSERT INTO runs (id, kind, run_key, status)
SELECT ('20000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, kind, 'seed:' || kind || ':' || status, status
  FROM unnest(
         ARRAY['snapshot','portfolio_scan','topic_scan','daily_digest','backfill','proposal_sweep',
               'instrument_metadata','news_collect','topic_discovery'],
         ARRAY['running','ok','degraded','failed','skipped','ok','ok','ok','ok']
       ) WITH ORDINALITY AS t(kind, status, n);
-- A scheduled scan's ask and one attempt (0048); the attempt names its agent.
INSERT INTO runs (id, user_id, agent_id, kind, run_key, status) VALUES
  ('20000000-0000-0000-0000-000000000097', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'agent_scans', 'agent_scans:seed', 'ok'),
  ('20000000-0000-0000-0000-000000000098', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'agent_scan', 'agent_scan:seed:2026-10-08:pre_open:1', 'failed');
-- A rescreen running on a heartbeat (0031): the partial unique index allows one.
INSERT INTO runs (id, kind, run_key, status, heartbeat_at) VALUES
  ('20000000-0000-0000-0000-000000000099', 'universe_rescreen', 'universe-rescreen:2026-10-01', 'running', now());

INSERT INTO observations (id, user_id, agent_id, run_id, kind, severity, subject_kind, subject_ref, headline, dedupe_key, narration_source, fallback_reason) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000002',
   'price_move', 'info', 'instrument', 'instrument:EQTY', 'EQTY moved', 'seed-obs-1', 'llm', 'none'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000002',
   'allocation_drift', 'notable', 'portfolio', 'portfolio', 'EQTY drifted', 'seed-obs-2', 'template', 'unsourced_figures'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000003',
   'topic_move', 'high', 'topic', 'topic:40000000-0000-0000-0000-000000000001', 'uranium moved', 'seed-obs-3', NULL, NULL);

INSERT INTO proposals (id, user_id, agent_id, observation_id, kind, state, expires_at, decided_via, decided_at) VALUES
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000001', 'rebalance', 'pending',  '2026-09-02T00:00:00Z', NULL, NULL),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', 'rebalance', 'approved', '2026-09-02T00:00:00Z', 'web', '2026-09-01T12:00:00Z'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', 'rebalance', 'rejected', '2026-09-02T00:00:00Z', 'telegram', '2026-09-01T12:00:00Z');
-- The remaining states, each needing its own observation (one proposal per observation).
INSERT INTO observations (id, user_id, agent_id, kind, headline, dedupe_key)
SELECT ('30000000-0000-0000-0000-00000000001' || n)::uuid, '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'drift', 'seed-obs-1' || n
  FROM generate_series(1, 2) AS n;
INSERT INTO proposals (id, user_id, agent_id, observation_id, kind, state, expires_at, snoozed_until, decided_via, decided_at) VALUES
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000011', 'rebalance', 'snoozed', '2026-09-02T00:00:00Z', '2026-09-01T18:00:00Z', NULL, NULL),
  ('50000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000012', 'rebalance', 'expired', '2026-09-02T00:00:00Z', NULL, 'system', '2026-09-02T00:00:00Z');
INSERT INTO proposal_transitions (proposal_id, user_id, from_state, to_state, surface) VALUES
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'pending', 'approved', 'web'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'pending', 'rejected', 'telegram'),
  ('50000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'pending', 'expired', 'system');
INSERT INTO intents (user_id, agent_id, proposal_id, kind, revoked_at, revoked_via) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', '2026-09-01T13:00:00Z', 'web'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', '2026-09-01T14:00:00Z', 'telegram'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', NULL, NULL);

INSERT INTO narration_transitions (id, user_id, from_state, to_state) VALUES
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', NULL, 'off'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'off', 'narrating'),
  ('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'narrating', 'unavailable'),
  ('60000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'unavailable', 'exhausted'),
  ('60000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'exhausted', 'rejected'),
  ('60000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-00000000000a', 'rejected', 'narrating');

INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status, sent_at, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'telegram', 'observation', '30000000-0000-0000-0000-000000000001', 'push',      'above_floor', 'sent',       '2026-09-01T12:00:00Z', 'seed-n-1'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'digest',   'proposal',    '50000000-0000-0000-0000-000000000001', 'digest',    'quiet_hours', 'pending',    NULL, 'seed-n-2'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'telegram', 'narration',   '60000000-0000-0000-0000-000000000003', 'push',      'above_floor', 'failed',     NULL, 'seed-n-3'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'digest',   'observation', '30000000-0000-0000-0000-000000000002', 'feed_only', 'below_floor', 'suppressed', NULL, 'seed-n-4'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'digest',   'narration',   '60000000-0000-0000-0000-000000000002', 'digest',    'muted',       'pending',    NULL, 'seed-n-5');

INSERT INTO telegram_bindings (user_id, chat_id) VALUES ('00000000-0000-0000-0000-00000000000a', 4242);
INSERT INTO telegram_bind_tokens (nonce, user_id, chat_id) VALUES ('seed-nonce', '00000000-0000-0000-0000-00000000000a', 4242);

INSERT INTO kb_documents (id, namespace, concept_slug, title, source, license, content_hash) VALUES
  ('70000000-0000-0000-0000-000000000001', 'concepts', 'seed-concept', 'A concept', 'seed', 'CC0', 'h1'),
  ('70000000-0000-0000-0000-000000000002', 'news', NULL, 'An article', 'seed', 'seed', 'h2');
INSERT INTO kb_chunks (document_id, ord, text) VALUES
  ('70000000-0000-0000-0000-000000000001', 0, 'A drawdown is the fall from a peak.'),
  ('70000000-0000-0000-0000-000000000002', 0, 'A headline.');

INSERT INTO articles (id, url_hash, url, source, title, raw_text, content_hash)
VALUES ('80000000-0000-0000-0000-000000000001', 'seed-url', 'https://example.com/a', 'example.com', 'EQTY rises', 'EQTY rises', 'seed-content');
INSERT INTO articles (id, url_hash, url, source, title, raw_text, content_hash, feed)
VALUES ('80000000-0000-0000-0000-000000000002', 'seed-market-url', 'https://example.com/m', 'example.com', 'Bond yields rise', 'Bond yields rise', 'seed-market-content', 'market');
INSERT INTO article_entities (article_id, entity_kind, instrument_id, topic_ref, match_method, salience) VALUES
  ('80000000-0000-0000-0000-000000000001', 'instrument', '10000000-0000-0000-0000-000000000001', NULL, 'cashtag', 0.9),
  ('80000000-0000-0000-0000-000000000001', 'instrument', '10000000-0000-0000-0000-000000000002', NULL, 'exchange_prefix', 0.5),
  ('80000000-0000-0000-0000-000000000001', 'topic', NULL, 'uranium', 'company_name', 0.3);
INSERT INTO article_sentiment (article_id, score, magnitude, model)
VALUES ('80000000-0000-0000-0000-000000000001', '0.5', '0.5', 'lexicon-v1');
INSERT INTO news_feed_cursors (provider, last_file_at) VALUES ('gdelt', '2026-09-01T12:00:00Z');

INSERT INTO instrument_profiles (instrument_id, description, matching_text, source, license, content_hash, size_as_of)
VALUES ('10000000-0000-0000-0000-000000000002', 'A fund.', 'a fund', 'fixture', 'fixture', 'seed-profile', '2026-09-01T00:00:00Z');
INSERT INTO instrument_profiles (instrument_id, description, matching_text, source, license, content_hash, size_as_of, membership) VALUES
  ('10000000-0000-0000-0000-000000000001', 'A company.', 'a company', 'fixture', 'fixture', 'seed-on-demand', '2026-09-01T00:00:00Z', 'on_demand'),
  ('10000000-0000-0000-0000-000000000006', 'Gone.', 'gone', 'fixture', 'fixture', 'seed-dropped', '2026-09-01T00:00:00Z', 'dropped');
INSERT INTO etf_holdings (etf_instrument_id, position, symbol, weight, as_of, holding_instrument_id, matched_by) VALUES
  ('10000000-0000-0000-0000-000000000002', 1, 'EQTY', '0.5', '2026-09-01T00:00:00Z', '10000000-0000-0000-0000-000000000001', 'symbol'),
  ('10000000-0000-0000-0000-000000000002', 2, 'MYST', '0.2', '2026-09-01T00:00:00Z', '10000000-0000-0000-0000-000000000006', 'name'),
  ('10000000-0000-0000-0000-000000000002', 3, 'CASH', '0.1', '2026-09-01T00:00:00Z', NULL, NULL);

INSERT INTO topics (id, user_id, label, status, created_by, confirmed_at, rejected_at, expired_at, match_words, proposed_instruments, evidence, proposal_band) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'uranium', 'active', 'user', '2026-09-01T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'ai agents', 'proposed', 'auto', NULL, NULL, NULL,
   ARRAY['ai','agents'], ARRAY['10000000-0000-0000-0000-000000000001']::uuid[], '{}'::jsonb, 'confident'),
  ('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'festival', 'rejected', 'auto', NULL, '2026-09-01T00:00:00Z', NULL,
   ARRAY['festival'], ARRAY[]::uuid[], '{}'::jsonb, 'weak'),
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'lithium', 'expired', 'auto', NULL, NULL, '2026-09-01T00:00:00Z',
   ARRAY['lithium'], ARRAY[]::uuid[], '{}'::jsonb, 'confident'),
  ('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'interest rates', 'proposed', 'auto', NULL, NULL, NULL,
   ARRAY['interest','rates'], ARRAY['10000000-0000-0000-0000-000000000002']::uuid[], '{}'::jsonb, 'weak');
INSERT INTO topic_instruments (topic_id, user_id, instrument_id, source, confidence, rationale, held_by) VALUES
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'resolver', 'confident', 'It mines uranium.', '[]'::jsonb),
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', 'resolver', 'weak', 'A fund.', '[]'::jsonb),
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000006', 'user', NULL, NULL, '[]'::jsonb);

-- An audit row, so the round trip meets 0026's refusal to discard the audit.
INSERT INTO admin_audit (admin_user_id, action, detail, ip_address) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'POST /admin/example', '{"body": {}}', '10.0.0.1');

-- One gap event of each kind.
INSERT INTO ops_events (kind, user_id, detail, dedupe_key) VALUES
  ('universe_gap_missing_ticker', '00000000-0000-0000-0000-00000000000a',
   '{"symbol": "SAP.DE", "gap": "outside_screen", "outside_screen": "exchange"}',
   'missing_ticker:a:SAP.DE:2026-10-01'),
  ('universe_gap_low_confidence', '00000000-0000-0000-0000-00000000000a',
   '{"topic": "quantum", "best_similarity": 0.18, "refuse_below": 0.23}',
   'low_confidence:a:quantum:2026-10-01');

-- Model calls covering every agent, outcome and verdict.
-- `purpose` since 0041; the trigger fills the old `agent` column from it.
INSERT INTO llm_calls (user_id, purpose, provider, model, outcome, verdict, latency_ms, prompt) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'narration', 'openrouter', 'm', 'ok', 'accepted', 900, 'p'),
  ('00000000-0000-0000-0000-00000000000a', 'narration', 'openrouter', 'm', 'ok', 'malformed', 900, 'p'),
  ('00000000-0000-0000-0000-00000000000a', 'narration', 'openrouter', 'm', 'ok', 'unsourced_figures', 900, 'p'),
  ('00000000-0000-0000-0000-00000000000a', 'ask', 'openrouter', 'm', 'ok', 'empty_completion', 900, 'p'),
  ('00000000-0000-0000-0000-00000000000a', 'ask', 'openrouter', 'm', 'ok', 'degenerate_completion', 900, 'p'),
  ('00000000-0000-0000-0000-00000000000a', 'ask', 'openrouter', 'm', 'provider_error', NULL, 30000, 'p'),
  (NULL, 'narration', 'openrouter', NULL, 'budget_exhausted', NULL, 0, 'p'),
  (NULL, 'narration', 'null', NULL, 'no_provider', NULL, 0, 'p');
-- A call made by a simulated agent's scan (0041's agent_id, 0042's purpose).
INSERT INTO llm_calls (user_id, agent_id, purpose, provider, model, outcome, latency_ms, prompt) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'agent_scan',
   'openrouter', 'm', 'ok', 900, 'p');
-- A call made on a user's own key (0065's paid_by), and saved keys: one working,
-- one refused for each reason.
INSERT INTO llm_calls (user_id, purpose, provider, model, outcome, latency_ms, prompt, paid_by) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'ask', 'openrouter', 'm', 'ok', 900, 'p', 'own_key');
INSERT INTO user_llm_keys (user_id, ciphertext, last_four, status, failure, failed_at) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'not-a-real-token', 'c0de', 'failed', 'no_credit', now()),
  ('00000000-0000-0000-0000-00000000000f', 'not-a-real-token', '9f3e', 'failed', 'rejected', now());
INSERT INTO user_llm_keys (user_id, ciphertext, last_four) VALUES
  ('00000000-0000-0000-0000-00000000000c', 'not-a-real-token', '77aa');
-- Scans (0043, 0064, 0065, 0068): one finished with each outcome, both triggers, and one running.
INSERT INTO agent_scans (user_id, agent_id, trigger, started_at, finished_at, outcome, steps, cost_micro_usd, model, briefing, transcript, answer, error) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'manual', now() - interval '6 days', now() - interval '6 days', 'trade', 3, 41000, 'm', '{}', '[]', '{"decision": "buy", "symbol": "EQTY", "quantity": "2", "thesis": "t"}', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '5 days', now() - interval '5 days', 'no_trade', 1, 9000, 'm', '{}', '[]', '{"decision": "none", "thesis": "t"}', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '4 days', now() - interval '4 days', 'invalid_answer', 2, 12000, 'm', '{}', '[]', '{"problems": ["p"]}', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '4 days', now() - interval '4 days', 'rule_rejected', 2, 12000, 'm', '{}', '[{"role": "returned", "problems": ["p"]}]', '{"decision": "buy", "symbol": "EQTY", "quantity": "2", "thesis": "t", "problems": ["p"]}', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '3 days', now() - interval '3 days', 'budget_reached', 0, 0, NULL, '{}', '[]', NULL, NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '3 days', now() - interval '3 days', 'cap_reached', 0, 0, NULL, '{}', '[]', NULL, NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '3 days', now() - interval '3 days', 'own_key_failed', 0, 0, NULL, '{}', '[]', NULL, 'OwnKeyFailedError: x'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'manual', now() - interval '3 days', now() - interval '3 days', 'own_key_required', 0, 0, NULL, '{}', '[]', NULL, 'OwnKeyRequiredError: x'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', now() - interval '2 days', now() - interval '2 days', 'step_limit', 12, 380000, 'm', '{}', '[]', NULL, NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'manual', now() - interval '1 day', now() - interval '1 day', 'failed', 0, 0, NULL, '{}', '[]', NULL, 'LLMRequestError: x'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a2', 'manual', now(), NULL, NULL, 0, 0, NULL, '{}', '[]', NULL, NULL);
-- Schedules in each shape an agent may choose (0060): both edges, every N hours, and
-- every N hours with the pre-open scan.
UPDATE agents SET scan_pre_open = true, scan_post_close = true WHERE id = '90000000-0000-0000-0000-0000000000a1';
UPDATE agents SET scan_every_hours = 4, scan_pre_open = false, llm_budget_micro_usd = 250000
 WHERE id = '90000000-0000-0000-0000-0000000000a2';
UPDATE agents SET scan_every_hours = 2, scan_pre_open = true WHERE id = '90000000-0000-0000-0000-00000000000b';
-- The models chosen on the Admin page (0041).
INSERT INTO llm_model_choices (scope, model, updated_by) VALUES
  ('explain', 'anthropic/claude-sonnet-5.5', '00000000-0000-0000-0000-00000000000a'),
  ('agent', 'anthropic/claude-sonnet-5.5', NULL);

-- Proposal episodes (0032): one closed by each reason, and one still open.
INSERT INTO proposal_episodes (user_id, agent_id, observation_kind, subject_ref, observation_id, asked_magnitude, closed_at, close_reason) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'portfolio', '30000000-0000-0000-0000-000000000002', '0.150619', now(), 'resolved'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'portfolio', '30000000-0000-0000-0000-000000000002', '0.150619', now(), 'worsened'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'portfolio', '30000000-0000-0000-0000-000000000002', '-0.150619', now(), 'reversed'),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'portfolio', '30000000-0000-0000-0000-000000000002', '0.210000', NULL, NULL);

-- Finding episodes (0049): both state kinds, every band, one closed.
INSERT INTO finding_episodes (user_id, agent_id, kind, subject_ref, severity, observation_id, closed_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'allocation_drift', 'portfolio', 'notable', '30000000-0000-0000-0000-000000000002', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'drawdown', 'instrument:EQTY', 'high', '30000000-0000-0000-0000-000000000001', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'drawdown', 'instrument:EQTY', 'info', '30000000-0000-0000-0000-000000000001', now());

-- The ledger (0040). The two simulated agents above were given their cash and
-- opening deposits by the `agents_ledger_follows_budget` trigger. A buy at a
-- quote by hand, a sell at a typed price by the agent, and a budget raised after
-- trading (a top-up) cover every enumerated value - and make 0040's downgrade
-- refuse, since it would discard them.
INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor, notional_minor, fee_minor, price_source, quote_as_of, quote_delay_seconds, source, idempotency_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'buy', '10', 1000, 10000, 150, 'quote', now(), 900, 'manual_user_override', 'seed-buy');
-- Trade proposals (0044): the paused agent's `trade` scan proposed a sell, which
-- was approved and filled - an agent's fill has a proposal - and a buy still
-- pending, with one refused attempt from each surface.
INSERT INTO observations (id, user_id, agent_id, kind, severity, subject_ref, headline, dedupe_key, narration_source) VALUES
  ('30000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'agent_trade', 'notable', 'instrument:EQTY', 'Paused agent proposes to sell 2 EQTY', 'agent_scan:seed-sell', 'llm'),
  ('30000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'agent_trade', 'notable', 'instrument:EQTY', 'Paused agent proposes to buy 2 EQTY', 'agent_scan:seed-buy', 'llm');
INSERT INTO proposals (id, user_id, agent_id, observation_id, kind, payload, state, expires_at, decided_via, decided_at, scan_id)
SELECT ('50000000-0000-0000-0000-00000000002' || n)::uuid, '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1',
       ('30000000-0000-0000-0000-00000000002' || n)::uuid, kind,
       '{"symbol": "EQTY", "quantity": "2", "priceMinor": 1100, "currency": "USD"}', state, now() + interval '1 hour',
       CASE WHEN state = 'approved' THEN 'web' END, CASE WHEN state = 'approved' THEN now() END,
       (SELECT id FROM agent_scans WHERE outcome = 'trade')
  FROM (VALUES (1, 'sell', 'approved')) AS t(n, kind, state);
INSERT INTO agent_scans (id, user_id, agent_id, trigger, started_at, finished_at, outcome, steps, cost_micro_usd, model, briefing, transcript, answer) VALUES
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'manual', now() - interval '7 days', now() - interval '7 days', 'trade', 2, 20000, 'm', '{}', '[]', '{"decision": "buy", "symbol": "EQTY", "quantity": "2", "thesis": "t"}');
INSERT INTO proposals (id, user_id, agent_id, observation_id, kind, payload, state, expires_at, scan_id) VALUES
  ('50000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-000000000022', 'buy',
   '{"symbol": "EQTY", "quantity": "2", "priceMinor": 1100, "currency": "USD"}', 'pending', now() + interval '1 hour', '70000000-0000-0000-0000-000000000001');
-- A re-check of that buy (0066): a scan with trigger `refresh` naming the proposal.
INSERT INTO agent_scans (user_id, agent_id, trigger, refreshes_proposal_id, started_at, finished_at, outcome, steps, cost_micro_usd, model, briefing, transcript, answer) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'refresh', '50000000-0000-0000-0000-000000000022', now() - interval '1 day', now() - interval '1 day', 'no_trade', 1, 2000, 'm', '{}', '[]', '{"trades": [], "thesis": "t"}');
INSERT INTO proposal_attempts (user_id, proposal_id, surface, reason, agent_price_minor, live_price_minor, quote_as_of) VALUES
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000022', 'web', 'price_far_from_agent', 1100, 1200, now()),
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000022', 'telegram', 'market_closed', 1100, NULL, NULL);
INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor, notional_minor, fee_minor, price_source, quote_as_of, quote_delay_seconds, source, proposal_id, idempotency_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'sell', '2', 1100, 2200, 150, 'user', NULL, NULL, 'agent', '50000000-0000-0000-0000-000000000021', 'seed-sell');
UPDATE agents SET budget_minor = 150000 WHERE id = '90000000-0000-0000-0000-0000000000a1';
-- The real portfolio's ledger (0078, D328-D330): user a's primary opened with
-- its cash and its holdings' cost, a buy recorded against it, and its balance
-- then set to what the broker shows - an `adjustment` - which makes 0078's
-- downgrade refuse.
UPDATE agents SET budget_minor = 100000, opening_holdings_cost_minor = 5000
 WHERE id = '90000000-0000-0000-0000-00000000000a';
INSERT INTO fills (user_id, agent_id, instrument_id, side, quantity, price_minor, notional_minor, fee_minor, price_source, quote_as_of, quote_delay_seconds, source, idempotency_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'buy', '1', 1000, 1000, 750, 'user', NULL, NULL, 'manual_user_override', 'seed-primary-buy');
SELECT set_config('traders.cash_kind', 'adjustment', true);
UPDATE agents SET budget_minor = 90000 WHERE id = '90000000-0000-0000-0000-00000000000a';
SELECT set_config('traders.cash_kind', '', true);
-- A reset's backup (0045), which makes its downgrade refuse: it would discard it.
INSERT INTO account_resets (user_id, groups, counts, backup) VALUES
  ('00000000-0000-0000-0000-00000000000a', ARRAY['followed_topics'], '{"topics": 0}', '{"topics": []}');
-- The assistant (0052): its own model choice and purpose, and a conversation
-- whose replies cover every outcome and every decline reason.
INSERT INTO llm_model_choices (scope, model, updated_by) VALUES
  ('assistant', 'google/gemini-3.5-flash-lite', '00000000-0000-0000-0000-00000000000a');
INSERT INTO llm_calls (user_id, purpose, provider, model, outcome, verdict, latency_ms, cost_micro_usd, prompt) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'assistant', 'openrouter', 'm', 'ok', 'accepted', 900, 1200, 'p');
INSERT INTO assistant_conversations (id, user_id, title) VALUES
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'How is my portfolio?');
INSERT INTO assistant_messages (conversation_id, user_id, role, content, outcome, reason, sources, suggestions, tool_calls, model, cost_micro_usd) VALUES
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'user', 'How is my portfolio?', NULL, NULL, '[]', '[]', '[]', NULL, 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'Up.', 'answer', NULL, '[{"kind": "page", "label": "Portfolio", "link": "/"}]', '["Why?"]', '[{"role": "tool", "name": "get_portfolio", "result": {}}]', 'm', 1200),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'No.', 'decline', 'off_domain', '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'No.', 'decline', 'advice', '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'No.', 'decline', 'action', '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'No.', 'decline', 'prompt', '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'Which?', 'clarify', NULL, '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'failed', NULL, '[]', '[]', '[]', 'm', 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'budget_reached', NULL, '[]', '[]', '[]', NULL, 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'cap_reached', NULL, '[]', '[]', '[]', NULL, 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'own_key_failed', NULL, '[]', '[]', '[]', NULL, 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'own_key_required', NULL, '[]', '[]', '[]', NULL, 0),
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'assistant', 'x', 'no_model', NULL, '[]', '[]', '[]', NULL, 0);
UPDATE installation_settings SET assistant_daily_budget_micro_usd = 750000;
-- The universe taxonomy (0056): an equity industry, a sector ETF category and
-- one with no sector.
INSERT INTO universe_taxonomy (kind, name, sector, instruments) VALUES
  ('industry', 'Uranium', 'Energy', 2),
  ('etf_category', 'Technology', 'Technology', 1),
  ('etf_category', 'Large Blend', NULL, 1);
-- The contradiction check (0059): its purpose, and a stored result.
INSERT INTO llm_calls (user_id, agent_id, purpose, provider, model, outcome, verdict, latency_ms, cost_micro_usd, prompt) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'mandate_check', 'openrouter', 'm', 'ok', 'accepted', 800, 300, 'p');
UPDATE agents SET instructions_check = '{"fingerprint": "f", "conflicts": [{"setting": "horizon", "quote": "Cautious."}], "checked_at": "2026-10-19T08:00:00Z", "dismissed": false}'
 WHERE id = '90000000-0000-0000-0000-0000000000a1';
UPDATE telegram_bindings SET assistant_conversation_id = '80000000-0000-0000-0000-000000000001'
 WHERE user_id = '00000000-0000-0000-0000-00000000000a';
-- Model choice (0069, D244): a user's model for each scope, an agent's, and a
-- fallback in every scope, one of them announced (D286).
UPDATE user_settings SET llm_explain_model = 'anthropic/claude-haiku-4.5',
       llm_assistant_model = 'acme/retired-model'
 WHERE user_id = '00000000-0000-0000-0000-00000000000b';
UPDATE agents SET model = 'acme/retired-model' WHERE id = '90000000-0000-0000-0000-0000000000a1';
INSERT INTO model_fallbacks (id, user_id, agent_id, scope, saved_model, effective_model, announced_at) VALUES
  ('61000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', '90000000-0000-0000-0000-00000000000b', 'explain', 'acme/retired-model', 'google/gemini-3.5-flash-lite', NULL),
  ('61000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', '90000000-0000-0000-0000-00000000000b', 'assistant', 'acme/retired-model', 'google/gemini-3.5-flash-lite', '2026-10-23T12:00:00Z'),
  ('61000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'agent', 'acme/retired-model', 'google/gemini-3.5-flash-lite', NULL);
INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status, sent_at, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000b', '90000000-0000-0000-0000-00000000000b', 'telegram', 'model_fallback', '61000000-0000-0000-0000-000000000002', 'push', 'above_floor', 'sent', '2026-10-23T12:00:00Z', 'seed-n-model-fallback');
-- A scheduled scan that gave up (0073, D298), held for the digest: the failed attempt above.
INSERT INTO notifications (user_id, agent_id, channel, ref_kind, ref_id, route, reason, status, sent_at, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-00000000000a', 'digest', 'run', '20000000-0000-0000-0000-000000000098', 'digest', 'quiet_hours', 'pending', NULL, 'seed-n-run');
-- Research (0070, D254): user a assigns its paused agent; one run per trigger and
-- status, one rating per status and rating, a research call, and a research attempt.
UPDATE user_settings SET research_agent_id = '90000000-0000-0000-0000-0000000000a1'
 WHERE user_id = '00000000-0000-0000-0000-00000000000a';
INSERT INTO research_runs (id, user_id, agent_id, trigger, status, holdings, rated, cost_micro_usd, error, finished_at) VALUES
  ('62000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'manual', 'done', 3, 2, 3000, NULL, '2026-10-23T21:00:00Z'),
  ('62000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', 'failed', 1, 0, 0, 'abandoned', '2026-10-23T22:00:00Z'),
  ('62000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'schedule', 'running', 1, 0, 0, NULL, NULL);
INSERT INTO research_ratings (run_id, user_id, agent_id, instrument_id, symbol, status, rating, rationale, findings, problems, model) VALUES
  ('62000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'EQTY', 'rated', 'bullish', 'Momentum is firm.', '["Steady news."]', '[]', 'm'),
  ('62000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002', 'FUND', 'rated', 'bearish', 'Flows are weak.', '[]', '[]', 'm'),
  ('62000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000003', 'COIN-USD', 'refused', NULL, NULL, '[]', '["figures not in the evidence: 40"]', 'm'),
  ('62000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'EQTY', 'failed', NULL, NULL, '[]', '["the model call failed: timeout"]', NULL);
INSERT INTO research_ratings (run_id, user_id, agent_id, instrument_id, symbol, status, rating, rationale) VALUES
  ('62000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000006', 'MYST', 'rated', 'neutral', 'Mixed signals.');
INSERT INTO llm_calls (user_id, agent_id, purpose, provider, model, outcome, latency_ms, prompt) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'research',
   'openrouter', 'm', 'ok', 900, 'p');
INSERT INTO runs (id, user_id, agent_id, kind, run_key, status) VALUES
  ('20000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'research', 'research:seed:2026-10-23:1', 'ok');
-- Sessions (0071, D261): a live one and an expired one the sweep would delete,
-- and the sweep's own run.
INSERT INTO user_sessions (user_id, token_hash, created_at, last_seen_at, expires_at, user_agent, ip_address) VALUES
  ('00000000-0000-0000-0000-00000000000b', sha256('seed-session-live'), now(), now(), now() + interval '7 days',
   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', '203.0.113.7'),
  ('00000000-0000-0000-0000-00000000000c', sha256('seed-session-expired'), '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z',
   NULL, NULL);
INSERT INTO runs (id, kind, run_key, status) VALUES
  ('20000000-0000-0000-0000-0000000000a8', 'session_sweep', 'session_sweep:seed:2026-10-24', 'ok'),
  ('20000000-0000-0000-0000-0000000000a9', 'auth_sweep', 'auth_sweep:seed:2026-10-25', 'ok');
-- Email verification (0074, D259, D260): a link of every purpose - one used,
-- one expired - an unverified request, a change waiting for its link, and an
-- installation that is closed with a non-zero waiting limit, which 0074's
-- downgrade must keep closed.
UPDATE users SET pending_email = 'new-b@example.test' WHERE id = '00000000-0000-0000-0000-00000000000b';
UPDATE users SET approved_automatically = true WHERE id = '00000000-0000-0000-0000-00000000000c';
INSERT INTO auth_tokens (user_id, purpose, token_hash, email, created_at, expires_at, used_at) VALUES
  ('00000000-0000-0000-0000-00000000000d', 'verify_email', sha256('seed-token-verify'), 'pending@example.test', now(), now() + interval '1 day', NULL),
  ('00000000-0000-0000-0000-00000000000b', 'verify_new_email', sha256('seed-token-new-email'), 'new-b@example.test', now() - interval '2 hours', now() - interval '1 hour', NULL),
  ('00000000-0000-0000-0000-00000000000c', 'reset_password', sha256('seed-token-reset'), 'c@example.test', now() - interval '1 hour', now() + interval '1 hour', now());
UPDATE installation_settings SET signup_mode = 'closed', max_pending_signups = 5;
-- OAuth identities (0075, D262): one per provider, so the CHECK's every value is seeded.
INSERT INTO user_identities (user_id, provider, subject, email) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'google', 'seed-google-sub-b', 'b@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'github', '1000001', 'c@example.test');
-- Account deletion (0076, D264): an account closed and waiting for its erase,
-- which 0076's downgrade makes disabled, and the erase's own run.
INSERT INTO users (id, role, email, status, llm_cap_micro_usd) VALUES
  ('00000000-0000-0000-0000-000000000010', 'user', 'closed@example.test', 'active', 0);
UPDATE users SET status = 'closed', deletion_due_at = now() + interval '7 days'
 WHERE id = '00000000-0000-0000-0000-000000000010';
INSERT INTO runs (id, kind, run_key, status) VALUES
  ('20000000-0000-0000-0000-0000000000aa', 'account_erase', 'account_erase:seed:2026-10-26:10', 'ok');
-- Legal acceptances (0077, D265): one user who accepted two versions, the
-- history a later version leaves.
INSERT INTO legal_acceptances (user_id, version, accepted_at) VALUES
  ('00000000-0000-0000-0000-00000000000b', '2026-11-01', now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000000000b', '2026-12-01', now());
-- Agent suggestions (0078, D340-D343): every rule and every status, one window each.
INSERT INTO agent_suggestions (user_id, agent_id, rule, dedupe_key, evidence, change, status, decided_at) VALUES
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'idle_cash', 'seed-1:idle_cash',
   '{"scans": 10, "tradeScans": 0}', '{"setting": "cash_buffer_bps", "from": 2000, "to": 1000}', 'open', NULL),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'fee_drag', 'seed-1:fee_drag',
   '{"scans": 10, "feesMinor": 2250}', '{"setting": "max_decisions", "from": 2, "to": 1}', 'applied', now()),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'benchmark_lag', 'seed-1:benchmark_lag',
   '{"scans": 10, "differencePts": -6.5}', NULL, 'dismissed', now()),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'idle_cash', 'seed-0:idle_cash',
   '{"scans": 10, "tradeScans": 1}', NULL, 'superseded', now()),
  ('00000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'fee_drag', 'seed-0:fee_drag',
   '{"scans": 10, "feesMinor": 1500}', '{"setting": "scan_every_hours", "from": 1, "to": 2}', 'stale', now());
