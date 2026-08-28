-- Levonis migration 0012 — LEVO Studio sign-in handoff (STUDIO_PLAN decision 3).
--
-- Single-use handoff codes minted by the MAIN worker for the session-authed
-- user and redeemed server-to-server by the Studio worker:
--   * only the SHA-256 digest of the code is stored (a DB leak exposes no
--     usable code — same policy as sessions/password_reset_tokens),
--   * dest pins the exact allowed destination origin the code was minted
--     for; redemption re-checks it so a code can never be replayed against
--     another destination,
--   * state echoes the CSRF/state nonce the Studio host generated (it also
--     travels in the redirect URL; stored for diagnostics/auditing only —
--     verification happens on the Studio host against its own cookie),
--   * expires_at is minted ≤ 60 seconds ahead; consumed_at implements
--     atomic single-use consumption (conditional UPDATE — replays fail).
-- NONDESTRUCTIVE: new table only; no existing data is touched.

CREATE TABLE studio_handoff_codes (
  code_hash TEXT PRIMARY KEY,               -- SHA-256 hex of the raw code
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dest TEXT NOT NULL,                       -- exact origin, e.g. https://studio.levonis-iq.com
  state TEXT NOT NULL DEFAULT '',           -- studio-generated state nonce (not a secret)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,                 -- ISO-8601; minted ≤ 60s in the future
  consumed_at TEXT                          -- set exactly once by the redeeming UPDATE
);

CREATE INDEX idx_studio_handoff_user ON studio_handoff_codes(user_id);
CREATE INDEX idx_studio_handoff_expires ON studio_handoff_codes(expires_at);
