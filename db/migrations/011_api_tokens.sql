-- Portal API tokens: let scripts and local AI agents (via the MCP server in
-- tools/mcp-server) call /api/v1 without an Authentik browser session.
-- Only a SHA-256 hash of each token is stored; the token itself is shown once.

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  all_agencies BOOLEAN NOT NULL DEFAULT false,
  agency_suffixes TEXT[] NOT NULL DEFAULT '{}',
  can_create_agencies BOOLEAN NOT NULL DEFAULT false,
  can_create_mutual_aid BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT
);

CREATE INDEX IF NOT EXISTS api_tokens_created_idx ON api_tokens (created_at DESC);
