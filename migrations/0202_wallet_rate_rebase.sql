-- 0202 — THE WALLET MOVES TO THE ONE OFFICIAL RATE WITHOUT A DINAR CHANGING
-- (the owner's decision of 2026-10-18, DECISIONS row 252)
--
-- «keep the existing balances' value in dinars». Wallet money is stored in US cents and was credited
-- at the legacy rate (the `exchangeRate` setting, 1,400); read at the applied rate U (~1,680) every
-- balance would grow by U / 1,400 in dinars. The ONE-TIME rebase (worker/lib/fx/walletRateRebase.ts)
-- rescales each wallet's cents by legacy / U in ONE batch, writes one audit row per wallet below, and
-- writes the marker row in the same batch (first, so a second run aborts on its key). Until the marker exists the wallet keeps converting at
-- the legacy rate (worker/lib/fx/officialRate.ts), so deploying changes nothing until the rebase runs.
--
-- ADDITIVE: two new tables and one conditional INSERT into the first. Nothing existing is touched.
CREATE TABLE IF NOT EXISTS wallet_rate_rebase (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- NULL on both when the database held no wallet money when this file applied: nothing to rebase.
  legacy_rate INTEGER CHECK (legacy_rate IS NULL OR legacy_rate > 0),
  official_rate INTEGER CHECK (official_rate IS NULL OR official_rate > 0),
  wallets INTEGER NOT NULL DEFAULT 0 CHECK (wallets >= 0),
  rebased_at TEXT NOT NULL
);

-- One row per wallet the rebase touched: what it held before, what it holds after, at which rates.
CREATE TABLE IF NOT EXISTS wallet_rate_rebase_entries (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT 'RATE_REBASE',
  legacy_rate INTEGER NOT NULL CHECK (legacy_rate > 0),
  official_rate INTEGER NOT NULL CHECK (official_rate > 0),
  settled_cents_before INTEGER NOT NULL,
  held_cents_before INTEGER NOT NULL,
  available_cents_before INTEGER NOT NULL,
  settled_dust_iqd_before INTEGER NOT NULL,
  available_iqd_before INTEGER NOT NULL,
  pending_deposit_cents_before INTEGER NOT NULL DEFAULT 0,
  available_cents_after INTEGER,
  settled_cents_after INTEGER,
  held_cents_after INTEGER,
  open_amount_iqd INTEGER,
  available_iqd_after INTEGER,
  close_tx_id TEXT,
  open_tx_id TEXT,
  created_at TEXT NOT NULL
);

-- A database with no wallet money at all (a fresh shop, a test database) has nothing whose dinars could
-- move: it is born on the official rate. Any database that holds wallet money waits for the rebase.
INSERT OR IGNORE INTO wallet_rate_rebase (id, legacy_rate, official_rate, wallets, rebased_at)
SELECT 1, NULL, NULL, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE currency = 'USD')
   AND NOT EXISTS (SELECT 1 FROM wallet_holds);
