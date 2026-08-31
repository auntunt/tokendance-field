PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS industry (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  upstream TEXT NOT NULL DEFAULT '',
  downstream TEXT NOT NULL DEFAULT '',
  kpis TEXT NOT NULL DEFAULT '',
  regulators TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  industry_id TEXT REFERENCES industry(id),
  controller TEXT NOT NULL DEFAULT '',
  listing TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS industry_term (
  id TEXT PRIMARY KEY NOT NULL,
  industry_id TEXT NOT NULL REFERENCES industry(id),
  term TEXT NOT NULL,
  plain_meaning TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  UNIQUE (industry_id, term)
);

CREATE TABLE IF NOT EXISTS person (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  stance TEXT NOT NULL DEFAULT 'unknown'
    CHECK (stance IN ('decider', 'influencer', 'user', 'blocker', 'unknown'))
);

CREATE TABLE IF NOT EXISTS position (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  person_id TEXT NOT NULL REFERENCES person(id),
  title TEXT NOT NULL,
  owns TEXT NOT NULL DEFAULT '',
  start TEXT,
  end TEXT
);

CREATE TABLE IF NOT EXISTS org_unit (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES org_unit(id),
  head_person_id TEXT REFERENCES person(id),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS business_line (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  name TEXT NOT NULL,
  revenue_share REAL,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS process_step (
  id TEXT PRIMARY KEY NOT NULL,
  business_line_id TEXT NOT NULL REFERENCES business_line(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  owner_org_unit TEXT NOT NULL DEFAULT '',
  pain_point TEXT NOT NULL DEFAULT '',
  UNIQUE (business_line_id, seq)
);

CREATE TABLE IF NOT EXISTS system_in_use (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  category TEXT NOT NULL,
  product TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  covers_process_step TEXT NOT NULL DEFAULT '',
  since TEXT,
  UNIQUE (company_id, category, product)
);

CREATE TABLE IF NOT EXISTS relationship (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  counterparty TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('customer', 'supplier', 'it_vendor', 'competitor', 'investor')),
  amount TEXT NOT NULL DEFAULT '',
  period_start TEXT,
  period_end TEXT
);

CREATE TABLE IF NOT EXISTS financial_snapshot (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  year INTEGER NOT NULL,
  revenue REAL,
  net_profit REAL,
  rnd_expense REAL,
  it_capex REAL,
  fundraising_projects TEXT NOT NULL DEFAULT '',
  UNIQUE (company_id, year)
);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('hire', 'leave', 'procurement', 'pilot', 'statement', 'strategy', 'lawsuit')),
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_posting (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  org_unit TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  tech_keywords TEXT NOT NULL DEFAULT '',
  system_keywords TEXT NOT NULL DEFAULT '',
  posted_at TEXT NOT NULL,
  UNIQUE (company_id, title, posted_at)
);

CREATE TABLE IF NOT EXISTS opportunity (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  process_step_id TEXT NOT NULL REFERENCES process_step(id),
  pain_point TEXT NOT NULL,
  ai_scenario TEXT NOT NULL,
  data_prerequisite TEXT NOT NULL,
  owner_org_unit TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'mid', 'low'))
);

CREATE TABLE IF NOT EXISTS dossier_run (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT NOT NULL REFERENCES company(id),
  ran_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS industry_update (
  id TEXT PRIMARY KEY NOT NULL,
  industry_id TEXT NOT NULL REFERENCES industry(id),
  found_at TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('peer_case', 'procurement', 'policy', 'vendor_move', 'target_action')),
  company_id TEXT REFERENCES company(id),
  summary TEXT NOT NULL,
  promoted_to_event_id TEXT REFERENCES event(id),
  promoted_at TEXT
);

CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('filing', 'official', 'third_party')),
  published_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  page_or_excerpt TEXT NOT NULL,
  UNIQUE (url, fingerprint)
);

CREATE TABLE IF NOT EXISTS fact (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  "table" TEXT NOT NULL,
  row_id TEXT NOT NULL,
  field TEXT NOT NULL,
  UNIQUE (source_id, "table", row_id, field)
);

CREATE INDEX IF NOT EXISTS position_company_idx ON position(company_id);
CREATE INDEX IF NOT EXISTS org_unit_company_idx ON org_unit(company_id);
CREATE INDEX IF NOT EXISTS business_line_company_idx ON business_line(company_id);
CREATE INDEX IF NOT EXISTS process_step_business_idx ON process_step(business_line_id);
CREATE INDEX IF NOT EXISTS system_company_idx ON system_in_use(company_id);
CREATE INDEX IF NOT EXISTS relationship_company_idx ON relationship(company_id);
CREATE INDEX IF NOT EXISTS financial_company_idx ON financial_snapshot(company_id);
CREATE INDEX IF NOT EXISTS event_company_idx ON event(company_id);
CREATE INDEX IF NOT EXISTS job_company_idx ON job_posting(company_id);
CREATE INDEX IF NOT EXISTS opportunity_company_idx ON opportunity(company_id);
CREATE INDEX IF NOT EXISTS dossier_run_company_idx ON dossier_run(company_id);
CREATE INDEX IF NOT EXISTS update_industry_idx ON industry_update(industry_id, found_at);
CREATE INDEX IF NOT EXISTS fact_row_idx ON fact("table", row_id);
