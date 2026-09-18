-- ============================================================================
--  0093 — «لكيتها بمكان أرخص» : I FOUND IT CHEAPER SOMEWHERE ELSE.
-- ============================================================================
-- NONDESTRUCTIVE: one new table and two new indexes. Nothing existing is
-- touched, no column is dropped, no row is rewritten.
--
-- WHAT THIS IS FOR. A customer stands on a product page holding a screenshot
-- of the same machine, cheaper, from a shop on Instagram. Today the only place
-- to put that is a support ticket or a WhatsApp message, and it arrives as a
-- CONVERSATION — a thread the owner has to read, answer and then remember. The
-- owner did not ask for another conversation. They asked to know where their
-- prices are being beaten, which is a LIST: sortable, filterable, and
-- countable per product.
--
-- SO THIS IS NOT A SUPPORT TICKET, and it is deliberately not a row in
-- `support_tickets`. A ticket's lifecycle is "answer the customer"; this row's
-- lifecycle is "decide what to do about the price". Those are different
-- questions with different states, and merging them means the competitor
-- intelligence is buried inside the inbox that also carries «وين طلبيتي».
--
-- ---------------------------------------------------------------------------
--  THE COLUMN THIS TABLE EXISTS FOR: our_price_iqd
-- ---------------------------------------------------------------------------
-- `our_price_iqd` is OUR OWN price, frozen by the server at the instant the
-- report was filed, and it is NOT NULL because a report without it is not
-- evidence of anything.
--
-- «وجدتها بـ٥٠٠ ألف» is a complete sentence today and a meaningless one in six
-- months: prices move, and a row that stores only the competitor's figure
-- cannot answer the single question the owner will actually ask of it — "were
-- we more expensive, and by how much?". Recomputing the gap later against
-- `products.price_iqd` gives the gap against TODAY's price, which is not the
-- gap anybody reported. Worse, the product may since have been repriced
-- BECAUSE of this very report, so the table would erase its own effect.
--
-- It is written from the server's own read of `products.price_iqd` and never
-- from the request body. A client-supplied "our price" is a client-supplied
-- discount justification, and the first person to notice would send a report
-- claiming we charge ten times what we do.
--
-- ---------------------------------------------------------------------------
--  url IS TEXT, AND IT IS TEXT ON PURPOSE
-- ---------------------------------------------------------------------------
-- It holds a link a stranger typed. It is validated to be http(s) at the door
-- (worker/routes/priceReports.ts) and stored verbatim, and nothing on the
-- server ever FETCHES it: an admin panel that follows a customer-supplied URL
-- on render turns this table into an SSRF surface pointed at whatever the
-- Worker can reach, and turns every admin page view into a hit on a competitor
-- (or an attacker's) server from our IP. The admin reads it; a human decides
-- whether to open it.
--
-- ---------------------------------------------------------------------------
--  THE STATES
-- ---------------------------------------------------------------------------
--   'new'       nobody has looked at it yet — the owner's working queue.
--   'reviewed'  looked at, no action decided.
--   'actioned'  the price moved, or the shop answered the customer.
--   'rejected'  not comparable: a different model, a grey-market unit, a price
--               without the warranty we include, or simply untrue.
--
-- 'rejected' is a state and not a delete, because the same URL and the same
-- seller will come back, and "we already looked at this one" is worth keeping.
--
-- BOTH FOREIGN KEYS CASCADE. A deleted account takes its reports with it, and
-- a deleted product does too — a report is only ever read next to the product
-- it is about and the price we were charging for it. (`worker/lib/
-- productDeletion.ts` deletes it explicitly as well: nothing in this Worker
-- sets PRAGMA foreign_keys, so a declared cascade is a promise the runtime
-- never confirms.)
CREATE TABLE IF NOT EXISTS price_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_iqd INTEGER NOT NULL,
  our_price_iqd INTEGER NOT NULL,
  seller_name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','reviewed','actioned','rejected')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- THE OWNER'S QUEUE. The panel opens on «الجديدة» and sorts newest first, so
-- the default screen is a range scan over one state rather than a sort of
-- every report the shop has ever received. `state` leads for that reason.
CREATE INDEX IF NOT EXISTS idx_price_reports_state ON price_reports(state, created_at DESC);

-- THE OTHER QUESTION, asked from the product side: "how many people have told
-- us this one is overpriced?" Without this index that is a full scan per
-- product, on the table that grows fastest once the button is live.
CREATE INDEX IF NOT EXISTS idx_price_reports_product ON price_reports(product_id, created_at DESC);
