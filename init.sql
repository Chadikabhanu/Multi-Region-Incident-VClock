CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS incidents (
  id               UUID         PRIMARY KEY NOT NULL,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  status           VARCHAR(50)  NOT NULL DEFAULT 'OPEN',
  severity         VARCHAR(50)  NOT NULL,
  assigned_team    VARCHAR(100),
  vector_clock     JSONB        NOT NULL DEFAULT '{}',
  version_conflict BOOLEAN      NOT NULL DEFAULT false,
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_updated_at ON incidents(updated_at);
