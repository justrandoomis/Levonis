-- ============================================================================
--  0092 — «خبرني لما يرجع» : TELL ME WHEN IT COMES BACK.
-- ============================================================================
-- NONDESTRUCTIVE: two new tables and three new indexes. Nothing existing is
-- touched, no column is dropped, no row is rewritten.
--
-- WHAT THIS IS FOR. A customer opens a product, finds the colour they want at
-- zero, and leaves. Today the shop learns nothing and the customer learns
-- nothing — the restock happens, the units sell to whoever happens to be
-- looking that hour, and the person who actually wanted it never hears. An
-- alert row is that person's standing request, and the sweep
-- (worker/lib/stockAlerts.ts) is what answers it.
--
-- AN ALERT NAMES A TARGET, NOT A PRODUCT. The four `kind` values are the four
-- things a customer can actually be waiting for in this catalogue, and they
-- are not interchangeable:
--
--   'product'      the whole product, whatever its models and colours do.
--   'option_value' one model — "the Combo", not "the A1".
--   'color'        one colour, across every model that offers it.
--   'combination'  one model IN one colour, which is the row a customer who
--                  said «A1 كومبو أسود» actually meant.
--
-- `kind` is stored rather than inferred from which of the two id columns is
-- filled, because the two are not the same question: an alert on the product
-- as a whole and an alert on a product with exactly one model both leave
-- option_value_id empty, and only the stored kind says which the customer
-- asked for.
--
-- ------------------------------------------------- WHY '' AND NEVER NULL
--
-- option_value_id and color_id are NOT NULL DEFAULT '' — an empty string means
-- "this alert does not name one". They are NOT nullable, and that is the whole
-- design of the uniqueness guarantee below. Three separate reasons, each of
-- which on its own is enough:
--
--  1. NULL IS NOT EQUAL TO NULL IN A UNIQUE INDEX. SQLite (like the standard)
--     treats every NULL as distinct, so a unique index over nullable columns
--     does not constrain the rows that matter most here: a product-level alert
--     would leave both id columns NULL and therefore collide with NOTHING. One
--     customer tapping «خبرني» five times would get five armed rows on the same
--     product and five messages when it restocks. The guarantee "one alert per
--     customer per target" only exists if the target columns can never be NULL.
--
--  2. SQLITE REFUSES AN EXPRESSION IN A TABLE-LEVEL UNIQUE CONSTRAINT. The
--     obvious repair for (1) — UNIQUE (user_id, product_id, kind,
--     COALESCE(option_value_id,''), COALESCE(color_id,'')) — is not valid
--     syntax: a UNIQUE constraint inside CREATE TABLE takes column names only.
--     The migration would fail to apply, which on this project means a failed
--     deploy on a live shop.
--
--  3. AN EXPRESSION INDEX MOVES THE COST ONTO EVERY UPSERT, FOREVER. The other
--     repair — CREATE UNIQUE INDEX ... ON t(user_id, product_id, kind,
--     COALESCE(option_value_id,''), COALESCE(color_id,'')) — is legal, and then
--     SQLite matches an UPSERT to it only if the ON CONFLICT target repeats the
--     expressions VERBATIM. Every arm/re-arm statement in the codebase would
--     have to carry that exact text, and the first one written as
--     ON CONFLICT(user_id, product_id, kind, option_value_id, color_id) does
--     not match the index at all. This is the failure mode 0082/0083 already
--     paid for once, on `idx_cart_levonis_line`: a conflict target that names
--     an index that is not there does not quietly do the right thing.
--
-- Plain columns with a sentinel make the index plain, the conflict target
-- plain, and the uniqueness real.
--
-- ------------------------------------------- AND THEREFORE NO FOREIGN KEY
--
-- option_value_id and color_id carry NO REFERENCES clause, which is deliberate
-- and is a direct consequence of the sentinel: '' is not a row in
-- product_option_values or product_colors, so a foreign key would be violated
-- by every single product-level alert ever written.
--
-- It is also the behaviour we want. ON DELETE CASCADE would make a customer's
-- alert disappear the moment the owner reorganised the models, silently, with
-- the customer still believing they are being watched for. NO ACTION would do
-- the opposite and refuse the owner's edit. Neither is right: the sweep
-- RECONCILES a vanished target instead, marking the row dead with
-- `dead_reason` = 'TARGET_REMOVED' (see worker/lib/stockAlertResolve.ts), so
-- the customer is told the thing they were waiting for no longer exists rather
-- than waiting for a message that can never come.
--
-- product_id and user_id DO cascade: an alert has no meaning at all without
-- either, and `product_stock_alerts` is registered in OWNED_TABLES in
-- worker/lib/productDeletion.ts so the delete is explicit as well — nothing in
-- this Worker sets PRAGMA foreign_keys, so a declared cascade is a promise the
-- runtime never confirms.
--
-- ------------------------------------------------------------ THE STATE
--
-- `state` is the lifecycle the sweep drives ('armed' -> 'firing' -> 'notified',
-- or -> 'cancelled' by the customer, or -> 'dead' when the target cannot come
-- back). `arm_seq` counts how many times this same row has been re-armed, so a
-- customer who arms, is notified, misses the units and arms again is one row
-- with a history rather than a pile of rows. `last_available` is nullable on
-- purpose and means something the others cannot: "we have never successfully
-- read a quantity for this target", which is not the same as zero.
--
-- The remaining TEXT columns are '' rather than NULL for the ordinary reason
-- this schema does it everywhere: a timestamp column that is sometimes NULL
-- and sometimes '' is two empty values to test for at every read.

CREATE TABLE IF NOT EXISTS product_stock_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product','option_value','color','combination')),
  option_value_id TEXT NOT NULL DEFAULT '',
  color_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'armed' CHECK (state IN ('armed','firing','notified','cancelled','dead')),
  arm_seq INTEGER NOT NULL DEFAULT 1,
  last_available INTEGER,
  last_buyable INTEGER NOT NULL DEFAULT 0,
  armed_channel TEXT NOT NULL DEFAULT '',
  armed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_checked_at TEXT NOT NULL DEFAULT '',
  notified_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  dead_reason TEXT NOT NULL DEFAULT ''
);

-- ONE ALERT PER CUSTOMER PER TARGET, and it is the sentinel above that makes
-- this sentence true rather than approximately true. Five plain columns, so the
-- upsert that arms an alert names them plainly:
--   ON CONFLICT(user_id, product_id, kind, option_value_id, color_id)
-- No COALESCE, nothing to repeat verbatim, nothing to get wrong. Re-arming is
-- an UPDATE of the existing row (state back to 'armed', arm_seq + 1), which is
-- also what keeps the customer's original armed_at meaningful.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_alerts_target ON product_stock_alerts(user_id, product_id, kind, option_value_id, color_id);

-- THE SWEEP'S OWN INDEX, and the reason it can run often. The sweep asks one
-- question — "which products have anybody waiting on them?" — and a partial
-- index answers it without reading the notified, cancelled and dead rows, which
-- are the ones that accumulate forever. A shop with 50,000 historical alerts
-- and 40 live ones scans 40.
CREATE INDEX IF NOT EXISTS idx_stock_alerts_armed ON product_stock_alerts(product_id) WHERE state IN ('armed','firing');

-- THE CUSTOMER'S OWN LIST, newest first, which is how «تنبيهاتي» is drawn.
-- state leads product-side of armed_at so the screen's default filter (live
-- alerts) is a range scan rather than a sort of everything the person ever
-- armed.
CREATE INDEX IF NOT EXISTS idx_stock_alerts_user ON product_stock_alerts(user_id, state, armed_at DESC);

-- ---------------------------------------------------------------------------
--  WHERE TO SEND IT
-- ---------------------------------------------------------------------------
-- A restock message is worth nothing if it lands somewhere the customer does
-- not look. This table is the per-user answer to "which channels are on, and
-- which one is the one you actually want" — read by
-- worker/lib/channelReadiness.ts, which pairs each stored row with whether that
-- channel is CONFIGURED on this deployment and whether this account has a
-- usable destination on it.
--
-- IT IS PREFERENCE ONLY, NEVER CAPABILITY. Whether Telegram is linked lives on
-- the user row and whether WhatsApp is configured lives in the environment;
-- storing either here would be a second copy of a fact that changes without
-- this table being told, which is how a shop ends up "sending" to a channel it
-- cannot reach.
--
-- 'inapp' is in the CHECK list and is not optional in practice: it is the one
-- channel that always works, so a customer with nothing linked still finds the
-- message when they next open the site. `is_primary` is a flag rather than a
-- single column on `users` because the primary must be one of the rows that
-- exist here — see setPrimaryChannelStatements(), which clears the others in
-- the same batch that sets one.
--
-- PRIMARY KEY (user_id, channel) is the whole uniqueness story: one row per
-- user per channel, no sentinel needed, because both parts are real values.
CREATE TABLE IF NOT EXISTS user_notification_channels (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('inapp','telegram','whatsapp','email')),
  enabled INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, channel)
);
