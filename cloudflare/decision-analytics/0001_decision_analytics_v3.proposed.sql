-- UNEXECUTED PROPOSAL, anonymous stats DB only. Separate apply approval required.
-- v1/v2 were unpublished local drafts: no old data, ledger or migration is invented.
-- No actual producer tuple/config registration. Joint rows have no episode/event/user IDs.
CREATE TABLE decision_analytics_episodes (
  decision_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=created_at+86400000),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 7),
  producer_version TEXT NOT NULL CHECK(length(producer_version) BETWEEN 1 AND 64),
  producer_code_hash TEXT NOT NULL CHECK(length(producer_code_hash)=64 AND producer_code_hash NOT GLOB '*[^0-9a-f]*'),
  state_json TEXT NOT NULL CHECK(json_valid(state_json) AND length(CAST(state_json AS BLOB))<=8192),
  write_nonce TEXT NOT NULL
);
CREATE INDEX decision_analytics_episodes_expiry ON decision_analytics_episodes(expires_at,decision_id);
CREATE TABLE decision_analytics_dedupe (
  event_id TEXT PRIMARY KEY NOT NULL,
  first_received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=first_received_at+1209600000)
);
CREATE INDEX decision_analytics_dedupe_expiry ON decision_analytics_dedupe(expires_at,event_id);
CREATE TABLE decision_analytics_daily (
  day TEXT NOT NULL,
  producer_version TEXT NOT NULL CHECK(length(producer_version) BETWEEN 1 AND 64),
  producer_code_hash TEXT NOT NULL CHECK(length(producer_code_hash)=64 AND producer_code_hash NOT GLOB '*[^0-9a-f]*'),
  metric TEXT NOT NULL CHECK(metric IN('stage','holdings_blue','holdings_purple','holdings_yellow',
    'expected_supply_blue','expected_supply_purple','expected_supply_yellow','first_action','terminal',
    'joint_basis','joint_outcome','joint_attempt')),
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 9007199254740991),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(day,producer_version,producer_code_hash,metric,bucket),
  CHECK(
    (metric='stage' AND bucket IN('calculation','current_presented','wait_presented','first_action','outcome_confirmation','attempt_self_report','terminal')) OR
    (metric IN('holdings_blue','holdings_purple','holdings_yellow','expected_supply_blue','expected_supply_purple','expected_supply_yellow')
      AND bucket IN('zero','one_to_nine','ten_to_forty_nine','fifty_to_one_ninety_nine','two_hundred_plus')) OR
    (metric='first_action' AND bucket IN('input_edit','recalculate','outcome_open','outcome_confirm','reset','dismiss')) OR
    (metric='terminal' AND bucket IN('unknown','input_edit','new_solve','reset','restore','forecast_invalid','unmount','cancelled','superseded')) OR
    (metric='joint_basis' AND bucket IN(
      'use_blue|0|all','use_blue|0|current','use_blue|1|all','use_blue|1|current','use_blue|1|wait','use_blue|1|both',
      'use_purple|0|all','use_purple|0|current','use_purple|1|all','use_purple|1|current','use_purple|1|wait','use_purple|1|both',
      'use_yellow|0|all','use_yellow|0|current','use_yellow|1|all','use_yellow|1|current','use_yellow|1|wait','use_yellow|1|both',
      'preserve|0|all','preserve|0|current','preserve|1|all','preserve|1|current','preserve|1|wait','preserve|1|both',
      'none|0|all','none|1|all','none|1|wait')) OR
    (metric='joint_outcome' AND bucket IN(
      'use_blue|0|all|success','use_blue|0|all|fail','use_blue|0|current|success','use_blue|0|current|fail',
      'use_blue|1|all|success','use_blue|1|all|fail','use_blue|1|current|success','use_blue|1|current|fail',
      'use_blue|1|wait|success','use_blue|1|wait|fail','use_blue|1|both|success','use_blue|1|both|fail',
      'use_purple|0|all|success','use_purple|0|all|fail','use_purple|0|current|success','use_purple|0|current|fail',
      'use_purple|1|all|success','use_purple|1|all|fail','use_purple|1|current|success','use_purple|1|current|fail',
      'use_purple|1|wait|success','use_purple|1|wait|fail','use_purple|1|both|success','use_purple|1|both|fail',
      'use_yellow|0|all|success','use_yellow|0|all|fail','use_yellow|0|current|success','use_yellow|0|current|fail',
      'use_yellow|1|all|success','use_yellow|1|all|fail','use_yellow|1|current|success','use_yellow|1|current|fail',
      'use_yellow|1|wait|success','use_yellow|1|wait|fail','use_yellow|1|both|success','use_yellow|1|both|fail')) OR
    (metric='joint_attempt' AND bucket IN(
      'use_blue|0|one','use_blue|0|two_to_four','use_blue|0|five_to_nine','use_blue|0|ten_plus',
      'use_blue|1|one','use_blue|1|two_to_four','use_blue|1|five_to_nine','use_blue|1|ten_plus',
      'use_purple|0|one','use_purple|0|two_to_four','use_purple|0|five_to_nine','use_purple|0|ten_plus',
      'use_purple|1|one','use_purple|1|two_to_four','use_purple|1|five_to_nine','use_purple|1|ten_plus',
      'use_yellow|0|one','use_yellow|0|two_to_four','use_yellow|0|five_to_nine','use_yellow|0|ten_plus',
      'use_yellow|1|one','use_yellow|1|two_to_four','use_yellow|1|five_to_nine','use_yellow|1|ten_plus'))
  )
);
CREATE INDEX decision_analytics_daily_expiry ON decision_analytics_daily(expires_at,day,producer_version,producer_code_hash,metric,bucket);
CREATE TABLE decision_analytics_budget (
  day TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts>=1),
  expires_at INTEGER NOT NULL
);
CREATE INDEX decision_analytics_budget_expiry ON decision_analytics_budget(expires_at,day);
CREATE TABLE decision_analytics_maintenance (singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_success_ms INTEGER);
INSERT INTO decision_analytics_maintenance(singleton,last_success_ms) VALUES(1,NULL);
