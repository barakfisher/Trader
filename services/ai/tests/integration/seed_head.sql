-- Rows at head, one for every value a CHECK constraint enumerates.
--
-- The migration round trip steps down to base over these rows and back up.
-- CI's other jobs migrate an empty database, which proves only that the SQL
-- parses: a constraint is exercised by data, and the downgrades that broke
-- (0006 retyping `runs_kind_check`, 0021 relabelling over a live CHECK) broke
-- only with a row present. `test_migrations.py` reads every enumerated value
-- from `pg_constraint` and fails if one is missing here, so a migration that
-- adds a value cannot pass CI until a row carries it through the downgrade.

-- Three users because settings are one row per user and each severity column
-- enumerates three values; one of them is the admin role.
INSERT INTO users (id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'user'),
  ('00000000-0000-0000-0000-00000000000c', 'user');
INSERT INTO user_settings (user_id, proposal_severity, notify_severity, quiet_hours_start, quiet_hours_end) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'notable', 'info', '22:00', '07:00'),
  ('00000000-0000-0000-0000-00000000000b', 'high', 'notable', NULL, NULL),
  ('00000000-0000-0000-0000-00000000000c', 'info', 'high', NULL, NULL);

INSERT INTO instruments (id, symbol, asset_class) VALUES
  ('10000000-0000-0000-0000-000000000001', 'EQTY', 'equity'),
  ('10000000-0000-0000-0000-000000000002', 'FUND', 'etf'),
  ('10000000-0000-0000-0000-000000000003', 'COIN-USD', 'crypto'),
  ('10000000-0000-0000-0000-000000000004', 'EURUSD=X', 'fx'),
  ('10000000-0000-0000-0000-000000000005', '^IDX', 'index'),
  ('10000000-0000-0000-0000-000000000006', 'MYST', 'unknown');

INSERT INTO holdings (user_id, instrument_id, quantity)
VALUES ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1.5');
INSERT INTO target_weights (user_id, instrument_id, weight)
VALUES ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '0.5');
INSERT INTO quotes (instrument_id, as_of, price_minor, currency, source)
VALUES ('10000000-0000-0000-0000-000000000001', '2026-09-01T20:00:00Z', 12345, 'USD', 'fixture');
INSERT INTO portfolio_snapshots (user_id, as_of, total_minor, currency)
VALUES ('00000000-0000-0000-0000-00000000000a', '2026-09-01', 18517, 'USD');

INSERT INTO runs (id, kind, run_key, status)
SELECT ('20000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, kind, 'seed:' || kind || ':' || status, status
  FROM unnest(
         ARRAY['snapshot','portfolio_scan','topic_scan','daily_digest','backfill','proposal_sweep',
               'instrument_metadata','news_collect','topic_discovery'],
         ARRAY['running','ok','degraded','failed','skipped','ok','ok','ok','ok']
       ) WITH ORDINALITY AS t(kind, status, n);

INSERT INTO observations (id, user_id, run_id, kind, severity, subject_kind, subject_ref, headline, dedupe_key, narration_source, fallback_reason) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000002',
   'price_move', 'info', 'instrument', 'instrument:EQTY', 'EQTY moved', 'seed-obs-1', 'llm', 'none'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000002',
   'allocation_drift', 'notable', 'portfolio', 'portfolio', 'EQTY drifted', 'seed-obs-2', 'template', 'unsourced_figures'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000003',
   'topic_move', 'high', 'topic', 'topic:40000000-0000-0000-0000-000000000001', 'uranium moved', 'seed-obs-3', NULL, NULL);

INSERT INTO proposals (id, user_id, observation_id, kind, state, expires_at, decided_via, decided_at) VALUES
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000001', 'rebalance', 'pending',  '2026-09-02T00:00:00Z', NULL, NULL),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000002', 'rebalance', 'approved', '2026-09-02T00:00:00Z', 'web', '2026-09-01T12:00:00Z'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000003', 'rebalance', 'rejected', '2026-09-02T00:00:00Z', 'telegram', '2026-09-01T12:00:00Z');
-- The remaining states, each needing its own observation (one proposal per observation).
INSERT INTO observations (id, user_id, kind, headline, dedupe_key)
SELECT ('30000000-0000-0000-0000-00000000001' || n)::uuid, '00000000-0000-0000-0000-00000000000a', 'allocation_drift', 'drift', 'seed-obs-1' || n
  FROM generate_series(1, 2) AS n;
INSERT INTO proposals (id, user_id, observation_id, kind, state, expires_at, snoozed_until, decided_via, decided_at) VALUES
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000011', 'rebalance', 'snoozed', '2026-09-02T00:00:00Z', '2026-09-01T18:00:00Z', NULL, NULL),
  ('50000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-000000000012', 'rebalance', 'expired', '2026-09-02T00:00:00Z', NULL, 'system', '2026-09-02T00:00:00Z');
INSERT INTO proposal_transitions (proposal_id, user_id, from_state, to_state, surface) VALUES
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'pending', 'approved', 'web'),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'pending', 'rejected', 'telegram'),
  ('50000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'pending', 'expired', 'system');
INSERT INTO intents (user_id, proposal_id, kind, revoked_at, revoked_via) VALUES
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', '2026-09-01T13:00:00Z', 'web'),
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', '2026-09-01T14:00:00Z', 'telegram'),
  ('00000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-000000000002', 'rebalance', NULL, NULL);

INSERT INTO narration_transitions (id, user_id, from_state, to_state) VALUES
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', NULL, 'off'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'off', 'narrating'),
  ('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'narrating', 'unavailable'),
  ('60000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'unavailable', 'exhausted'),
  ('60000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'exhausted', 'rejected'),
  ('60000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-00000000000a', 'rejected', 'narrating');

INSERT INTO notifications (user_id, channel, ref_kind, ref_id, route, reason, status, sent_at, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'telegram', 'observation', '30000000-0000-0000-0000-000000000001', 'push',      'above_floor', 'sent',       '2026-09-01T12:00:00Z', 'seed-n-1'),
  ('00000000-0000-0000-0000-00000000000a', 'digest',   'proposal',    '50000000-0000-0000-0000-000000000001', 'digest',    'quiet_hours', 'pending',    NULL, 'seed-n-2'),
  ('00000000-0000-0000-0000-00000000000a', 'telegram', 'narration',   '60000000-0000-0000-0000-000000000003', 'push',      'above_floor', 'failed',     NULL, 'seed-n-3'),
  ('00000000-0000-0000-0000-00000000000a', 'digest',   'observation', '30000000-0000-0000-0000-000000000002', 'feed_only', 'below_floor', 'suppressed', NULL, 'seed-n-4'),
  ('00000000-0000-0000-0000-00000000000a', 'digest',   'narration',   '60000000-0000-0000-0000-000000000002', 'digest',    'muted',       'pending',    NULL, 'seed-n-5');

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
